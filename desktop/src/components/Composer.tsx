import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { LuArrowRight, LuArrowUp, LuCheck, LuChevronDown, LuChevronLeft, LuChevronRight, LuCircleAlert, LuEye, LuFileText, LuFolder, LuListChecks, LuPaperclip, LuPlus, LuPuzzle, LuRotateCw, LuSearch, LuShield, LuShieldCheck, LuSparkles, LuSquare, LuTarget, LuX } from "react-icons/lu";
import { effortLabel, isEffortValid } from "../effort";
import {
  api,
  installMarketplaceItem,
  listPlugins,
  listSkills,
  type ContextUsage,
  type InstalledSkill,
  type MarketplaceEntry,
  type PlanState,
  type PluginsOverview,
  type ProviderSettings,
  type AgentProfileId,
  type HarnessArchitectureSummary,
  type QueuedPrompt,
  type SessionMode,
} from "../api";
import { agentProfileDisplay } from "../agentProfiles";
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
import { PlanCard } from "./PlanCard";
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
};

/** 与后端 /session/prompt 的 images 字段对齐：最多 3 张，单张 base64 不超过 2.6MB。 */
const MAX_COMPOSER_IMAGES = 3;
const MAX_IMAGE_BASE64 = 2_600_000;
const MAX_IMAGE_EDGE = 2048;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
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
async function prepareImage(file: File): Promise<ComposerImage | string> {
  if (!IMAGE_TYPES.has(file.type)) {
    return `不支持的图片格式：${file.type || file.name}`;
  }
  const original = await readAsDataUrl(file);
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
    return `图片太大：${file.name || "图片"} 自动压缩后仍超过 2MB，请先裁剪或降低分辨率`;
  }
  return {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mimeType,
    data,
    dataUrl,
    name: file.name,
  };
}

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: string; desc: string }> = [
  { value: "read-only", label: "只读", desc: "只读文件、搜索与浏览器，禁止写文件、改文件和运行命令" },
  { value: "ask", label: "每次询问", desc: "写文件、改文件、跑命令前都需要你确认" },
  {
    value: "auto",
    label: "工作区内自动",
    desc: "工作区内的写文件和改文件自动执行；运行命令与越界路径仍然需要确认",
  },
  { value: "full", label: "完全访问", desc: "可读写整台电脑上的文件，自动执行全部工具" },
];

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  "read-only": "只读",
  ask: "每次询问",
  auto: "工作区内自动",
  full: "完全访问",
};

/** 输入 `/` 时弹出的命令列表（选中即执行，带文字的命令交给 trySlashCommand 发送） */
const SLASH_COMMANDS: Array<{
  mode: Exclude<SessionMode, "default">;
  command: string;
  label: string;
  desc: string;
}> = [
  {
    mode: "plan",
    command: "/plan",
    label: "计划模式",
    desc: "只读调研，先把实施计划写成 plans/ 下的文档，等你确认",
  },
  {
    mode: "goal",
    command: "/goal",
    label: "目标模式",
    desc: "围绕目标连续推进，用 update_plan 跟踪进度",
  },
];

/** 会话模式菜单项与徽章文案（plan / goal 两种）。 */
const MODE_LABELS: Record<Exclude<SessionMode, "default">, string> = {
  plan: "计划模式",
  goal: "目标模式",
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
  onNew,
  onClose,
}: {
  projects: string[];
  projectNames: Record<string, string>;
  active: string;
  onPick: (cwd: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

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
    <div className="mc-projmenu" ref={ref} role="menu" aria-label="切换项目">
      <label className="mc-projmenu__search">
        <LuSearch size={13} />
        <input
          value={query}
          placeholder="搜索项目"
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
      </label>
      <div className="mc-projmenu__sep" />
      <div className="mc-projmenu__list">
        {filtered.length === 0 ? (
          <p className="mc-projmenu__empty">没有匹配的项目</p>
        ) : (
          filtered.map((cwd) => (
            <button
              key={cwd}
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
          ))
        )}
      </div>
      <div className="mc-projmenu__sep" />
      <button type="button" role="menuitem" className="mc-projmenu__item" onClick={onNew}>
        <LuPlus size={14} className="mc-projmenu__icon" />
        新建项目
      </button>
    </div>
  );
}

export function Composer({
  value,
  onChange,
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
  onManualCompact,
  projects,
  projectNames,
  onSwitchProject,
  onNewProject,
  plan,
}: {
  value: string;
  onChange: (value: string) => void;
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
  /** 手动压缩：POST /session/compact，由 App 处理错误展示 */
  onManualCompact: () => Promise<void>;
  /** 已知项目列表 + 自定义显示名（项目切换菜单） */
  projects: string[];
  projectNames: Record<string, string>;
  /** 切换项目（工作区）：保存设置并新建会话 */
  onSwitchProject: (cwd: string) => void;
  /** 新建项目：弹目录选择器 */
  onNewProject: () => void;
  /** 当前会话任务计划：显示在输入框上方 */
  plan?: PlanState | null;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  const addImages = async (files: File[]) => {
    const room = MAX_COMPOSER_IMAGES - images.length;
    if (room <= 0) {
      onError?.(`一条消息最多附 ${MAX_COMPOSER_IMAGES} 张图片`);
      return;
    }
    const picked = files.filter((file) => file.type.startsWith("image/")).slice(0, room);
    if (!picked.length) {
      onError?.("只能附加图片文件");
      return;
    }
    if (files.length > room) onError?.(`一条消息最多附 ${MAX_COMPOSER_IMAGES} 张图片`);
    for (const file of picked) {
      const prepared = await prepareImage(file).catch((error: unknown) =>
        error instanceof Error ? error.message : "读取图片失败",
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
        onError?.(`读取文件路径失败：${file.name}`);
        continue;
      }
      // 拖入目录时 Chromium 给的是一条 size=0、无 type 的伪文件：挂上卡片也读不出内容
      if (file.size === 0 && !file.type) {
        onError?.(`跳过空文件或目录：${file.name}`);
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
        title: marketByKey.get(`plugin:${plugin.id}`)?.name ?? plugin.id,
        description: plugin.error ? `加载失败：${plugin.error}` : "本地插件",
        iconUrl: marketIcons[`plugin:${plugin.id}`],
        installed: true,
      }));
    return [...fromMarket, ...custom];
  }, [marketEntries, pluginsOverview, marketByKey, marketIcons]);

  /** 插件注册的命令（source = plugin:<id>），带市场图标与展示名 */
  const pluginCommandItems = useMemo<SlashPluginItem[]>(() => {
    if (!pluginsOverview) return [];
    return pluginsOverview.commands
      .filter((item) => item.source.startsWith("plugin:"))
      .map((item) => {
        const pluginId = item.source.slice("plugin:".length);
        return {
          kind: "plugin" as const,
          command: `/${item.name}`,
          commandName: item.name,
          pluginId,
          title: marketByKey.get(`plugin:${pluginId}`)?.name ?? pluginId,
          description: item.description ?? "",
          iconUrl: marketIcons[`plugin:${pluginId}`],
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
    ).map((item) => ({ kind: "mode", mode: item.mode, command: item.command, label: item.label, desc: item.desc }));
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
  }, [slashQuery, markdownCommandItems, pluginCommandItems, skillItems]);
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

  /** + 菜单里选中插件命令：挂 chip（无 chip 回调时退回填命令文本） */
  const attachPluginCommand = (chip: {
    id: string;
    name: string;
    command: string;
    iconUrl?: string;
  }) => {
    setPlusOpen(false);
    if (onAttachCommand) onAttachCommand(chip);
    else onChange(`/${chip.command} `);
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
    else onChange(`【技能引用】${choice.title} · ${choice.id}\n\n`);
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
    else onChange(`【插件引用】${choice.title} · ${choice.id}\n\n`);
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
      `【插件命令】${command.title} · ${command.pluginId} · ${command.commandName}\n\n/${command.commandName}${args ? ` ${args}` : ""}`,
    );
    return true;
  };

  // 只挂附件、不写字也能发（"看看这份文件"是隐含意图）。技能/插件 chip 不算：
  // 它们需要配合需求描述，单独发出去模型没任务可做。
  const hasAttachments = Boolean(chips?.some((chip) => chip.kind === "file"));
  const sendDisabled =
    disabled || compacting || (!value.trim() && !images.length && !hasAttachments);

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
        questions.map((_, index) => finalAnswers[index]?.trim() || "（未回答）"),
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
          index < step ? askAnswers[index]?.trim() || "（未回答）" : "（未回答）",
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
            <div className="mc-planconfirm" role="dialog" aria-label="回答问题">
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
                <p className="mc-planconfirm__sub">选择一个答案，或在下方直接输入 · 选择后自动进入下一题</p>
              ) : (
                <p className="mc-planconfirm__sub">选择一个答案，或在下方直接输入</p>
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
                  placeholder="其他想法，Enter 直接进入下一题"
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
                      ‹ 上一题
                    </button>
                  ) : null}
                  <button type="button" className="mc-planconfirm__back" onClick={skipRest}>
                    不回答，跳过剩余 ›
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
            <div className="mc-planconfirm" role="dialog" aria-label="确认计划">
                <button
                  type="button"
                  className="mc-planconfirm__exit"
                  aria-label="退出计划模式"
                  title="退出计划模式"
                  onClick={() => onChangeChatMode("default")}
                >
                  <LuX size={13} />
                </button>
                <p className="mc-planconfirm__title">确认按此计划执行？</p>
                <p className="mc-planconfirm__sub">确认后，我将按此计划执行并输出内容</p>
                <button
                  type="button"
                  className="mc-planconfirm__option"
                  data-primary="true"
                  disabled={disabled || compacting}
                  onClick={() => onConfirmPlan?.()}
                >
                  <span className="mc-planconfirm__num">1</span>
                  <span className="mc-planconfirm__label">开始执行</span>
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
                    placeholder="调整计划，补充内容告诉我如何调整"
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
                    aria-label="发送调整"
                    title="发送调整"
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
        {plan && plan.steps.length ? <PlanCard plan={plan} /> : null}

        {/* 工作区缺失（未选择 / 目录已删）：同一位置回退成「选择工作区」，点击打开目录选择器 */}
        {!workspace || workspaceAvailable === false ? (
          <div className="mc-composer__context">
            <button
              type="button"
              className="mc-composer__pickws"
              aria-label="选择工作区"
              title="选择工作区"
              onClick={onNewProject}
            >
              <LuFolder size={14} />
              <span>选择工作区</span>
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
                title={workspace}
                onClick={() => setProjectOpen((open) => !open)}
              >
                <span className="mc-truncate">{projectNames[workspace]?.trim() || baseName(workspace)}</span>
              </button>
            </div>

            {projectOpen ? (
              <ProjectMenu
                projects={projects}
                projectNames={projectNames}
                active={workspace}
                onPick={(cwd) => {
                  setProjectOpen(false);
                  onSwitchProject(cwd);
                }}
                onNew={() => {
                  setProjectOpen(false);
                  onNewProject();
                }}
                onClose={() => setProjectOpen(false)}
              />
            ) : null}
          </div>
        ) : null}

        {recoveredPrompts.length ? (
          <div
            className="mc-queuedlist mc-queuedlist--recovered"
            role="status"
            aria-label="上次未发送的消息"
          >
            <div className="mc-queuedlist__head">上次退出时还没发送</div>
            {recoveredPrompts.map((item) => (
              <div className="mc-queued" key={item.id}>
                <span className="mc-queued__text" title={queuedPreview(item.text)}>
                  {queuedPreview(item.text)}
                </span>
                <div className="mc-queued__actions">
                  <button
                    type="button"
                    className="mc-queued__action"
                    title="作为新消息发送"
                    onClick={() => onSendRecovered(item)}
                  >
                    发送
                  </button>
                  <button
                    type="button"
                    className="mc-queued__action mc-queued__action--danger"
                    title="丢弃这条消息"
                    onClick={() => onDiscardRecovered(item.id)}
                  >
                    丢弃
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* 技能引用 chip：市场「使用」带过来的（已移入输入框内部） */}

        {queuedPrompts.length ? (
          <div className="mc-queuedlist" role="status" aria-label="排队中的消息">
            {queuedPrompts.map((item) => (
              <div className="mc-queued" key={item.id}>
                <span className="mc-queued__text" title={queuedPreview(item.text)}>
                  {queuedPreview(item.text)}
                </span>
                <div className="mc-queued__actions">
                  <button
                    type="button"
                    className="mc-queued__action"
                    title="中止当前回复，立即发送这条消息"
                    onClick={() => onSteerQueued(item.id)}
                  >
                    强制插话
                  </button>
                  <button
                    type="button"
                    className="mc-queued__action mc-queued__action--danger"
                    title="从队列中删除"
                    onClick={() => onRemoveQueued(item.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* `/` 命令面板：贴在输入框上方，Enter/Tab 选中，Esc 关闭；插件在上、技能在下 */}
        {slashOpen ? (
          <div className="mc-slashmenu" role="listbox" aria-label="命令">
            {slashItems.map((item, index) => {
              const previous = slashItems[index - 1];
              const showGroup = !previous || previous.kind !== item.kind;
              const key = item.kind === "skill" ? `skill:${item.id}` : `${item.kind}:${item.command}`;
              const groupLabel =
                item.kind === "mode"
                  ? "模式"
                  : item.kind === "markdown"
                    ? "命令"
                    : item.kind === "plugin"
                      ? "插件"
                      : "技能";
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
                        {chatMode === item.mode ? `退出${item.label}` : `${item.label} · ${item.desc}`}
                      </span>
                    ) : item.kind === "markdown" ? (
                      <span className="mc-slashmenu__desc">{item.description || "命令"}</span>
                    ) : null}
                  </button>
                </Fragment>
              );
            })}
          </div>
        ) : null}

        {mention ? (
          <div className="mc-mention" role="listbox" aria-label="引用工作区文件">
            <div className="mc-mention__head">
              {mentionScope.dir ? (
                <button
                  type="button"
                  className="mc-mention__crumb"
                  title="返回上一层"
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
                  <span>工作区根目录</span>
                </>
              )}
              {mentionFailed ? <span className="mc-mention__hint">读取失败</span> : null}
              <button
                type="button"
                className="mc-mention__refresh"
                title="刷新列表"
                aria-label="刷新列表"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setMentionReload((current) => current + 1)}
              >
                <LuRotateCw size={13} />
              </button>
            </div>
            {mentionEntries === null ? (
              <p className="mc-mention__empty">加载中…</p>
            ) : mentionResults.length === 0 ? (
              <p className="mc-mention__empty">
                {mentionFailed
                  ? "无法读取目录"
                  : mentionScope.filter.trim()
                    ? "没有匹配的文件"
                    : "这个目录是空的"}
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
            <div className="mc-attach" role="list" aria-label="待发送图片">
              {images.map((image) => (
                <div className="mc-attach__item" role="listitem" key={image.id}>
                  <img className="mc-attach__thumb" src={image.dataUrl} alt={image.name ?? "图片"} />
                  <button
                    type="button"
                    className="mc-attach__remove"
                    aria-label="移除图片"
                    title="移除"
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
            <div className="mc-composer__skillrow" role="status" aria-label="已引用的技能、插件与附件">
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
                    aria-label={`移除 ${chip.name}`}
                    title={`移除 ${chip.name}`}
                    onClick={() => onRemoveChip?.(chip)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <textarea
            ref={textareaRef}
            className="mc-composer__input"
            value={value}
            rows={2}
            onChange={(event) => {
              setSlashHidden(false);
              onChange(event.target.value);
              updateMention(event.target.value, event.target.selectionStart);
            }}
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
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (trySlashCommand()) return;
                onSend(takeImages());
              }
            }}
            placeholder={
              !canUse
                ? "请先完成配置"
                : compacting
                  ? "正在压缩对话历史，完成后可继续发送"
                  : planDocPath
                    ? "调整计划内容，发送后模型将继续修改计划…"
                    : streaming
                      ? "输入后按 Enter 排队发送"
                      : "输入 @ 引用项目文件；图片/任意文件可直接拖入（含工作区外）"
            }
            disabled={disabled || compacting}
          />

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
                  aria-label="更多操作"
                  aria-haspopup="menu"
                  aria-expanded={plusOpen}
                  title="添加附件 / 切换模式"
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
                  aria-label="添加、引用与命令"
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
                    <span className="mc-plusmenu__label">上传附件</span>
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
                      <span className="mc-plusmenu__label">{MODE_LABELS[mode]}</span>
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
                      <span className="mc-plusmenu__label">插件</span>
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
                        <div className="mc-plusmenu__group">插件（{allPluginChoices.length}）</div>
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
                                <span className="mc-plusmenu__hint">安装中…</span>
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
                      <span className="mc-plusmenu__label">技能</span>
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
                        <div className="mc-plusmenu__group">技能（{allSkillChoices.length}）</div>
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
                                <span className="mc-plusmenu__hint">安装中…</span>
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
                  data-mode={permissionMode}
                  title="工具执行权限"
                  onClick={() => {
                    setPlusOpen(false);
                    setAgentOpen(false);
                    setAccessOpen((open) => !open);
                  }}
                >
                  {permissionIcon(permissionMode)}
                  {PERMISSION_LABELS[permissionMode]}
                </button>
                {accessOpen ? (
                  <div className="mc-permmenu" ref={accessMenuRef} role="menu" aria-label="工具执行权限">
                    {PERMISSION_OPTIONS.map((option) => (
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
                    data-profile={activeAgentProfile}
                    title={
                      activeCustomArchitecture
                        ? `主 Agent：${activeCustomArchitecture.name ?? activeCustomArchitecture.id}`
                        : `主 Agent：${agentProfileInfo.tagline}`
                    }
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
                    {activeCustomArchitecture?.name ?? agentProfileInfo.label}
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
                  aria-label={`${MODE_LABELS[chatMode]}，点击退出`}
                  title="点击退出该模式"
                  onClick={() => onChangeChatMode("default")}
                >
                  {chatMode === "plan" ? <LuListChecks size={13} /> : <LuTarget size={13} />}
                  {MODE_LABELS[chatMode]}
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
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <span className="mc-truncate">{model}</span>
                  <span className="mc-composer__effort">{effortLabel(activeEffort, levels)}</span>
                  <LuChevronDown size={13} />
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

              {streaming ? (
                <button type="button" className="mc-sendbtn" aria-label="停止" title="停止" onClick={onStop}>
                  <LuSquare size={13} />
                </button>
              ) : (
                <button
                  type="button"
                  className="mc-sendbtn"
                  aria-label="发送"
                  title="发送"
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
