import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { LuArrowRight, LuArrowUp, LuCheck, LuChevronDown, LuChevronLeft, LuChevronRight, LuCircleAlert, LuEye, LuFileText, LuFolder, LuGitBranch, LuGitFork, LuListChecks, LuLoaderCircle, LuPaperclip, LuPlus, LuPuzzle, LuRotateCw, LuSearch, LuShield, LuShieldCheck, LuSparkles, LuSquare, LuTarget, LuWandSparkles, LuX } from "react-icons/lu";
import { effortLabel, isEffortValid } from "../effort";
import {
  api,
  installMarketplaceItem,
  listPlugins,
  listSkills,
  polishPrompt,
  type CacheDiagnostics,
  type ContextUsage,
  type InstalledSkill,
  type MarketplaceEntry,
  type PlanState,
  type PluginsOverview,
  type ProviderSettings,
  type AgentProfileId,
  type HarnessArchitectureSummary,
  type QueuedPrompt,
  type SessionChangeSummary,
  type SessionMode,
} from "../api";
import { agentProfileDisplay } from "../agentProfiles";
import { Toggle } from "./ui/Toggle";
import { BranchMenu } from "./BranchMenu";
import { invalidateMarketplaceCatalog, loadMarketplaceCatalog } from "../data/marketplaceCatalog";
import {
  buildMentionItems,
  detectMention,
  mentionDirToken,
  mentionScopeOf,
  mentionToken,
  parentDir,
  type MentionEntry,
  type MentionItem,
  type MentionState,
} from "../mention-path";
import { baseName } from "../util";
import { ContextMeter } from "./ContextMeter";
import { ContextPopover } from "./ContextPopover";
import { AgentProfilePopover } from "./AgentProfilePopover";
import { ModelPopover, levelsFor } from "./ModelPopover";
import { findTemplate } from "../data/providerCatalog";
import { ProviderIcon } from "./ui/ProviderIcon";
import { SessionProgressPill } from "./SessionProgressPill";
import { queuedPreview } from "../user-references";
import "./Composer.css";

/** 工具审批模式（与后端 /session/permissions 对齐）。 */
export type PermissionMode = "read-only" | "ask" | "auto" | "full";

/** 输入框里已引用的技能 / 插件 / 插件命令 / 附件 chip（可同时挂多个技能与插件） */
export type ComposerChip =
  | { kind: "skill"; id: string; name: string; iconUrl?: string }
  | { kind: "plugin"; id: string; name: string; iconUrl?: string }
  | { kind: "command"; id: string; name: string; command: string; iconUrl?: string }
  /**
   * 附件：绝对路径，**不限工作区**。`id` 就是归一后的绝对路径（去重/删除键），
   * `name` 只用于展示。内容由运行时按路径注入，不写进输入框正文。
   */
  | { kind: "file"; id: string; name: string; path: string };

/** 输入框里待发送的图片（dataUrl 供缩略图预览，data 是不带前缀的 base64）。 */
export type ComposerImage = {
  id: string;
  mimeType: string;
  data: string;
  dataUrl: string;
  name?: string;
  /** 拖入/选择的原始文件路径；剪贴板图片没有来源路径 */
  path?: string;
};

/** 与后端 /session/prompt 的 images 字段对齐：最多 3 张，单张 base64 不超过 2.6MB。 */
const MAX_COMPOSER_IMAGES = 3;
const MAX_IMAGE_BASE64 = 2_600_000;
const MAX_IMAGE_EDGE = 2048;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function readAsDataUrl(file: File, t: TFunction): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(t("image.readFailed")));
    reader.readAsDataURL(file);
  });
}

function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : "";
}

/**
 * 本地绝对路径归一：统一 `/` 分隔（Windows 上大小写不敏感，比较时用 lower）。
 * 附件 chip 的 id 直接用它，保证同一文件重复拖入只留一张卡片。
 */
function normalizeFilePath(target: string): string {
  return target.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** 绝对路径 → 展示名（取最后一段；交给 chip 的 name 通常由 File 提供，这里兜底） */
function baseNameOf(target: string): string {
  const normalized = normalizeFilePath(target);
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

/**
 * 把用户选的/粘贴的图片压到可直接发给服务商的大小：
 * 长边超过 2048 或体积超限时按比例缩放（PNG 保持无损，其余转 JPEG）；
 * 缩完仍超限就继续降边长（×0.75，最多 4 轮，PNG 第二轮起转 JPEG 换体积），
 * 全部尝试都失败才报错，而不是一上来就拒收。
 */
async function prepareImage(file: File, t: TFunction): Promise<ComposerImage | string> {
  if (!IMAGE_TYPES.has(file.type)) {
    return t("image.unsupported", { type: file.type || file.name });
  }
  // 拖入/从磁盘选择时有原始路径；剪贴板图片拿不到
  const sourcePath = window.meow.getFilePath?.(file)?.trim() || undefined;
  const original = await readAsDataUrl(file, t);
  let dataUrl = original;
  let mimeType = file.type;
  let scale = 1;

  if (file.type !== "image/gif") {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (bitmap) {
      const edge = Math.max(bitmap.width, bitmap.height);
      scale = Math.min(1, MAX_IMAGE_EDGE / edge);
      let asPng = file.type === "image/png";
      let quality = 0.92;
      const encode = (ratio: number, png: boolean, q: number) => {
        const width = Math.max(1, Math.round(bitmap.width * ratio));
        const height = Math.max(1, Math.round(bitmap.height * ratio));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0, width, height);
        return canvas.toDataURL(png ? "image/png" : "image/jpeg", q);
      };

      const oversize = scale < 1 || base64Of(original).length > MAX_IMAGE_BASE64;
      if (oversize) {
        dataUrl = encode(scale, asPng, quality) ?? original;
        // 截图类（PNG）保留文字锐度；照片类直接转 JPEG 换体积
        if (file.type !== "image/png") asPng = false;
        // 仍超限就继续降：边长 ×0.75，JPEG 逐轮降质量
        for (let attempt = 0; attempt < 4 && base64Of(dataUrl).length > MAX_IMAGE_BASE64; attempt += 1) {
          scale *= 0.75;
          if (!asPng) quality = Math.max(0.6, quality - 0.1);
          const next = encode(scale, asPng, quality);
          if (!next) break;
          dataUrl = next;
          // PNG 缩不动（照片类内容）：从第二轮起转 JPEG
          if (asPng && attempt >= 1 && base64Of(dataUrl).length > MAX_IMAGE_BASE64) {
            asPng = false;
            const jpeg = encode(scale, false, 0.82);
            if (jpeg) dataUrl = jpeg;
          }
        }
      }
      // 编码类型跟随实际结果（PNG 转 JPEG 后 MIME 也要跟着变）
      mimeType = dataUrl.startsWith("data:image/jpeg") ? "image/jpeg" : dataUrl.startsWith("data:image/png") ? "image/png" : mimeType;
      bitmap.close();
    }
  }

  const data = base64Of(dataUrl);
  if (!data || data.length > MAX_IMAGE_BASE64) {
    return t("image.tooLarge", { name: file.name || t("image.fallbackName") });
  }
  return {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mimeType,
    data,
    dataUrl,
    name: file.name,
    ...(sourcePath ? { path: sourcePath } : {}),
  };
}

/** 表里只存 key：标签在组件内查表，切语言才会跟着刷新。 */
const PERMISSION_OPTIONS: Array<{ value: PermissionMode; labelKey: string; descKey: string }> = [
  { value: "read-only", labelKey: "permission.readOnly.label", descKey: "permission.readOnly.desc" },
  { value: "ask", labelKey: "permission.ask.label", descKey: "permission.ask.desc" },
  {
    value: "auto",
    labelKey: "permission.auto.label",
    descKey: "permission.auto.desc",
  },
  { value: "full", labelKey: "permission.full.label", descKey: "permission.full.desc" },
];

const PERMISSION_LABEL_KEYS: Record<PermissionMode, string> = {
  "read-only": "permission.readOnly.label",
  ask: "permission.ask.label",
  auto: "permission.auto.label",
  full: "permission.full.label",
};

/** 输入 `/` 时弹出的命令列表（选中即执行，带文字的命令交给 trySlashCommand 发送） */
const SLASH_COMMANDS: Array<{
  mode: Exclude<SessionMode, "default">;
  command: string;
  labelKey: string;
  descKey: string;
}> = [
  {
    mode: "plan",
    command: "/plan",
    labelKey: "slash.plan.label",
    descKey: "slash.plan.desc",
  },
  {
    mode: "goal",
    command: "/goal",
    labelKey: "slash.goal.label",
    descKey: "slash.goal.desc",
  },
];

/** 会话模式菜单项与徽章文案（plan / goal 两种）。 */
const MODE_LABEL_KEYS: Record<Exclude<SessionMode, "default">, string> = {
  plan: "mode.plan",
  goal: "mode.goal",
};

function permissionIcon(mode: PermissionMode) {
  if (mode === "full") return <LuCircleAlert size={13} />;
  if (mode === "read-only") return <LuEye size={13} />;
  if (mode === "auto") return <LuShieldCheck size={13} />;
  return <LuShield size={13} />;
}

/**
 * 项目切换菜单（输入框上方项目标签点开）：搜索 + 项目列表（当前项打勾）+ 新建项目。
 */
function ProjectMenu({
  projects,
  projectNames,
  active,
  onPick,
  onRemove,
  onNew,
  onClose,
}: {
  projects: string[];
  projectNames: Record<string, string>;
  active: string;
  onPick: (cwd: string) => void;
  /** 从列表移除（只隐藏，聊天记录与磁盘文件都不动） */
  onRemove: (cwd: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useTranslation("composer");

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      // 标签按钮自身交给它切换开关
      if ((event.target as HTMLElement).closest?.(".mc-composer__context")) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const display = (cwd: string) => projectNames[cwd]?.trim() || baseName(cwd);
  const needle = query.trim().toLowerCase();
  const filtered = needle ? projects.filter((cwd) => display(cwd).toLowerCase().includes(needle)) : projects;

  return (
    <div className="mc-projmenu" ref={ref} role="menu" aria-label={t("project.menuAria")}>
      <label className="mc-projmenu__search">
        <LuSearch size={13} />
        <input
          value={query}
          placeholder={t("project.search")}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
      </label>
      <div className="mc-projmenu__sep" />
      <div className="mc-projmenu__list">
        {filtered.length === 0 ? (
          <p className="mc-projmenu__empty">{t("project.empty")}</p>
        ) : (
          filtered.map((cwd) => (
            <div key={cwd} className="mc-projmenu__row" data-active={cwd === active}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={cwd === active}
                className="mc-projmenu__item"
                data-active={cwd === active}
                title={cwd}
                onClick={() => onPick(cwd)}
              >
                <LuFolder size={14} className="mc-projmenu__icon" />
                <span className="mc-truncate">{display(cwd)}</span>
                {cwd === active ? <LuCheck size={14} className="mc-projmenu__check" /> : null}
              </button>
              {/* 当前项目不给删：正开着的项目从列表消失只会让人一头雾水 */}
              {cwd === active ? null : (
                <button
                  type="button"
                  className="mc-projmenu__remove"
                  title={t("project.remove")}
                  aria-label={`${t("project.remove")}: ${display(cwd)}`}
                  onClick={() => onRemove(cwd)}
                >
                  <LuX size={13} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
      <div className="mc-projmenu__sep" />
      <button type="button" role="menuitem" className="mc-projmenu__item" onClick={onNew}>
        <LuPlus size={14} className="mc-projmenu__icon" />
        {t("project.new")}
      </button>
    </div>
  );
}

export function Composer({
  value,
  onChange,
  focusToken = 0,
  suggestion,
  onSuggestionUsed,
  onSuggestionDismiss,
  polishTarget = "main",
  chips,
  onRemoveChip,
  onAttachSkill,
  onAttachPlugin,
  onAttachCommand,
  onAttachFile,
  askCard,
  onAnswerAsk,
  onSend,
  onError,
  onStop,
  disabled,
  streaming,
  queuedPrompts,
  onSteerQueued,
  onRemoveQueued,
  recoveredPrompts,
  onSendRecovered,
  onDiscardRecovered,
  canUse,
  workspace,
  projectCwd,
  gitBranch,
  onOpenGit,
  worktreeEnabled,
  worktreeLocked,
  worktreeBusy,
  onToggleWorktree,
  workspaceAvailable,
  providers,
  activeProviderId,
  onChangeActiveProvider,
  onManageModels,
  model,
  effort,
  onChangeEffort,
  permissionMode,
  onChangePermissionMode,
  agentProfile,
  onChangeAgentProfile,
  architectures,
  activeArchitecture,
  onSelectArchitecture,
  chatMode,
  onChangeChatMode,
  planDocPath,
  onConfirmPlan,
  onDismissPlan,
  contextUsage,
  showContext,
  compacting,
  cacheDiagnostics,
  onManualCompact,
  projects,
  projectNames,
  onSwitchProject,
  onNewProject,
  onRemoveProject,
  plan,
  changes,
}: {
  value: string;
  onChange: (value: string) => void;
  /** 递增时把焦点交给输入框（新对话建议点选后使用） */
  focusToken?: number;
  /** 回合结束后预测的下一句：输入框空且聚焦时按 Tab 填入，不会自动发送 */
  suggestion?: string | null;
  onSuggestionUsed?: () => void;
  onSuggestionDismiss?: () => void;
  /** 美化提示词调用哪个 runtime：侧边聊传 "side"，缺省主聊天 */
  polishTarget?: "main" | "side";
  /** 已引用的技能 / 插件 / 插件命令（可多选） */
  chips?: ComposerChip[];
  onRemoveChip?: (chip: ComposerChip) => void;
  /** 选中技能/插件：交给上层追加 chip */
  onAttachSkill?: (chip: { id: string; name: string; iconUrl?: string }) => void;
  onAttachPlugin?: (chip: { id: string; name: string; iconUrl?: string }) => void;
  /** `/` 面板选中插件命令：交给上层挂命令 chip */
  onAttachCommand?: (chip: {
    id: string;
    name: string;
    command: string;
    iconUrl?: string;
  }) => void;
  /** 选中/拖入非图片文件：挂附件 chip（绝对路径，工作区内外都允许） */
  onAttachFile?: (file: { name: string; path: string }) => void;
  /** ask_user 澄清问题卡片：模型反问时整个输入框换成引导式点选（可批量多题） */
  askCard?: {
    callId: string;
    questions: Array<{ question: string; options: string[] }>;
  } | null;
  onAnswerAsk?: (callId: string, answers: string[]) => void;
  /** 发送：附带当前输入框里的图片（没有图片时不传第二个参数） */
  onSend: (images?: ComposerImage[], overrideText?: string) => void;
  /** 图片读取/压缩失败等提示，交给上层统一弹 toast */
  onError?: (message: string) => void;
  onStop: () => void;
  disabled: boolean;
  streaming: boolean;
  /** 运行中排队等待发送的消息 */
  queuedPrompts: QueuedPrompt[];
  onSteerQueued: (id: string) => void;
  onRemoveQueued: (id: string) => void;
  /** 上次进程退出时未交付的消息；只展示，不自动执行 */
  recoveredPrompts: QueuedPrompt[];
  onSendRecovered: (item: QueuedPrompt) => void;
  onDiscardRecovered: (id: string) => void;
  canUse: boolean;
  workspace?: string;
  /** 项目目录（worktree 会话归回原项目）；只用于项目胶囊与 worktree 开关 */
  projectCwd?: string;
  /** 当前会话 cwd 的分支：null / 缺省表示不是 git 仓库，不显示分支胶囊 */
  gitBranch?: { name: string; detached: boolean } | null;
  /** 点分支胶囊 → 打开源码管理 */
  onOpenGit?: () => void;
  worktreeEnabled?: boolean;
  /** 当前会话已经在 worktree 中：开关锁定，避免误解 */
  worktreeLocked?: boolean;
  worktreeBusy?: boolean;
  onToggleWorktree?: (next: boolean) => void;
  /** 工作区目录是否存在：null = 校验中，false = 已被删除（显示「选择工作区」） */
  workspaceAvailable?: boolean | null;
  /** 已启用的模型，弹层里列出让用户切换 */
  providers: ProviderSettings[];
  activeProviderId: string;
  onChangeActiveProvider: (providerId: string) => void;
  /** 打开 设置 → 模型（模型弹层底部「管理模型」） */
  onManageModels: () => void;
  model: string;
  effort?: string;
  onChangeEffort: (value: string) => void;
  /** 当前工具审批模式（会话级，后端同款） */
  permissionMode: PermissionMode;
  onChangePermissionMode: (mode: PermissionMode) => void;
  /** 主 Agent 档位（会话级）：标准 / 极简 / 复杂；side 聊天不传即隐藏该胶囊 */
  agentProfile?: AgentProfileId;
  onChangeAgentProfile?: (profile: AgentProfileId) => void;
  /** 架构图列表（内置三档 + 自定义架构），与架构页同一份数据 */
  architectures?: HarnessArchitectureSummary[];
  /** 当前生效的架构图 id：自定义架构时与 agentProfile 不同 */
  activeArchitecture?: string;
  /** 选中自定义架构：只换图，不改档位 */
  onSelectArchitecture?: (id: string) => void;
  /** 会话模式（plan / goal），与审批模式互相独立 */
  chatMode: SessionMode;
  onChangeChatMode: (mode: SessionMode) => void;
  /** 计划文档路径：非空时整个输入框换成确认卡片 */
  planDocPath?: string | null;
  /** 确认卡片「开始执行」：退出计划模式并发送实施指令 */
  onConfirmPlan?: () => void;
  /** 发出调整意见后收起确认卡片，恢复普通输入框（等新计划写完再弹） */
  onDismissPlan?: () => void;
  /** 当前会话的上下文占用（圆圈与弹层数据源） */
  contextUsage: ContextUsage | null;
  /** 当前会话发过对话才显示占用圆圈，空会话不显示 */
  showContext: boolean;
  /** 压缩进行中（compaction_started → completed） */
  compacting: boolean;
  /** 前缀缓存诊断（弹层缓存行数据源）；缺省 = 老服务端/还没有数据 */
  cacheDiagnostics?: CacheDiagnostics | null;
  /** 手动压缩：POST /session/compact，由 App 处理错误展示 */
  onManualCompact: () => Promise<void>;
  /** 已知项目列表 + 自定义显示名（项目切换菜单） */
  projects: string[];
  projectNames: Record<string, string>;
  /** 切换项目（工作区）：保存设置并新建会话 */
  onSwitchProject: (cwd: string) => void;
  /** 新建项目：弹目录选择器 */
  onNewProject: () => void;
  /** 从项目列表移除（只隐藏，聊天记录与磁盘文件都不动） */
  onRemoveProject?: (cwd: string) => void;
  /** 当前会话任务计划：显示在输入框上方 */
  plan?: PlanState | null;
  /** 当前会话已修改文件（GET /session/changes?summary=1）：与计划一起显示在悬浮胶囊里 */
  changes?: SessionChangeSummary[];
}) {
  const projectDisplayCwd = projectCwd ?? workspace;
  const { t } = useTranslation("composer");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!focusToken) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [focusToken]);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const ctxButtonRef = useRef<HTMLButtonElement>(null);
  const accessButtonRef = useRef<HTMLButtonElement>(null);
  const accessMenuRef = useRef<HTMLDivElement>(null);
  const agentButtonRef = useRef<HTMLButtonElement>(null);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  /** 主 Agent 档位菜单（与权限 /「+」菜单互斥） */
  const [agentOpen, setAgentOpen] = useState(false);
  /** 「+」菜单：添加附件 / 引用插件与技能 / 命令模式 */
  const [plusOpen, setPlusOpen] = useState(false);
  /** 「+」菜单右侧二级浮层：插件 / 技能 */
  const [plusFlyout, setPlusFlyout] = useState<"plugins" | "skills" | null>(null);
  /** 未安装的市场条目正在复制安装 */
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  /** 二级浮层悬停关闭延迟：跨过 6px 间隙进入浮层时不闪退 */
  const flyoutTimerRef = useRef<number | null>(null);
  const showPlusFlyout = (view: "plugins" | "skills") => {
    if (flyoutTimerRef.current) window.clearTimeout(flyoutTimerRef.current);
    setPlusFlyout(view);
  };
  const scheduleHidePlusFlyout = () => {
    if (flyoutTimerRef.current) window.clearTimeout(flyoutTimerRef.current);
    flyoutTimerRef.current = window.setTimeout(() => setPlusFlyout(null), 160);
  };
  useEffect(
    () => () => {
      if (flyoutTimerRef.current) window.clearTimeout(flyoutTimerRef.current);
    },
    [],
  );
  /** 项目切换菜单是否展开 */
  const [projectOpen, setProjectOpen] = useState(false);
  /** 分支切换弹层是否展开（两个菜单互斥，同时只开一个） */
  const [branchOpen, setBranchOpen] = useState(false);
  /** @文件引用：当前光标所在的引用 token */
  const [mention, setMention] = useState<MentionState | null>(null);
  /** `/` 命令面板：值以 / 开头且还没输入空格时显示；Esc 关掉后要重新输入才再弹 */
  const [slashHidden, setSlashHidden] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  /** 当前目录的直接子项；null 表示正在加载 */
  const [mentionEntries, setMentionEntries] = useState<MentionEntry[] | null>(null);
  const [mentionFailed, setMentionFailed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  /** 手动刷新计数：文件被外部改动后不必关掉面板重开 */
  const [mentionReload, setMentionReload] = useState(0);
  const mentionListRef = useRef<HTMLUListElement>(null);
  const mentionOpen = mention !== null;
  /** 待发送的图片（粘贴 / 拖拽 / 加号选择） */
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 计划确认卡片里「调整计划」的输入内容 */
  const [adjust, setAdjust] = useState("");
  const adjustRef = useRef<HTMLInputElement>(null);
  // 换了一份计划文档就清掉上一版的调整草稿
  useEffect(() => {
    setAdjust("");
  }, [planDocPath]);

  /** 「美化提示词」请求进行中：按钮转圈并阻止重复触发 */
  const [polishing, setPolishing] = useState(false);
  const [composing, setComposing] = useState(false);
  const polishingRef = useRef(false);
  /** 异步返回时读取最新输入值（闭包里的 value 会过期） */
  const valueRef = useRef(value);
  valueRef.current = value;
  /** 卸载后不再写宿主 state / 弹提示（切会话时旧请求的结果必须丢掉） */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const addImages = async (files: File[]) => {
    const room = MAX_COMPOSER_IMAGES - images.length;
    if (room <= 0) {
      onError?.(t("image.maxCount", { count: MAX_COMPOSER_IMAGES }));
      return;
    }
    const picked = files.filter((file) => file.type.startsWith("image/")).slice(0, room);
    if (!picked.length) {
      onError?.(t("image.onlyImages"));
      return;
    }
    if (files.length > room) onError?.(t("image.maxCount", { count: MAX_COMPOSER_IMAGES }));
    for (const file of picked) {
      const prepared = await prepareImage(file, t).catch((error: unknown) =>
        error instanceof Error ? error.message : t("image.readFailed"),
      );
      if (typeof prepared === "string") {
        onError?.(prepared);
        continue;
      }
      setImages((current) =>
        current.length >= MAX_COMPOSER_IMAGES ? current : [...current, prepared],
      );
    }
  };

  const takeImages = (): ComposerImage[] | undefined => {
    if (!images.length) return undefined;
    const payload = images;
    setImages([]);
    return payload;
  };

  /**
   * 非图片文件：每份挂一个附件 chip（卡片，与技能引用同一行），**不限工作区** ——
   * 用户明确挑选/拖入的文件就应该能发给模型。内容由运行时按绝对路径读取注入，
   * 输入框正文里不再插入 `@路径` 文本。
   */
  const attachFiles = (files: File[]) => {
    const picked: Array<{ name: string; path: string }> = [];
    const seen = new Set<string>();
    for (const file of files) {
      const absolute = window.meow.getFilePath?.(file) ?? "";
      if (!absolute.trim()) {
        onError?.(t("file.pathFailed", { name: file.name }));
        continue;
      }
      // 拖入目录时 Chromium 给的是一条 size=0、无 type 的伪文件：挂上卡片也读不出内容
      if (file.size === 0 && !file.type) {
        onError?.(t("file.skipped", { name: file.name }));
        continue;
      }
      const key = normalizeFilePath(absolute).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push({ name: file.name || baseNameOf(absolute), path: absolute });
    }
    if (!picked.length) return;
    if (onAttachFile) {
      for (const file of picked) onAttachFile(file);
    } else {
      // 没有 chip 回调的宿主（复用 Composer 的其他入口）：退回 @ 绝对路径引用
      const tokens = picked.map((file) =>
        /\s/.test(file.path) ? `@"${file.path}"` : `@${file.path}`,
      );
      const separator = value && !/\s$/.test(value) ? " " : "";
      onChange(`${value}${separator}${tokens.join(" ")} `);
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  /** 拖入/选择：图片走多模态缩略图，其余文件挂附件卡片 */
  const addFiles = (files: File[]) => {
    const pickedImages = files.filter((file) => file.type.startsWith("image/"));
    const others = files.filter((file) => !file.type.startsWith("image/"));
    if (pickedImages.length) void addImages(pickedImages);
    if (others.length) attachFiles(others);
  };

  /**
   * 目录作用域直接从 query 推导：`@src/ap` 列 src/ 并用 "ap" 过滤。
   * 这样「手打路径」和「点目录项」走同一条路，不需要额外的导航状态，
   * 光标移进移出也能自然跟随。
   */
  const mentionScope = useMemo(() => mentionScopeOf(mention?.query ?? ""), [mention?.query]);

  useEffect(() => {
    setProjectOpen(false);
  }, [workspace]);

  // 档位按模型区分；存下来的值可能不属于当前模型（换过模型），那种按「默认」显示。
  // 不用 useMemo：远程档位表更新后 App 会重渲染，这里跟着算一次即可。
  const activeProvider = providers.find((item) => item.id === activeProviderId);
  const levels = levelsFor(activeProvider);
  const activeAgentProfile = agentProfile ?? "standard";
  const agentProfileInfo = agentProfileDisplay(activeAgentProfile);
  // 当前生效的是自定义架构时，胶囊显示架构名（与架构页左栏同一个名字）
  const activeCustomArchitecture = architectures?.find(
    (item) => item.id === activeArchitecture && !item.builtin,
  );
  const AgentProfileIcon = agentProfileInfo.icon;
  const activeEffort = isEffortValid(effort, levels) ? effort ?? "" : "";
  const enabledProviders = useMemo(() => providers.filter((item) => item.enabled !== false), [providers]);
  /** 审批模式菜单项：表里只有 key，文案在这里随语言重建 */
  const permissionOptions = useMemo(
    () =>
      PERMISSION_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
        desc: t(option.descKey),
      })),
    [t],
  );

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  // 换工作区后文件列表失效
  useEffect(() => {
    setMention(null);
    setMentionEntries(null);
    setMentionFailed(false);
  }, [workspace]);

  /** `/xxx`：还没输入空格时才当作命令检索词（支持中文、连字符，如 sessions-log / 前端） */
  const slashQuery = useMemo(() => {
    if (!value.startsWith("/")) return null;
    const rest = value.slice(1);
    return /^\S*$/.test(rest) ? rest.toLowerCase() : null;
  }, [value]);

  /** ask_user 向导式回答状态：当前题号、已答记录、当前输入草稿 */
  const [askStep, setAskStep] = useState(0);
  const [askAnswers, setAskAnswers] = useState<Record<number, string>>({});
  const [askDraft, setAskDraft] = useState("");
  const askRef = useRef<HTMLInputElement>(null);

  /** 已安装插件 / 技能 + 市场目录：`/` 面板与「+」菜单共用，首次打开时并行拉取 */
  const [pluginsOverview, setPluginsOverview] = useState<PluginsOverview | null>(null);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const [marketEntries, setMarketEntries] = useState<MarketplaceEntry[]>([]);
  const [marketIcons, setMarketIcons] = useState<Record<string, string>>({});
  const paletteNeeded = plusOpen || slashQuery !== null;
  useEffect(() => {
    if (!paletteNeeded) return;
    let disposed = false;
    void Promise.all([listPlugins(), listSkills(workspace), loadMarketplaceCatalog()])
      .then(([overview, skills, catalog]) => {
        if (disposed) return;
        setPluginsOverview(overview);
        setInstalledSkills(skills);
        setMarketEntries(catalog.items);
        setMarketIcons(catalog.icons);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [paletteNeeded, workspace]);

  const marketByKey = useMemo(
    () => new Map(marketEntries.map((entry) => [`${entry.type}:${entry.id}`, entry])),
    [marketEntries],
  );

  type SlashModeItem = {
    kind: "mode";
    mode: Exclude<SessionMode, "default">;
    command: string;
    label: string;
    desc: string;
  };
  type SlashMarkdownItem = {
    kind: "markdown";
    command: string;
    name: string;
    description: string;
    source: string;
  };
  type SlashPluginItem = {
    kind: "plugin";
    command: string;
    commandName: string;
    pluginId: string;
    title: string;
    description: string;
    iconUrl?: string;
  };
  type SlashSkillItem = {
    kind: "skill";
    id: string;
    name: string;
    title: string;
    description: string;
    iconUrl?: string;
    installed: boolean;
  };
  type SlashItem = SlashModeItem | SlashMarkdownItem | SlashPluginItem | SlashSkillItem;

  /** 技能选择器数据：市场全部技能（未装的选中时先安装）+ 用户手放的自定义技能 */
  type SkillChoice = {
    id: string;
    name: string;
    title: string;
    description: string;
    iconUrl?: string;
    installed: boolean;
  };
  const allSkillChoices = useMemo<SkillChoice[]>(() => {
    const fromMarket = marketEntries
      .filter((entry) => entry.type === "skill")
      .map((entry) => ({
        id: entry.id,
        name: entry.id,
        title: entry.name,
        description: entry.description,
        iconUrl: marketIcons[`skill:${entry.id}`],
        installed: entry.installed,
      }));
    const known = new Set(fromMarket.map((item) => item.id));
    const custom = installedSkills
      .filter((skill) => !known.has(skill.id))
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        title: marketByKey.get(`skill:${skill.id}`)?.name ?? skill.name,
        description: skill.description,
        iconUrl: marketIcons[`skill:${skill.id}`],
        installed: true,
      }));
    return [...fromMarket, ...custom];
  }, [marketEntries, installedSkills, marketByKey, marketIcons]);

  /** 插件选择器数据：市场全部插件 + 本地手放的自定义插件 */
  type PluginChoice = {
    id: string;
    title: string;
    description: string;
    iconUrl?: string;
    installed: boolean;
  };
  const allPluginChoices = useMemo<PluginChoice[]>(() => {
    const fromMarket = marketEntries
      .filter((entry) => entry.type === "plugin")
      .map((entry) => ({
        id: entry.id,
        title: entry.name,
        description: entry.description,
        iconUrl: marketIcons[`plugin:${entry.id}`],
        installed: entry.installed,
      }));
    const known = new Set(fromMarket.map((item) => item.id));
    const custom = (pluginsOverview?.plugins ?? [])
      .filter((plugin) => !known.has(plugin.id))
      .map((plugin) => ({
        id: plugin.id,
        // 汉化显示名优先（内置插件 builtin-meta 提供），市场名次之，最后回落 id
        title: marketByKey.get(`plugin:${plugin.id}`)?.name ?? plugin.displayName ?? plugin.id,
        description: plugin.error
          ? t("plugin.loadFailed", { error: plugin.error })
          : plugin.description ?? t("plugin.local"),
        // 内置插件不在市场索引里，图标走描述符自带的 iconUrl（builtin-meta），市场图标兜底
        iconUrl: plugin.iconUrl ?? marketIcons[`plugin:${plugin.id}`],
        installed: true,
      }));
    return [...fromMarket, ...custom];
  }, [marketEntries, pluginsOverview, marketByKey, marketIcons, t]);

  /** 插件注册的命令（source = plugin:<id>），带市场图标与展示名；内置插件用描述符自带图标/汉化名 */
  const pluginCommandItems = useMemo<SlashPluginItem[]>(() => {
    if (!pluginsOverview) return [];
    const metaByPlugin = new Map(pluginsOverview.plugins.map((plugin) => [plugin.id, plugin]));
    return pluginsOverview.commands
      .filter((item) => item.source.startsWith("plugin:"))
      .map((item) => {
        const pluginId = item.source.slice("plugin:".length);
        const descriptor = metaByPlugin.get(pluginId);
        return {
          kind: "plugin" as const,
          command: `/${item.name}`,
          commandName: item.name,
          pluginId,
          title:
            marketByKey.get(`plugin:${pluginId}`)?.name ??
            descriptor?.displayName ??
            pluginId,
          description: item.description ?? "",
          iconUrl: descriptor?.iconUrl ?? marketIcons[`plugin:${pluginId}`],
        };
      });
  }, [pluginsOverview, marketByKey, marketIcons]);

  /** 已安装技能（含用户手放的非市场技能） */
  const skillItems = useMemo<SlashSkillItem[]>(
    () =>
      allSkillChoices.map((skill) => ({
        kind: "skill" as const,
        id: skill.id,
        name: skill.name,
        title: skill.title,
        description: skill.description,
        iconUrl: skill.iconUrl,
        installed: skill.installed,
      })),
    [allSkillChoices],
  );

  /** markdown 斜杠命令（.meowcode/commands/*.md） */
  const markdownCommandItems = useMemo<SlashMarkdownItem[]>(
    () =>
      (pluginsOverview?.commands ?? [])
        .filter((item) => !item.source.startsWith("plugin:"))
        .map((item) => ({
          kind: "markdown" as const,
          command: `/${item.name}`,
          name: item.name,
          description: item.description ?? "",
          source: item.source,
        })),
    [pluginsOverview],
  );

  const slashItems = useMemo<SlashItem[]>(() => {
    if (slashQuery === null) return [];
    const modeItems: SlashModeItem[] = SLASH_COMMANDS.filter((item) =>
      item.command.slice(1).startsWith(slashQuery),
    ).map((item) => ({
      kind: "mode",
      mode: item.mode,
      command: item.command,
      label: t(item.labelKey),
      desc: t(item.descKey),
    }));
    const markdownItems = markdownCommandItems.filter((item) =>
      item.name.toLowerCase().startsWith(slashQuery),
    );
    const pluginItems = pluginCommandItems.filter(
      (item) =>
        item.commandName.toLowerCase().startsWith(slashQuery) ||
        item.title.toLowerCase().includes(slashQuery),
    );
    const skills = skillItems.filter(
      (item) =>
        item.name.toLowerCase().includes(slashQuery) ||
        item.id.toLowerCase().includes(slashQuery) ||
        item.title.toLowerCase().includes(slashQuery),
    );
    return [...modeItems, ...markdownItems, ...pluginItems, ...skills];
  }, [slashQuery, markdownCommandItems, pluginCommandItems, skillItems, t]);
  const slashOpen = !slashHidden && slashQuery !== null && slashItems.length > 0 && !mention;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  /** 选中命令：模式直接切换；插件命令/技能挂上 chip 后输入需求；markdown 命令填入输入框 */
  const chooseSlashCommand = (item: SlashItem) => {
    setSlashHidden(true);
    setMention(null);
    if (item.kind === "plugin") {
      if (onAttachCommand) {
        onAttachCommand({
          id: item.pluginId,
          name: item.title,
          command: item.commandName,
          iconUrl: item.iconUrl,
        });
        onChange("");
      } else {
        onChange(`${item.command} `);
      }
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    if (item.kind === "skill") {
      onChange("");
      void attachSkillChoice({
        id: item.id,
        title: item.title,
        iconUrl: item.iconUrl,
        installed: item.installed,
      });
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    if (item.kind === "markdown") {
      onChange(`${item.command} `);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    onChange("");
    onChangeChatMode(chatMode === item.mode ? "default" : item.mode);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  /** 选中技能：市场条目未安装时先复制安装，再挂 chip */
  const attachSkillChoice = async (choice: {
    id: string;
    title: string;
    iconUrl?: string;
    installed: boolean;
  }) => {
    setPlusOpen(false);
    if (!choice.installed) {
      const key = `skill:${choice.id}`;
      setInstallingKey(key);
      try {
        await installMarketplaceItem(choice.id, "skill");
        invalidateMarketplaceCatalog();
        setMarketEntries((entries) =>
          entries.map((entry) =>
            entry.type === "skill" && entry.id === choice.id
              ? { ...entry, installed: true }
              : entry,
          ),
        );
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
        return;
      } finally {
        setInstallingKey(null);
      }
    }
    if (onAttachSkill) onAttachSkill({ id: choice.id, name: choice.title, iconUrl: choice.iconUrl });
    else onChange(`【技能引用】${choice.title} · ${choice.id}\n\n`); // i18n-allow 消息首部协议标记，与 src/agent 解析约定一致
  };

  /** 选中插件：未安装时先安装，再挂整插件引用 chip（不是命令 chip） */
  const attachPluginChoice = async (choice: {
    id: string;
    title: string;
    iconUrl?: string;
    installed: boolean;
  }) => {
    setPlusOpen(false);
    if (!choice.installed) {
      const key = `plugin:${choice.id}`;
      setInstallingKey(key);
      try {
        await installMarketplaceItem(choice.id, "plugin");
        invalidateMarketplaceCatalog();
        setMarketEntries((entries) =>
          entries.map((entry) =>
            entry.type === "plugin" && entry.id === choice.id
              ? { ...entry, installed: true }
              : entry,
          ),
        );
        // 插件安装后服务端会重载，插件/命令列表稍后刷新一次
        void listPlugins().then(setPluginsOverview).catch(() => undefined);
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
        return;
      } finally {
        setInstallingKey(null);
      }
    }
    if (onAttachPlugin) onAttachPlugin({ id: choice.id, name: choice.title, iconUrl: choice.iconUrl });
    else onChange(`【插件引用】${choice.title} · ${choice.id}\n\n`); // i18n-allow 消息首部协议标记，与 src/agent 解析约定一致
  };

  /**
   * 每次打开面板 / 切换目录 / 点刷新都重新读盘。
   * 刻意不缓存：文件在编辑器或外部被改名、删除后，旧列表会让人选到已经不存在的路径。
   */
  useEffect(() => {
    if (!mentionOpen) {
      setMentionEntries(null);
      return;
    }
    let disposed = false;
    setMentionFailed(false);
    setMentionEntries(null);
    void api<{ entries: MentionEntry[] }>(
      `/workspace/dir?path=${encodeURIComponent(mentionScope.dir)}`,
    )
      .then((result) => {
        if (!disposed) setMentionEntries(result.entries);
      })
      .catch(() => {
        if (disposed) return;
        setMentionFailed(true);
        setMentionEntries([]);
      });
    return () => {
      disposed = true;
    };
  }, [mentionOpen, mentionScope.dir, mentionReload]);

  useEffect(() => {
    // 进目录时 `..` 在首位，默认落在第一个真实条目上，避免顺手按 Enter 又弹回上一层
    setMentionIndex(mentionScope.dir ? 1 : 0);
  }, [mention?.query, mentionEntries, mentionScope.dir]);

  useEffect(() => {
    const list = mentionListRef.current;
    if (!list) return;
    const active = list.children[mentionIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [mentionIndex]);

  /** `..` 排最前（键盘也能选到），其余保持服务端的目录优先 + 名字序 */
  const mentionResults = useMemo(
    () =>
      mentionEntries ? buildMentionItems(mentionEntries, mentionScope.dir, mentionScope.filter) : [],
    [mentionEntries, mentionScope.dir, mentionScope.filter],
  );

  const updateMention = (text: string, caret: number) => {
    setMention(workspace ? detectMention(text, caret) : null);
  };

  /**
   * 用 token 替换当前 @ 引用。
   * 选文件时补一个空格并关面板；进目录时保持面板打开、光标停在末尾，方便接着过滤。
   */
  const applyMentionToken = (token: string, options: { close: boolean }) => {
    if (!mention) return;
    const tail = options.close ? " " : "";
    const next = `${value.slice(0, mention.start)}${token}${tail}${value.slice(mention.end)}`;
    const caret = mention.start + token.length + tail.length;
    onChange(next);
    if (options.close) setMention(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
      // 目录要重新解析一次 query，effect 才会去拉新目录
      if (!options.close) setMention(detectMention(next, caret));
    });
  };

  const pickMentionItem = (item: MentionItem) => {
    if (item.kind === "file") {
      applyMentionToken(mentionToken(item.path), { close: true });
      return;
    }
    // 目录 / 上一层：`@src/`、根目录则是 `@`
    applyMentionToken(mentionDirToken(item.path), { close: false });
  };

  // 点权限菜单外部关闭（chip 按钮自身交给 toggle）
  useEffect(() => {
    if (!accessOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (accessMenuRef.current?.contains(target)) return;
      if (accessButtonRef.current?.contains(target)) return;
      setAccessOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccessOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accessOpen]);

  // 点「+」菜单外部关闭（按钮自身交给 toggle）
  useEffect(() => {
    if (!plusOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (plusMenuRef.current?.contains(target)) return;
      if (plusButtonRef.current?.contains(target)) return;
      setPlusOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlusOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [plusOpen]);

  // 菜单关闭时收起右侧浮层，下次打开不残留
  useEffect(() => {
    if (plusOpen) return;
    setPlusFlyout(null);
  }, [plusOpen]);

  /**
   * 斜杠命令：`/plan`、`/goal` 单独输入 = 切换模式；
   * 带文字（如 `/plan 重构登录`）= 切模式并把剩余文字作为消息发出。
   * 返回 true 表示已被命令消费，不再走普通发送。
   */
  const trySlashCommand = (): boolean => {
    const match = /^\/(plan|goal)(?:\s+([\s\S]*))?$/.exec(value.trim());
    if (match) {
      const mode = match[1] as Exclude<SessionMode, "default">;
      const rest = (match[2] ?? "").trim();
      if (!rest) {
        // 再输一次同样的命令 = 退出模式
        onChangeChatMode(chatMode === mode ? "default" : mode);
        onChange("");
        return true;
      }
      if (chatMode !== mode) onChangeChatMode(mode);
      onChange("");
      // overrideText 路径上层不清输入框，这里自己清；图片仍随消息带走
      onSend(takeImages(), rest);
      return true;
    }
    // 插件命令：手输 `/cmd args` 也走卡片协议，气泡里不展示展开后的长指令
    const commandMatch = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(value.trim());
    if (!commandMatch) return false;
    const command = pluginCommandItems.find((item) => item.commandName === commandMatch[1]);
    if (!command) return false;
    const args = (commandMatch[2] ?? "").trim();
    onChange("");
    onSend(
      takeImages(),
      `【插件命令】${command.title} · ${command.pluginId} · ${command.commandName}\n\n/${command.commandName}${args ? ` ${args}` : ""}`, // i18n-allow 消息首部协议标记，与 src/agent 解析约定一致
    );
    return true;
  };

  // 只挂附件、不写字也能发（"看看这份文件"是隐含意图）。技能/插件 chip 不算：
  // 它们需要配合需求描述，单独发出去模型没任务可做。
  const hasAttachments = Boolean(chips?.some((chip) => chip.kind === "file"));
  const sendDisabled =
    disabled || compacting || polishing || (!value.trim() && !images.length && !hasAttachments);

  const polishDisabled = disabled || compacting || polishing || !value.trim();
  const showSuggestion = Boolean(
    suggestion &&
      !value &&
      !images.length &&
      !chips?.length &&
      !polishing &&
      !composing &&
      !disabled &&
      !compacting,
  );

  /** 美化提示词：请求返回时若草稿已被改动/发送，丢弃结果，绝不覆盖新输入 */
  const handlePolish = async () => {
    const source = value;
    if (!source.trim() || disabled || compacting || polishingRef.current) return;
    polishingRef.current = true;
    setPolishing(true);
    try {
      const result = await polishPrompt(source, { side: polishTarget === "side" });
      if (!aliveRef.current) return;
      if (valueRef.current !== source) {
        onError?.(t("polish.discarded"));
        return;
      }
      onChange(result.text);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(result.text.length, result.text.length);
      });
    } catch (error) {
      if (!aliveRef.current) return;
      onError?.(t("polish.failed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      polishingRef.current = false;
      if (aliveRef.current) setPolishing(false);
    }
  };

  /** 确认卡片里的调整输入：Enter 或右侧箭头发送（留在计划模式，模型改文档） */
  const submitAdjust = () => {
    const text = adjust.trim();
    if (!text || disabled || compacting) return;
    setAdjust("");
    // 发完立即恢复普通输入框：改稿期间还能继续输入，新计划写完会再次弹出确认卡片
    onDismissPlan?.();
    onSend(undefined, text);
  };

  // ask_user 澄清问题：向导式逐题回答——一次工具调用可带多题，卡片一次只显示一题，
  // 答完自动进入下一题，最后一题答完统一提交（answers 按题序对齐返回给模型）
  if (askCard) {
    const questions = askCard.questions;
    const total = questions.length;
    const step = Math.min(askStep, total - 1);
    const current = questions[step];
    const finish = (answer: string) => {
      const finalAnswers = { ...askAnswers, [step]: answer.trim() };
      onAnswerAsk?.(
        askCard.callId,
        questions.map((_, index) => finalAnswers[index]?.trim() || t("plan.unanswered")),
      );
      setAskStep(0);
      setAskAnswers({});
      setAskDraft("");
    };
    const next = (answer: string) => {
      if (step + 1 >= total) {
        finish(answer);
        return;
      }
      setAskAnswers((record) => ({ ...record, [step]: answer.trim() }));
      setAskDraft("");
      setAskStep(step + 1);
    };
    const skipRest = () => {
      // 跳过当前及剩余题目：已答的保留，剩余按「（未回答）」提交
      onAnswerAsk?.(
        askCard.callId,
        questions.map((_, index) =>
          index < step ? askAnswers[index]?.trim() || t("plan.unanswered") : t("plan.unanswered"),
        ),
      );
      setAskStep(0);
      setAskAnswers({});
      setAskDraft("");
    };
    return (
      <div className="mc-composerwrap">
        <div className="mc-composerstack">
          <div className="mc-composer" data-ask="true">
            <div className="mc-planconfirm" role="dialog" aria-label={t("plan.answerAria")}>
              <p className="mc-planconfirm__title">
                {total > 1 ? (
                  <>
                    <span className="mc-planconfirm__progress">
                      {step + 1} / {total}
                    </span>
                    {current.question}
                  </>
                ) : (
                  current.question
                )}
              </p>
              {total > 1 ? (
                <p className="mc-planconfirm__sub">{t("plan.answerSubMultiple")}</p>
              ) : (
                <p className="mc-planconfirm__sub">{t("plan.answerSub")}</p>
              )}
              {current.options.map((option, oIndex) => (
                <button
                  key={`${oIndex}-${option}`}
                  type="button"
                  className="mc-planconfirm__option"
                  data-primary={oIndex === 0}
                  onClick={() => next(option)}
                >
                  <span className="mc-planconfirm__num">
                    {String.fromCharCode(65 + oIndex)}
                  </span>
                  <span className="mc-planconfirm__label">{option}</span>
                  <LuArrowRight size={15} className="mc-planconfirm__arrow" />
                </button>
              ))}
              <div
                className="mc-planconfirm__option"
                data-field="true"
                onClick={() => askRef.current?.focus()}
              >
                <span className="mc-planconfirm__num">✎</span>
                <input
                  ref={askRef}
                  className="mc-planconfirm__input"
                  value={askDraft}
                  placeholder={t("plan.answerPlaceholder")}
                  onChange={(event) => setAskDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && askDraft.trim()) {
                      event.preventDefault();
                      next(askDraft.trim());
                    }
                  }}
                />
              </div>
              {total > 1 ? (
                <div className="mc-planconfirm__footer" data-single={step === 0 ? "true" : undefined}>
                  {step > 0 ? (
                    <button
                      type="button"
                      className="mc-planconfirm__back"
                      onClick={() => {
                        setAskStep(step - 1);
                        setAskDraft("");
                      }}
                    >
                      ‹ {t("plan.prev")}
                    </button>
                  ) : null}
                  <button type="button" className="mc-planconfirm__back" onClick={skipRest}>
                    {t("plan.skipRest")} ›
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 计划确认阶段：整个输入框换成确认卡片（写入过程不改输入框，聊天区已有写入行）
  if (planDocPath) {
    return (
      <div className="mc-composerwrap">
        <div className="mc-composerstack">
          <div className="mc-composer" data-plan="true" data-disabled={disabled || compacting}>
            <div className="mc-planconfirm" role="dialog" aria-label={t("plan.confirmAria")}>
                <button
                  type="button"
                  className="mc-planconfirm__exit"
                  aria-label={t("plan.exit")}
                  title={t("plan.exit")}
                  onClick={() => onChangeChatMode("default")}
                >
                  <LuX size={13} />
                </button>
                <p className="mc-planconfirm__title">{t("plan.confirmTitle")}</p>
                <p className="mc-planconfirm__sub">{t("plan.confirmSub")}</p>
                <button
                  type="button"
                  className="mc-planconfirm__option"
                  data-primary="true"
                  disabled={disabled || compacting}
                  onClick={() => onConfirmPlan?.()}
                >
                  <span className="mc-planconfirm__num">1</span>
                  <span className="mc-planconfirm__label">{t("plan.start")}</span>
                  <LuArrowRight size={15} className="mc-planconfirm__arrow" />
                </button>
                {/* 选项 2 本身就是一个输入框：写完按 Enter 或点右下角发送 */}
                <div
                  className="mc-planconfirm__option"
                  data-field="true"
                  onClick={() => adjustRef.current?.focus()}
                >
                  <span className="mc-planconfirm__num">2</span>
                  <input
                    ref={adjustRef}
                    className="mc-planconfirm__input"
                    value={adjust}
                    placeholder={t("plan.adjustPlaceholder")}
                    disabled={disabled || compacting}
                    onChange={(event) => setAdjust(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        submitAdjust();
                      }
                    }}
                  />
                </div>
                <div className="mc-planconfirm__footer">
                  <button
                    type="button"
                    className="mc-planconfirm__send"
                    aria-label={t("plan.sendAdjust")}
                    title={t("plan.sendAdjust")}
                    disabled={!adjust.trim() || disabled || compacting}
                    onClick={submitAdjust}
                  >
                    <LuArrowUp size={16} />
                  </button>
                </div>
              </div>
            </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mc-composerwrap">
      <div className="mc-composerstack">
        <SessionProgressPill plan={plan} changes={changes} streaming={streaming} />

        {/* 工作区缺失（未选择 / 目录已删）：同一位置回退成「选择工作区」，点击打开目录选择器 */}
        {!workspace || workspaceAvailable === false ? (
          <div className="mc-composer__context">
            <button
              type="button"
              className="mc-composer__pickws"
              aria-label={t("project.pickWorkspace")}
              title={t("project.pickWorkspace")}
              onClick={onNewProject}
            >
              <LuFolder size={14} />
              <span>{t("project.pickWorkspace")}</span>
            </button>
          </div>
        ) : workspace && !showContext ? (
          <div className="mc-composer__context" data-open={projectOpen}>
            {/* 悬停 / 菜单展开时这一整段是一枚胶囊；点名字打开项目切换菜单 */}
            <div className="mc-composer__projpill">
              <span className="mc-composer__projicon" aria-hidden>
                <LuFolder size={15} />
              </span>
              <button
                type="button"
                className="mc-composer__projname"
                aria-haspopup="menu"
                aria-expanded={projectOpen}
                title={projectDisplayCwd}
                onClick={() => {
                  setBranchOpen(false);
                  setProjectOpen((open) => !open);
                }}
              >
                <span className="mc-truncate">
                  {projectDisplayCwd
                    ? projectNames[projectDisplayCwd]?.trim() || baseName(projectDisplayCwd)
                    : ""}
                </span>
              </button>
            </div>

            {/* 当前分支：点开是本仓库的分支列表，选一个就切过去 */}
            {gitBranch ? (
              <div className="mc-composer__branchwrap">
                <button
                  type="button"
                  className="mc-composer__branch"
                  data-detached={gitBranch.detached ? "true" : "false"}
                  aria-haspopup="listbox"
                  aria-expanded={branchOpen}
                  title={
                    gitBranch.detached
                      ? t("branch.detached")
                      : t("branch.current", { name: gitBranch.name })
                  }
                  onClick={() => {
                    setProjectOpen(false);
                    setBranchOpen((open) => !open);
                  }}
                >
                  <LuGitBranch size={15} aria-hidden />
                  <span className="mc-composer__branchname">
                    {gitBranch.detached ? "detached" : gitBranch.name}
                  </span>
                </button>
                {branchOpen ? (
                  <BranchMenu
                    onClose={() => setBranchOpen(false)}
                    onOpenGit={
                      onOpenGit
                        ? () => {
                            setBranchOpen(false);
                            onOpenGit();
                          }
                        : undefined
                    }
                  />
                ) : null}
              </div>
            ) : null}

            {onToggleWorktree && projectDisplayCwd ? (
              <div
                className="mc-composer__wt"
                data-on={worktreeEnabled ? "true" : "false"}
                data-locked={worktreeLocked ? "true" : "false"}
                title={
                  worktreeLocked ? t("worktree.locked") : t("worktree.hint")
                }
              >
                <LuGitFork size={15} aria-hidden />
                <span>Worktree</span>
                <Toggle
                  checked={Boolean(worktreeEnabled)}
                  disabled={Boolean(worktreeBusy || worktreeLocked)}
                  label={t("worktree.hint")}
                  onChange={(next) => onToggleWorktree(next)}
                />
              </div>
            ) : null}

            {projectOpen ? (
              <ProjectMenu
                projects={projects}
                projectNames={projectNames}
                active={projectDisplayCwd ?? workspace}
                onPick={(cwd) => {
                  setProjectOpen(false);
                  onSwitchProject(cwd);
                }}
                onNew={() => {
                  setProjectOpen(false);
                  onNewProject();
                }}
                onRemove={(cwd) => onRemoveProject?.(cwd)}
                onClose={() => setProjectOpen(false)}
              />
            ) : null}
          </div>
        ) : null}

        {recoveredPrompts.length ? (
          <div
            className="mc-queuedlist mc-queuedlist--recovered"
            role="status"
            aria-label={t("queue.recoveredAria")}
          >
            <div className="mc-queuedlist__head">{t("queue.recoveredHead")}</div>
            {recoveredPrompts.map((item) => (
              <div className="mc-queued" key={item.id}>
                <span className="mc-queued__text" title={queuedPreview(item.text)}>
                  {queuedPreview(item.text)}
                </span>
                <div className="mc-queued__actions">
                  <button
                    type="button"
                    className="mc-queued__action"
                    title={t("queue.sendAsNew")}
                    onClick={() => onSendRecovered(item)}
                  >
                    {t("queue.send")}
                  </button>
                  <button
                    type="button"
                    className="mc-queued__action mc-queued__action--danger"
                    title={t("queue.discardTitle")}
                    onClick={() => onDiscardRecovered(item.id)}
                  >
                    {t("queue.discard")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* 技能引用 chip：市场「使用」带过来的（已移入输入框内部） */}

        {queuedPrompts.length ? (
          <div className="mc-queuedlist" role="status" aria-label={t("queue.pendingAria")}>
            {queuedPrompts.map((item) => (
              <div className="mc-queued" key={item.id}>
                <span className="mc-queued__text" title={queuedPreview(item.text)}>
                  {queuedPreview(item.text)}
                </span>
                <div className="mc-queued__actions">
                  <button
                    type="button"
                    className="mc-queued__action"
                    title={t("queue.steerTitle")}
                    onClick={() => onSteerQueued(item.id)}
                  >
                    {t("queue.steer")}
                  </button>
                  <button
                    type="button"
                    className="mc-queued__action mc-queued__action--danger"
                    title={t("queue.removeTitle")}
                    onClick={() => onRemoveQueued(item.id)}
                  >
                    {t("queue.remove")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* `/` 命令面板：贴在输入框上方，Enter/Tab 选中，Esc 关闭；插件在上、技能在下 */}
        {slashOpen ? (
          <div className="mc-slashmenu" role="listbox" aria-label={t("slash.menuAria")}>
            {slashItems.map((item, index) => {
              const previous = slashItems[index - 1];
              const showGroup = !previous || previous.kind !== item.kind;
              const key = item.kind === "skill" ? `skill:${item.id}` : `${item.kind}:${item.command}`;
              const groupLabel =
                item.kind === "mode"
                  ? t("slash.group.mode")
                  : item.kind === "markdown"
                    ? t("slash.group.command")
                    : item.kind === "plugin"
                      ? t("slash.group.plugin")
                      : t("slash.group.skill");
              return (
                <Fragment key={key}>
                  {showGroup ? <div className="mc-slashmenu__group">{groupLabel}</div> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === slashIndex}
                    className="mc-slashmenu__item"
                    data-active={index === slashIndex}
                    onMouseEnter={() => setSlashIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseSlashCommand(item)}
                  >
                    {item.kind === "plugin" || item.kind === "skill" ? (
                      item.iconUrl ? (
                        <img src={item.iconUrl} alt="" className="mc-slashmenu__icon" />
                      ) : item.kind === "plugin" ? (
                        <LuPuzzle size={13} className="mc-slashmenu__icon" />
                      ) : (
                        <LuSparkles size={13} className="mc-slashmenu__icon" />
                      )
                    ) : null}
                    <span className="mc-slashmenu__title">
                      {item.kind === "mode" || item.kind === "markdown" ? item.command : item.title}
                    </span>
                    {item.kind === "mode" ? (
                      <span className="mc-slashmenu__desc">
                        {chatMode === item.mode
                          ? t("slash.exit", { mode: item.label })
                          : `${item.label} · ${item.desc}`}
                      </span>
                    ) : item.kind === "markdown" ? (
                      <span className="mc-slashmenu__desc">
                        {item.description || t("slash.group.command")}
                      </span>
                    ) : null}
                  </button>
                </Fragment>
              );
            })}
          </div>
        ) : null}

        {mention ? (
          <div className="mc-mention" role="listbox" aria-label={t("mention.aria")}>
            <div className="mc-mention__head">
              {mentionScope.dir ? (
                <button
                  type="button"
                  className="mc-mention__crumb"
                  title={t("mention.back")}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() =>
                    applyMentionToken(mentionDirToken(parentDir(mentionScope.dir)), {
                      close: false,
                    })
                  }
                >
                  <LuChevronLeft size={13} />
                  <span className="mc-truncate">{mentionScope.dir}/</span>
                </button>
              ) : (
                <>
                  <LuFolder size={13} />
                  <span>{t("mention.root")}</span>
                </>
              )}
              {mentionFailed ? (
                <span className="mc-mention__hint">{t("mention.loadFailed")}</span>
              ) : null}
              <button
                type="button"
                className="mc-mention__refresh"
                title={t("mention.refresh")}
                aria-label={t("mention.refresh")}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setMentionReload((current) => current + 1)}
              >
                <LuRotateCw size={13} />
              </button>
            </div>
            {mentionEntries === null ? (
              <p className="mc-mention__empty">{t("mention.loading")}</p>
            ) : mentionResults.length === 0 ? (
              <p className="mc-mention__empty">
                {mentionFailed
                  ? t("mention.dirFailed")
                  : mentionScope.filter.trim()
                    ? t("mention.noMatch")
                    : t("mention.emptyDir")}
              </p>
            ) : (
              <ul className="mc-mention__list" ref={mentionListRef}>
                {mentionResults.map((item, itemIndex) => (
                  <li key={`${item.kind}:${item.path}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={itemIndex === mentionIndex}
                      className="mc-mention__item"
                      data-active={itemIndex === mentionIndex}
                      data-kind={item.kind}
                      onMouseEnter={() => setMentionIndex(itemIndex)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pickMentionItem(item)}
                    >
                      {item.kind === "up" ? (
                        <LuArrowUp size={14} className="mc-mention__icon" />
                      ) : item.kind === "dir" ? (
                        <LuFolder size={14} className="mc-mention__icon" />
                      ) : (
                        <LuFileText size={14} className="mc-mention__icon" />
                      )}
                      <span className="mc-mention__name mc-truncate">{item.name}</span>
                      {item.kind === "dir" ? (
                        <LuChevronRight size={13} className="mc-mention__chevron" />
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        <div
          className="mc-composer"
          data-disabled={disabled || compacting}
          data-dragging={dragging}
          onDragOver={(event) => {
            if (!event.dataTransfer?.types.includes("Files")) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragging(false);
          }}
          onDrop={(event) => {
            if (!event.dataTransfer?.files.length) return;
            event.preventDefault();
            setDragging(false);
            if (disabled || compacting) return;
            addFiles([...event.dataTransfer.files]);
          }}
        >
          {images.length ? (
            <div className="mc-attach" role="list" aria-label={t("attach.listAria")}>
              {images.map((image) => (
                <div className="mc-attach__item" role="listitem" key={image.id}>
                  <img
                    className="mc-attach__thumb"
                    src={image.dataUrl}
                    alt={image.name ?? t("image.fallbackName")}
                  />
                  <button
                    type="button"
                    className="mc-attach__remove"
                    aria-label={t("attach.removeImageAria")}
                    title={t("attach.remove")}
                    onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}
                  >
                    <LuX size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {/* 已引用的技能 / 插件 / 插件命令：可多选，自动换行 */}
          {chips?.length ? (
            <div className="mc-composer__skillrow" role="status" aria-label={t("chip.listAria")}>
              {chips.map((chip) => (
                <span
                  className={`mc-skillchip${chip.kind === "file" ? " mc-skillchip--file" : ""}`}
                  key={`${chip.kind}:${chip.id}`}
                  title={chip.kind === "file" ? chip.path : undefined}
                >
                  {chip.kind === "file" ? (
                    <LuFileText size={12} className="mc-skillchip__icon" />
                  ) : chip.iconUrl ? (
                    <img src={chip.iconUrl} alt="" className="mc-skillchip__icon" />
                  ) : chip.kind === "skill" ? (
                    <LuSparkles size={12} />
                  ) : (
                    <LuPuzzle size={12} />
                  )}
                  <span className="mc-skillchip__name">{chip.name}</span>
                  {chip.kind === "command" ? (
                    <span className="mc-skillchip__cmd">/{chip.command}</span>
                  ) : null}
                  <button
                    type="button"
                    className="mc-skillchip__x"
                    aria-label={t("chip.remove", { name: chip.name })}
                    title={t("chip.remove", { name: chip.name })}
                    onClick={() => onRemoveChip?.(chip)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <div className="mc-composer__textwrap">
          <textarea
            ref={textareaRef}
            className="mc-composer__input"
            value={value}
            rows={2}
            onChange={(event) => {
              setSlashHidden(false);
              if (suggestion) onSuggestionDismiss?.();
              onChange(event.target.value);
              updateMention(event.target.value, event.target.selectionStart);
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onPaste={(event) => {
              const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
                file.type.startsWith("image/"),
              );
              if (!files.length) return;
              // 剪贴板里是图片时不再把文件名当文本粘进输入框
              event.preventDefault();
              void addImages(files);
            }}
            onSelect={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
            onBlur={() => {
              setMention(null);
              setSlashHidden(true);
            }}
            onKeyDown={(event) => {
              if (slashOpen) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSlashIndex((current) => Math.min(current + 1, slashItems.length - 1));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSlashIndex((current) => Math.max(current - 1, 0));
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const target = slashItems[Math.min(slashIndex, slashItems.length - 1)];
                  if (target) chooseSlashCommand(target);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSlashHidden(true);
                  return;
                }
              }
              if (mention && mentionResults.length) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionIndex((current) => Math.min(current + 1, mentionResults.length - 1));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionIndex((current) => Math.max(current - 1, 0));
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const target = mentionResults[mentionIndex] ?? mentionResults[0];
                  if (target) pickMentionItem(target);
                  return;
                }
              }
              if (event.key === "Escape" && mention) {
                event.preventDefault();
                setMention(null);
                return;
              }
              // 预测的下一句：Tab 填入草稿（不自动发送），Esc 本次忽略
              if (
                showSuggestion &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.shiftKey
              ) {
                if (event.key === "Tab") {
                  event.preventDefault();
                  onChange(suggestion!);
                  onSuggestionUsed?.();
                  requestAnimationFrame(() => textareaRef.current?.focus());
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onSuggestionDismiss?.();
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (polishing) return;
                if (trySlashCommand()) return;
                onSend(takeImages());
              }
            }}
            placeholder={
              !canUse
                ? t("input.placeholder.setup")
                : compacting
                  ? t("input.placeholder.compacting")
                  : planDocPath
                    ? t("plan.adjustPrompt")
                    : streaming
                      ? t("input.placeholder.streaming")
                      : t("input.placeholder.default")
            }
            disabled={disabled || compacting}
            readOnly={polishing}
          />
          {polishing ? (
            <div className="mc-composer__polishlayer" role="status" aria-live="polite">
              <span className="mc-composer__polishlabel">{t("input.polishing")}</span>
            </div>
          ) : null}
          </div>

          <div className="mc-composer__bar">
            <div className="mc-composer__left">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = "";
                  if (files.length) addFiles(files);
                }}
              />
              <div className="mc-pluswrap">
                <button
                  ref={plusButtonRef}
                  type="button"
                  className="mc-composer__icon"
                  aria-label={t("action.more")}
                  aria-haspopup="menu"
                  aria-expanded={plusOpen}
                  title={t("action.moreTitle")}
                  onClick={() => {
                    setAccessOpen(false);
                    setAgentOpen(false);
                    setPlusOpen((open) => !open);
                  }}
                >
                  <LuPlus size={16} />
                </button>
              </div>
              {/* 「+」弹窗：条目点击/悬停后右侧展开二级浮层（命令 / 插件 / 技能） */}
              {plusOpen ? (
                <div
                  className="mc-permmenu mc-plusmenu"
                  ref={plusMenuRef}
                  role="menu"
                  aria-label={t("action.plusMenuAria")}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="mc-plusmenu__item"
                    disabled={disabled || compacting}
                    onClick={() => {
                      setPlusOpen(false);
                      fileInputRef.current?.click();
                    }}
                  >
                    <LuPaperclip size={15} />
                    <span className="mc-plusmenu__label">{t("action.upload")}</span>
                  </button>

                  <div className="mc-plusmenu__divider" />

                  {(["plan", "goal"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="menuitemradio"
                      aria-checked={chatMode === mode}
                      className="mc-plusmenu__item"
                      data-active={chatMode === mode}
                      onClick={() => {
                        setPlusOpen(false);
                        onChangeChatMode(chatMode === mode ? "default" : mode);
                      }}
                    >
                      {mode === "plan" ? <LuListChecks size={15} /> : <LuTarget size={15} />}
                      <span className="mc-plusmenu__label">{t(MODE_LABEL_KEYS[mode])}</span>
                      {chatMode === mode ? (
                        <LuCheck size={14} className="mc-plusmenu__check" />
                      ) : null}
                    </button>
                  ))}

                  <div className="mc-plusmenu__divider" />

                  <div
                    className="mc-plusmenu__row"
                    onMouseEnter={() => showPlusFlyout("plugins")}
                    onMouseLeave={scheduleHidePlusFlyout}
                  >
                    <button
                      type="button"
                      className="mc-plusmenu__item"
                      data-active={plusFlyout === "plugins"}
                      onClick={() =>
                        setPlusFlyout(plusFlyout === "plugins" ? null : "plugins")
                      }
                    >
                      <LuPuzzle size={15} />
                      <span className="mc-plusmenu__label">{t("action.plugins")}</span>
                      <LuChevronRight
                        size={14}
                        className="mc-plusmenu__chevron"
                        data-open={plusFlyout === "plugins"}
                      />
                    </button>
                    {plusFlyout === "plugins" ? (
                      <div
                        className="mc-plusmenu__flyout"
                        role="menu"
                        onMouseEnter={() => showPlusFlyout("plugins")}
                        onMouseLeave={scheduleHidePlusFlyout}
                      >
                        <div className="mc-plusmenu__group">
                          {t("action.pluginsCount", { count: allPluginChoices.length })}
                        </div>
                        {allPluginChoices.map((choice) => {
                          const key = `plugin:${choice.id}`;
                          return (
                            <button
                              key={choice.id}
                              type="button"
                              className="mc-plusmenu__item"
                              disabled={installingKey === key}
                              onClick={() => void attachPluginChoice(choice)}
                            >
                              {choice.iconUrl ? (
                                <img src={choice.iconUrl} alt="" className="mc-plusmenu__icon" />
                              ) : (
                                <LuPuzzle size={14} />
                              )}
                              <span className="mc-plusmenu__label">{choice.title}</span>
                              {installingKey === key ? (
                                <span className="mc-plusmenu__hint">{t("action.installing")}</span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  <div
                    className="mc-plusmenu__row"
                    onMouseEnter={() => showPlusFlyout("skills")}
                    onMouseLeave={scheduleHidePlusFlyout}
                  >
                    <button
                      type="button"
                      className="mc-plusmenu__item"
                      data-active={plusFlyout === "skills"}
                      onClick={() => setPlusFlyout(plusFlyout === "skills" ? null : "skills")}
                    >
                      <LuSparkles size={15} />
                      <span className="mc-plusmenu__label">{t("action.skills")}</span>
                      <LuChevronRight
                        size={14}
                        className="mc-plusmenu__chevron"
                        data-open={plusFlyout === "skills"}
                      />
                    </button>
                    {plusFlyout === "skills" ? (
                      <div
                        className="mc-plusmenu__flyout"
                        role="menu"
                        onMouseEnter={() => showPlusFlyout("skills")}
                        onMouseLeave={scheduleHidePlusFlyout}
                      >
                        <div className="mc-plusmenu__group">
                          {t("action.skillsCount", { count: allSkillChoices.length })}
                        </div>
                        {allSkillChoices.map((choice) => {
                          const key = `skill:${choice.id}`;
                          return (
                            <button
                              key={choice.id}
                              type="button"
                              className="mc-plusmenu__item"
                              disabled={installingKey === key}
                              onClick={() => void attachSkillChoice(choice)}
                            >
                              {choice.iconUrl ? (
                                <img src={choice.iconUrl} alt="" className="mc-plusmenu__icon" />
                              ) : (
                                <LuSparkles size={14} />
                              )}
                              <span className="mc-plusmenu__label">{choice.title}</span>
                              {installingKey === key ? (
                                <span className="mc-plusmenu__hint">{t("action.installing")}</span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="mc-composer__accesswrap">
                <button
                  ref={accessButtonRef}
                  type="button"
                  className="mc-composer__access"
                  aria-haspopup="menu"
                  aria-expanded={accessOpen}
                  aria-label={`${t("permission.title")} · ${t(PERMISSION_LABEL_KEYS[permissionMode])}`}
                  data-mode={permissionMode}
                  title={t("permission.title")}
                  onClick={() => {
                    setPlusOpen(false);
                    setAgentOpen(false);
                    setAccessOpen((open) => !open);
                  }}
                >
                  {permissionIcon(permissionMode)}
                  <span className="mc-composer__pilllabel">
                    {t(PERMISSION_LABEL_KEYS[permissionMode])}
                  </span>
                </button>
                {accessOpen ? (
                  <div
                    className="mc-permmenu"
                    ref={accessMenuRef}
                    role="menu"
                    aria-label={t("permission.title")}
                  >
                    {permissionOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={permissionMode === option.value}
                        className="mc-permmenu__item"
                        data-active={permissionMode === option.value}
                        data-mode={option.value}
                        onClick={() => {
                          onChangePermissionMode(option.value);
                          setAccessOpen(false);
                        }}
                      >
                        <span className="mc-permmenu__label">{option.label}</span>
                        <span className="mc-permmenu__desc">{option.desc}</span>
                        {permissionMode === option.value ? (
                          <LuCheck size={14} className="mc-permmenu__check" />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {onChangeAgentProfile ? (
                <div className="mc-composer__agentwrap">
                  <button
                    ref={agentButtonRef}
                    type="button"
                    className="mc-composer__access mc-composer__agent"
                    aria-haspopup="menu"
                    aria-expanded={agentOpen}
                    aria-label={activeCustomArchitecture?.name ?? agentProfileInfo.label}
                    data-profile={activeAgentProfile}
                    title={t("agent.title", {
                      name: activeCustomArchitecture
                        ? activeCustomArchitecture.name ?? activeCustomArchitecture.id
                        : agentProfileInfo.tagline,
                    })}
                    onClick={() => {
                      setPlusOpen(false);
                      setAccessOpen(false);
                      setAgentOpen((open) => !open);
                    }}
                  >
                    {activeCustomArchitecture ? (
                      <LuPuzzle size={13} />
                    ) : (
                      <AgentProfileIcon size={13} />
                    )}
                    <span className="mc-composer__pilllabel">
                      {activeCustomArchitecture?.name ?? agentProfileInfo.label}
                    </span>
                  </button>
                  {agentOpen ? (
                    <AgentProfilePopover
                      value={activeAgentProfile}
                      onChange={onChangeAgentProfile}
                      onClose={() => setAgentOpen(false)}
                      anchorRef={agentButtonRef}
                      architectures={architectures}
                      activeArchitecture={activeArchitecture}
                      onSelectArchitecture={onSelectArchitecture}
                    />
                  ) : null}
                </div>
              ) : null}
              {chatMode !== "default" ? (
                <button
                  type="button"
                  className="mc-modebadge"
                  data-mode={chatMode}
                  aria-label={t("mode.exitAria", { mode: t(MODE_LABEL_KEYS[chatMode]) })}
                  title={t("mode.exitTitle")}
                  onClick={() => onChangeChatMode("default")}
                >
                  {chatMode === "plan" ? <LuListChecks size={13} /> : <LuTarget size={13} />}
                  <span className="mc-composer__pilllabel">{t(MODE_LABEL_KEYS[chatMode])}</span>
                  <LuX size={12} />
                </button>
              ) : null}
            </div>

            <div className="mc-composer__right">
              {showContext ? (
                <div className="mc-composer__ctxwrap">
                  <ContextMeter
                    usage={contextUsage}
                    buttonRef={ctxButtonRef}
                    onClick={() => setCtxOpen((open) => !open)}
                  />
                  {ctxOpen ? (
                    <ContextPopover
                      usage={contextUsage}
                      streaming={streaming}
                      compacting={compacting}
                      cache={cacheDiagnostics}
                      anchorRef={ctxButtonRef}
                      onCompact={onManualCompact}
                      onClose={() => setCtxOpen(false)}
                    />
                  ) : null}
                </div>
              ) : null}

              <div className="mc-composer__modelwrap">
                <button
                  ref={modelButtonRef}
                  type="button"
                  className="mc-composer__model"
                  aria-haspopup="dialog"
                  aria-expanded={menuOpen}
                  aria-label={`${model}${activeEffort ? ` · ${effortLabel(activeEffort, levels)}` : ""}`}
                  title={`${model}${activeEffort ? ` · ${effortLabel(activeEffort, levels)}` : ""}`}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  {/* 当前服务商品牌 Logo：与模型弹层列表里同一套图标 */}
                  {activeProvider ? (
                    <ProviderIcon template={findTemplate(activeProvider.templateId)} size={16} />
                  ) : null}
                  <span className="mc-truncate mc-composer__modelname">{model}</span>
                  <span className="mc-composer__effort">{effortLabel(activeEffort, levels)}</span>
                  <LuChevronDown size={13} className="mc-composer__modelchev" />
                </button>
                {menuOpen ? (
                  <ModelPopover
                    providers={enabledProviders}
                    activeProviderId={activeProviderId}
                    model={model}
                    levels={levels}
                    effort={activeEffort}
                    anchorRef={modelButtonRef}
                    onChange={onChangeEffort}
                    onChangeActive={onChangeActiveProvider}
                    onManageModels={() => {
                      setMenuOpen(false);
                      onManageModels();
                    }}
                    onClose={() => setMenuOpen(false)}
                  />
                ) : null}
              </div>

              <button
                type="button"
                className="mc-composer__icon mc-composer__polish"
                aria-label={t("action.polish")}
                aria-busy={polishing}
                title={t("action.polish")}
                disabled={polishDisabled}
                onClick={() => void handlePolish()}
              >
                {polishing ? (
                  <LuLoaderCircle size={15} className="mc-composer__polishspin" />
                ) : (
                  <LuWandSparkles size={15} />
                )}
              </button>

              {streaming ? (
                <button
                  type="button"
                  className="mc-sendbtn"
                  aria-label={t("action.stop")}
                  title={t("action.stop")}
                  onClick={onStop}
                >
                  <LuSquare size={13} />
                </button>
              ) : (
                <button
                  type="button"
                  className="mc-sendbtn"
                  aria-label={t("action.send")}
                  title={t("action.send")}
                  disabled={sendDisabled}
                  onClick={() => {
                    if (trySlashCommand()) return;
                    onSend(takeImages());
                  }}
                >
                  <LuArrowUp size={17} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
