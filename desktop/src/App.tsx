import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  api,
  checkForUpdates,
  createHarnessArchitecture,
  deleteHarnessArchitecture,
  downloadUpdate,
  fetchHarnessArchitectures,
  getSessionChangesSummary,
  gitStatus,
  importFontFile,
  listCustomFonts,
  openInstaller,
  onUpdateProgress,
  renameHarnessArchitecture,
  setSpeechStyle,
  type AppInfo,
  type ChatMessage,
  type CompactionPoint,
  type CacheDiagnostics,
  type ContextUsage,
  type HarnessArchitectureSummary,
  type GitStatus,
  type MeowEvent,
  type PendingApproval,
  type PlanState,
  type Preferences,
  type ProviderSettings,
  type QueuedPrompt,
  type RewindMode,
  type RewindPlan,
  type SessionCheckpoint,
  type SessionChangeSummary,
  type SessionSummary,
  type SessionMode,
  type SessionWorktree,
  type SessionSearchHit,
  type SessionSearchSnippet,
  type AgentProfileId,
  type Settings,
  type SubagentRun,
  type SubagentSummary,
  type SubagentTranscript,
  type ThemePreference,
  type TimelineItem,
  type TimelineTool,
  type TurnMetrics,
  type UiState,
  type UpdateInfo,
  type UsageSummary,
  type WorkflowRoadmap,
  shouldRecommendCompaction,
} from "./api";
import { setModelProfiles, type ModelProfile } from "./modelProfiles";
import { AppShell } from "./components/AppShell";
import { GlobalTooltip } from "./components/ui/GlobalTooltip";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { BootSplash } from "./components/BootSplash";
import { ChatHeader } from "./components/ChatHeader";
import { WorkspaceOverview } from "./components/WorkspaceOverview";
import { CloseConfirmDialog } from "./components/CloseConfirmDialog";
import { ContextWarningBanner } from "./components/ContextWarningBanner";
import { Composer, type ComposerChip, type ComposerImage } from "./components/Composer";
import { ConversationPanel } from "./components/ConversationPanel";
import { RightPanel } from "./components/RightPanel";
import { QuickOpenDialog } from "./components/panel/QuickOpenDialog";
import { SessionSearchDialog } from "./components/SessionSearchDialog";
import { MessageList } from "./components/MessageList";
import { RewindDialog } from "./components/RewindDialog";
import { Rail } from "./components/Rail";
import { GitBody } from "./components/git/GitBody";
import { GitNav } from "./components/git/GitNav";
import { BranchDialog } from "./components/git/BranchDialog";
import { useGitView } from "./git/useGitView";
import { useWorkspaceGit } from "./git/useWorkspaceGit";
import { filterUncommittedSessionChanges } from "./git/change-filter";
import { SettingsBody, SettingsNav, type SettingsSectionId } from "./components/settings/SettingsPage";
import {
  ArchitectureBody,
  ArchitectureNav,
  type HarnessAgentEntry,
} from "./components/architecture/ArchitecturePage";
import { MarketplaceNav, type MarketTab } from "./components/marketplace/MarketplaceNav";
import { MarketplaceBody } from "./components/marketplace/MarketplaceBody";
import { Onboarding } from "./components/onboarding/Onboarding";
import { TitleBar } from "./components/TitleBar";
import { Toast } from "./components/Toast";
import "./components/UndoBar.css";
import { UpdateModal } from "./components/UpdateModal";
import { ThemeProvider } from "./theme/theme";
import { useSideTabs, type SideTab, type SideTabOpen } from "./panel/useSideTabs";
import {
  clearRunningCompaction,
  markCompactionCompleted,
  markCompactionStarted,
  timelineFromHistory,
} from "./timeline";
import { applyTimelineEvent, finalizeStreamingAssistants } from "./timeline-events";
import { baseName } from "./util";
import { applyLanguage, getStoredPreference, syncLanguageFromSettings } from "./i18n";
import {
  applySample,
  EMPTY_SAMPLE,
  hitRate,
  isCacheBust,
  mergeSample,
  retractSample,
  totalsFromServer,
  type UsageSample,
} from "./usage-meter";
import i18n from "./i18n";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

type View = "chat" | "settings" | "plugins" | "architecture" | "git";
/**
 * 工具审批模式：read-only = 只读；ask = 每次询问；auto = 工作区内自动（可写根内写/改与常规命令不弹窗，高危命令仍弹）；
 * full = 完全访问（整机路径放行）。会话级，切会话重置。
 */
export type PermissionMode = "read-only" | "ask" | "auto" | "full";

/** 静默下载更新在导航栏左下角呈现的状态 */
type SilentUpdateState =
  | { status: "hidden" }
  | { status: "downloading"; percent: number }
  | { status: "done"; path: string }
  | { status: "error" };

const DEFAULT_PROVIDER: ProviderSettings = {
  id: "provider-local",
  name: "OpenAI-compatible provider",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
};

let timelineCounter = 0;
function nextKey(prefix: string): string {
  timelineCounter += 1;
  return `${prefix}-${timelineCounter}`;
}

/** 模型流式生成工具参数时的进度文案（主对话与子 Agent 共用）。 */
function toolPreparingLabel(t: TFunction, count?: number, names?: string[]): string | null {
  const total = Math.max(count ?? 0, names?.length ?? 0);
  if (!total) return null;
  const allTask = Boolean(names?.length) && names!.every((name) => name === "task");
  if (allTask) return t("status.preparingSubagents", { count: total });
  // 正在准备的只有一个写/改文件的调用：直接说「写入中 / 修改中」，
  // 不用笼统的“工具调用”（参数还在流式生成，此时拿不到文件名）
  if (names?.length === total) {
    const unique = new Set(names);
    if (unique.size === 1) {
      const only = names[0];
      if (only === "write_file") return t("status.preparingWrites");
      if (only === "edit_file" || only === "multi_edit") return t("status.preparingEdits");
    }
  }
  return t("status.preparingTools", { count: total });
}

/**
 * 正在生成参数的写类工具：返回 "write_file" / "edit_file" 让聊天区先渲染一条
 * 「写入中 / 修改中」的占位工具行（此时参数还没流完，拿不到文件名）。
 * 混合批次或非写类工具返回 null。
 */
function preparingWriteTool(
  count?: number,
  names?: string[],
  path?: string,
): { tool: "write_file" | "edit_file"; path?: string } | null {
  const total = Math.max(count ?? 0, names?.length ?? 0);
  if (!names?.length || names.length !== total) return null;
  const withPath = path ? { path } : {};
  if (names.every((name) => name === "write_file")) return { tool: "write_file", ...withPath };
  if (names.every((name) => name === "edit_file" || name === "multi_edit")) {
    return { tool: "edit_file", ...withPath };
  }
  return null;
}

/** plans/ 下的写工具：用于计划页签的「写入中」状态（与后端门控同一判定范围） */
const PLAN_WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);

/** 从工具参数里取 plans/ 下的目标路径（工作区相对）；不在 plans/ 内返回 null。 */
function planDocPathOf(tool: string, input: unknown): string | null {
  if (!PLAN_WRITE_TOOLS.has(tool)) return null;
  const args = (input ?? {}) as Record<string, unknown>;
  const raw: string[] = [];
  if (typeof args.path === "string") raw.push(args.path);
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      const value = (edit as Record<string, unknown> | null)?.path;
      if (typeof value === "string") raw.push(value);
    }
  }
  if (!raw.length) return null;
  const normalized = raw.map((item) => item.replace(/\\/g, "/").replace(/^\.\//, ""));
  // 绝对路径交给后端事件（plan_documented 会带相对路径），这里只处理 plans/ 前缀
  const inPlans = normalized.every(
    (item) => item.startsWith("plans/") && !item.split("/").includes(".."),
  );
  return inPlans ? normalized[0] : null;
}

const EMPTY_TURN_METRICS: TurnMetrics = {
  inputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  outputTokens: null,
  tokensPerSecond: null,
  responseMs: null,
  firstTokenMs: null,
  cacheHitRate: null,
};

const EMPTY_CACHE_DIAGNOSTICS: CacheDiagnostics = {
  lastRound: null,
  lastState: null,
  lastReason: null,
  busts: 0,
  lastBustDrop: null,
  rebuilds: {},
};

/** 主聊天区最小宽度：左右栏拖拽再大也不能把它压没 */
const CHAT_MIN_WIDTH = 360;
/** 侧栏之外的固定占位：rail 64 + 右侧留白 8 + 列间距/拖拽条约 16 */
const LAYOUT_CHROME_WIDTH = 88;
const INSPECTOR_MIN_WIDTH = 240;
const LIST_MIN_WIDTH = 220;
const LIST_MAX_WIDTH = 560;
/** 推给托盘菜单的会话上限：主进程只列「最近 3 条 + 更多」，多推没意义 */
const TRAY_SYNC_LIMIT = 30;

/** 扣除固定占位和聊天区最小宽度后，实际可分给左右面板的像素 */
function panelWidthBudget(): number {
  return Math.max(0, window.innerWidth - LAYOUT_CHROME_WIDTH - CHAT_MIN_WIDTH);
}

/** 右侧面板宽度：先扣掉左栏和聊天区最小宽度，空间不足时允许缩到 0（聊天区优先） */
function clampInspectorWidth(value: number, listWidth: number): number {
  // 窗口隐藏 / 最小化时 innerWidth 可能是 0：不要据此把面板压成 0
  if (window.innerWidth <= 0) return value;
  const upper = Math.max(0, panelWidthBudget() - listWidth);
  const lower = Math.min(INSPECTOR_MIN_WIDTH, upper);
  return Math.min(Math.max(lower, value), upper);
}

/** 左栏宽度：220–560，同时必须给右侧面板和聊天区留出空间 */
function clampListWidth(
  value: number,
  inspectorWidth: number,
  inspectorVisible: boolean,
): number {
  if (window.innerWidth <= 0) return value;
  const upper = Math.min(
    LIST_MAX_WIDTH,
    Math.max(0, panelWidthBudget() - (inspectorVisible ? inspectorWidth : 0)),
  );
  const lower = Math.min(LIST_MIN_WIDTH, upper);
  return Math.min(Math.max(lower, value), upper);
}

/**
 * 拖拽指示线跟随鼠标纵向位置：把鼠标在热区里的相对高度写进 --cursor-y，
 * CSS 用它定位那条竖线（不是固定居中）。
 */
function trackResizeCursor(event: ReactPointerEvent<HTMLDivElement>) {
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  if (rect.height <= 0) return;
  const ratio = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  el.style.setProperty("--cursor-y", `${(ratio * 100).toFixed(2)}%`);
}

export default function App() {
  const { t } = useTranslation("shell");
  const [ready, setReady] = useState(false);
  /** 启动画面至少展示约 1 秒，避免数据秒回时 Logo 一闪而过 */
  const [splashDone, setSplashDone] = useState(false);
  /** 首次启动引导是否打开（设置页也可重新打开） */
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [session, setSession] = useState<{
    id: string;
    cwd: string;
    filePath: string;
    createdAt: string;
    worktree?: SessionWorktree | null;
  } | null>(null);
  /** 当前工作区目录是否可用：null = 正在校验，false = 已被删除/不存在 */
  const [workspaceAvailable, setWorkspaceAvailable] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** 正在切换会话：时间线暂时为空时不显示欢迎页，避免闪一下 */
  const [sessionLoading, setSessionLoading] = useState(false);
  /** 正在切换/新建会话：先收起上一个会话的审批弹窗，等目标会话加载完再按需恢复 */
  const [sessionSwitching, setSessionSwitching] = useState(false);
  /** 新对话的 worktree 意图：首次发送时才真正创建，避免空 worktree 残留 */
  const [worktreeIntent, setWorktreeIntent] = useState(false);
  /** 打开 worktree 开关前的 git 预检中 */
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  /** 当前会话 cwd 的 git 分支：null = 不是仓库 / 还没查到，不显示分支胶囊 */
  const [gitBranch, setGitBranch] = useState<{ name: string; detached: boolean } | null>(null);
  /** git 动作计数（暂存/提交/切分支）：变了就重新拉一次分支名 */
  const [gitRevision, setGitRevision] = useState(0);
  /** 当前会话标题：AI 生成（session_title 事件）或手动设置；null = 还没生成 */
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanState | null>(null);
  /** 输入框悬浮胶囊：本会话已修改文件（只取统计，不含 diff；渲染前按 git status 过滤已提交） */
  const [sessionChanges, setSessionChanges] = useState<SessionChangeSummary[]>([]);
  /** 右上角工作区概览：默认收起，子 Agent 启动时自动展开 */
  const [workspaceOverviewOpen, setWorkspaceOverviewOpen] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const changesRefreshTimer = useRef<number | null>(null);
  const changesRequestSeq = useRef(0);

  const refreshSessionChanges = useCallback(async () => {
    const seq = ++changesRequestSeq.current;
    try {
      const result = await getSessionChangesSummary();
      // 切会话/连续 file_changed 时只接受最后一次请求，避免旧响应覆盖新会话
      if (seq === changesRequestSeq.current) setSessionChanges(result.changes);
    } catch {
      // 保留上一次统计，避免本地服务瞬时失败让胶囊闪烁
    }
  }, []);

  const scheduleSessionChangesRefresh = useCallback(() => {
    if (changesRefreshTimer.current !== null) window.clearTimeout(changesRefreshTimer.current);
    changesRefreshTimer.current = window.setTimeout(() => {
      changesRefreshTimer.current = null;
      void refreshSessionChanges();
    }, 250);
  }, [refreshSessionChanges]);

  const toggleWorkspaceOverview = useCallback(
    () => setWorkspaceOverviewOpen((value) => !value),
    [],
  );
  const closeWorkspaceOverview = useCallback(() => setWorkspaceOverviewOpen(false), []);

  useEffect(() => {
    sessionIdRef.current = session?.id ?? null;
  }, [session?.id]);

  useEffect(() => {
    setSessionChanges([]);
    if (!session?.id) return;
    void refreshSessionChanges();
  }, [session?.id, refreshSessionChanges]);

  useEffect(
    () => () => {
      if (changesRefreshTimer.current !== null) window.clearTimeout(changesRefreshTimer.current);
    },
    [],
  );
  /** 最近一次 AI 回合的响应统计（右侧会话信息）：token / 速度 / 耗时 */
  const [turnMetrics, setTurnMetrics] = useState<TurnMetrics | null>(null);
  /** 前缀缓存诊断：最终 usage 事件聚合（弹层缓存行 + 首页失配计数） */
  const [cacheDiagnostics, setCacheDiagnostics] = useState<CacheDiagnostics>(EMPTY_CACHE_DIAGNOSTICS);
  /** cache-bust 检测基线：按模型记上一条最终样本的命中读数（换模型自动换基线） */
  const lastCacheReadRef = useRef<{ model: string; read: number } | null>(null);
  /** 最近一次压缩质量观测（窗口结算后才有值） */
  /** 回合计时（performance.now）：开始、首字、当轮首字；usage 到达即结算一轮速度 */
  const turnStartAtRef = useRef<number | null>(null);
  const turnFirstTokenAtRef = useRef<number | null>(null);
  const roundFirstTokenAtRef = useRef<number | null>(null);
  /** 会话累计用量：按 roundId 保存最近样本再派生，流中实时值与最终真值不会双计 */
  const usageSamplesRef = useRef<Map<string, UsageSample>>(new Map());
  const usageTotalsRef = useRef<UsageSample>({ ...EMPTY_SAMPLE });
  /** 旧服务端不发 roundId：给每条事件发一个唯一 id，退回「逐条累加」语义 */
  const legacyUsageRoundRef = useRef(0);
  /** 子 Agent 页签的用量样本（key = agentId:roundId），同样替换式累加 */
  const subagentUsageSamplesRef = useRef<Map<string, UsageSample>>(new Map());
  /** 已提示过的缓存诊断状态（sessionId:state），避免每轮重复 */
  const cacheNoticeRef = useRef<string | null>(null);
  /** 上下文压缩进行中的会话（compaction_started → completed/failed）：切换对话后仍保留 */
  const [compactingSessionIds, setCompactingSessionIds] = useState<string[]>([]);
  const compactingSessionIdsRef = useRef<Set<string>>(new Set());
  const setCompactingSessions = useCallback((ids: string[]) => {
    const unique = [...new Set(ids)];
    compactingSessionIdsRef.current = new Set(unique);
    setCompactingSessionIds(unique);
  }, []);
  const addCompactingSession = useCallback((id: string) => {
    if (compactingSessionIdsRef.current.has(id)) return;
    const next = new Set(compactingSessionIdsRef.current);
    next.add(id);
    compactingSessionIdsRef.current = next;
    setCompactingSessionIds([...next]);
  }, []);
  const removeCompactingSession = useCallback((id: string) => {
    if (!compactingSessionIdsRef.current.has(id)) return;
    const next = new Set(compactingSessionIdsRef.current);
    next.delete(id);
    compactingSessionIdsRef.current = next;
    setCompactingSessionIds([...next]);
  }, []);
  /** 当前会话是否在压缩 */
  const compacting = Boolean(session && compactingSessionIds.includes(session.id));
  /** 当前会话的上下文占用（输入框圆圈 + 弹层） */
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  /** 用户忽略了 85% 压缩提示；占用回落到阈值以下或切会话时重置 */
  const [contextWarningDismissed, setContextWarningDismissed] = useState(false);
  /** 关闭确认弹窗（closeAction=ask 时主进程唤起） */
  const [closeAsk, setCloseAsk] = useState(false);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  /** 模型正在流式生成工具调用参数（还没有 tool_started 事件） */
  const [toolProgress, setToolProgress] = useState<{
    count: number;
    names?: string[];
    /** 参数里已经能完整读出的目标路径 */
    path?: string;
  } | null>(null);
  /** 每个会话的输入草稿；切走/重启后按会话恢复 */
  const [drafts, setDrafts] = useState<Record<string, { text: string; updatedAt: string }>>({});
  const activeDraftKey = session?.id ?? null;
  const input = activeDraftKey ? (drafts[activeDraftKey]?.text ?? "") : "";
  const setInput = useCallback(
    (value: string | ((current: string) => string)) => {
      if (!activeDraftKey) return;
      setDrafts((previous) => {
        const current = previous[activeDraftKey]?.text ?? "";
        const text = typeof value === "function" ? value(current) : value;
        if (!text.trim()) {
          if (!(activeDraftKey in previous)) return previous;
          const next = { ...previous };
          delete next[activeDraftKey];
          return next;
        }
        return {
          ...previous,
          [activeDraftKey]: { text, updatedAt: new Date().toISOString() },
        };
      });
    },
    [activeDraftKey],
  );
  /** 上次进程退出时未交付的排队消息（服务端恢复，只展示不自动执行） */
  const [recoveredPrompts, setRecoveredPrompts] = useState<QueuedPrompt[]>([]);
  const [, setLastTurn] = useState<{
    status: "completed" | "aborted" | "error" | "interrupted";
    error?: string;
  } | null>(null);
  /** ui-state.json 已 hydration；之前不写盘，避免默认值覆盖 */
  const [uiHydrated, setUiHydrated] = useState(false);
  /** 所有正在生成的主会话 id（服务端每个会话独立 runtime，切走也会继续跑） */
  const [runningSessionIds, setRunningSessionIds] = useState<string[]>([]);
  const runningSessionIdsRef = useRef<Set<string>>(new Set());
  /** 回滚预览对话框（dryRun 产出的 plan；确认后重新预览并执行） */
  const [rewindDialog, setRewindDialog] = useState<{ plan: RewindPlan; busy: boolean } | null>(null);
  const rewindDialogRef = useRef<{ plan: RewindPlan; busy: boolean } | null>(null);
  rewindDialogRef.current = rewindDialog;
  /** 当前会话最近一次可撤销的回滚（横幅入口；切换/回滚后刷新） */
  const [undoableRewind, setUndoableRewind] = useState<
    { rewindId: string; mode: RewindMode; fileCount: number } | null
  >(null);
  const setRunningSessions = useCallback((ids: string[]) => {
    const unique = [...new Set(ids)];
    runningSessionIdsRef.current = new Set(unique);
    setRunningSessionIds(unique);
  }, []);
  const addRunningSession = useCallback((id: string) => {
    if (runningSessionIdsRef.current.has(id)) return;
    const next = new Set(runningSessionIdsRef.current);
    next.add(id);
    runningSessionIdsRef.current = next;
    setRunningSessionIds([...next]);
  }, []);
  const removeRunningSession = useCallback((id: string) => {
    if (!runningSessionIdsRef.current.has(id)) return;
    const next = new Set(runningSessionIdsRef.current);
    next.delete(id);
    runningSessionIdsRef.current = next;
    setRunningSessionIds([...next]);
  }, []);
  const streaming = Boolean(session && runningSessionIds.includes(session.id));
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  /** 本地队列版本：加载/对账期间用户增删了排队项，就不再用旧快照覆盖 */
  const queueVersionRef = useRef(0);
  const replaceQueuedPrompts = useCallback((items: QueuedPrompt[]) => {
    queueVersionRef.current += 1;
    queuedPromptsRef.current = items;
    setQueuedPrompts(items);
  }, []);
  const [view, setView] = useState<View>("chat");
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("general");
  const [architectureAgentId, setArchitectureAgentId] = useState<string | null>(null);
  const [architectureAgents, setArchitectureAgents] = useState<HarnessAgentEntry[]>([]);
  /** 架构页左栏选中项：内置档位或自定义架构 id */
  const [architectureProfile, setArchitectureProfile] = useState<string>("standard");
  /** 左栏「主 Agent」列表：内置三档 + 工作区里的自定义架构 */
  const [harnessArchitectures, setHarnessArchitectures] = useState<HarnessArchitectureSummary[]>([]);
  /** 聊天框当前生效的架构图 id（自定义架构 custom-*，或档位名）：与后端会话设置一致 */
  const [sessionArchitecture, setSessionArchitecture] = useState<string>("standard");
  const [marketTab, setMarketTab] = useState<MarketTab>("plugins");
  /** 输入框里已引用的技能 / 插件 / 插件命令（技能与插件可多选，命令独占） */
  const [chips, setChips] = useState<ComposerChip[]>([]);
  const addChip = useCallback((chip: ComposerChip) => {
    setChips((prev) => {
      // 插件命令展开后是一整段指令，与技能/插件引用无法共存；附件例外：
      // 命令 + 附件是合理组合（"用这个命令处理这份文件"），命令头后面会带附件行。
      if (chip.kind === "command") {
        return [...prev.filter((item) => item.kind === "file"), chip];
      }
      const withoutCommand = prev.filter((item) => item.kind !== "command");
      if (withoutCommand.some((item) => item.kind === chip.kind && item.id === chip.id)) {
        return withoutCommand;
      }
      return [...withoutCommand, chip];
    });
  }, []);
  const removeChip = useCallback((chip: ComposerChip) => {
    setChips((prev) =>
      prev.filter((item) => !(item.kind === chip.kind && item.id === chip.id)),
    );
  }, []);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("auto");
  /** 会话模式（plan / goal）与审批模式互相独立 */
  const [chatMode, setChatMode] = useState<SessionMode>("default");
  /** 主 Agent 档位（会话级）：标准 / 极简 / 复杂 */
  const [agentProfile, setAgentProfile] = useState<AgentProfileId>("standard");
  /** 计划文档路径：非空时输入框上方显示「开始执行 / 调整计划」确认卡片 */
  const [planDocPath, setPlanDocPath] = useState<string | null>(null);
  /** 计划页签展示的文档（退出计划模式后仍保留，方便实施时对照） */
  const [planTabPath, setPlanTabPath] = useState<string | null>(null);
  /** plans/ 下的写操作进行中：计划页签显示「正在写入」 */
  const [planWriting, setPlanWriting] = useState<{ callId: string; path: string } | null>(null);
  /** 每次 plan_documented 递增，强制计划页签重新读盘 */
  const [planDocVersion, setPlanDocVersion] = useState(0);
  /** 事件回调里读当前模式（闭包里的 chatMode 会过期） */
  const chatModeRef = useRef<SessionMode>("default");
  useEffect(() => {
    chatModeRef.current = chatMode;
  }, [chatMode]);
  const [showInspector, setShowInspector] = useState(true);
  /** 右侧检查器实际占位：设置/插件/架构页不渲染它，不应为它预留宽度 */
  const inspectorOccupied = view === "chat" && showInspector;
  /** 会话全文检索弹窗（Ctrl+K / 聊天头搜索按钮） */
  const [searchOpen, setSearchOpen] = useState(false);
  /** 检索跳转意图：滚到这条消息并短暂描边；token 每次递增以重播同一命中 */
  const [messageFocus, setMessageFocus] = useState<{ messageIndex: number; token: number } | null>(null);
  const searchFocusSeqRef = useRef(0);
  /** 右侧检查器展开/收起；手动切换过才启用动画，避免启动/进设置页重播 */
  const [inspectorAnimated, setInspectorAnimated] = useState(false);
  const toggleInspector = useCallback(() => {
    setInspectorAnimated(true);
    setShowInspector((value) => !value);
  }, []);

  // 离开聊天页时把动画开关关掉：侧栏在设置/插件/架构页是整块卸载的，
  // 切回来重新挂载时若还带着 data-animated，会重播一次「收起」动画（看起来就是闪一下）。
  useEffect(() => {
    if (view !== "chat") setInspectorAnimated(false);
  }, [view]);

  // ---- 右侧面板：页签状态与快捷键 ----
  const sideTabs = useSideTabs();
  /** 主会话 id（ref 版本，事件分流用，避免闭包过期） */
  const mainSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    mainSessionIdRef.current = session?.id ?? null;
  }, [session?.id]);
  /** 页签状态 ref：事件 / IPC 回调里读最新值，避免 handleEvent 因 tabs 变化反复重订阅 */
  const sideTabsRef = useRef(sideTabs);
  useEffect(() => {
    sideTabsRef.current = sideTabs;
  });

  /** 浏览器 host 的建页签 / 激活指令：自动展开检查器并切到 agent 浏览器页签 */
  useEffect(() => {
    const offEnsure = window.meow.onEnsureBrowserTab(({ url }) => {
      sideTabsRef.current.ensureAgentBrowserTab(url);
      setShowInspector(true);
    });
    const offSelect = window.meow.onSelectBrowserTab(({ tabId }) => {
      sideTabsRef.current.activate(tabId);
      setShowInspector(true);
    });
    return () => {
      offEnsure();
      offSelect();
    };
  }, []);

  /**
   * 模型规则：主进程定期从 ZCode 内置配置同步
   * （思考档位 / 上下文窗口 / 最大输出 / 图片输入）。
   * 同步完成时换掉模块里的规则表并触发一次重渲染。
   */
  const [, setModelProfilesVersion] = useState(0);
  useEffect(() => {
    // 开发态热更新时 preload 可能还是旧的（没重启窗口），缺少这两个方法就跳过
    if (!window.meow.getModelProfiles || !window.meow.onModelProfiles) return;
    const apply = (payload: { profiles?: ModelProfile[] } | null) => {
      setModelProfiles(payload?.profiles);
      setModelProfilesVersion((value) => value + 1);
    };
    void window.meow.getModelProfiles().then(apply).catch(() => undefined);
    return window.meow.onModelProfiles(apply);
  }, []);

  /** 左栏宽度：与右侧检查器同一套拖拽交互，localStorage 记忆 */
  const [listWidth, setListWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem("meowcode:listWidth"));
      if (Number.isFinite(saved) && saved > 0) {
        return clampListWidth(saved, INSPECTOR_MIN_WIDTH, true);
      }
    } catch {
      // 存储不可用
    }
    return 300;
  });

  /** 右侧面板宽度：可拖拽调节，localStorage 记忆（下限 240，上限随窗口与左栏收窄） */
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem("meowcode:inspectorWidth"));
      if (Number.isFinite(saved) && saved > 0) return clampInspectorWidth(saved, listWidth);
    } catch {
      // 存储不可用
    }
    return 360;
  });
  const resizeDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      resizeDragRef.current = { startX: event.clientX, startWidth: inspectorWidth };
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        // 指针捕获失败也不影响拖拽
      }
    },
    [inspectorWidth],
  );
  const moveResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    trackResizeCursor(event);
    const drag = resizeDragRef.current;
    if (!drag) return;
    setInspectorWidth(
      clampInspectorWidth(drag.startWidth - (event.clientX - drag.startX), listWidth),
    );
  }, [listWidth]);
  const endResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeDragRef.current) return;
    resizeDragRef.current = null;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // 已释放
    }
    setInspectorWidth((current) => {
      try {
        window.localStorage.setItem("meowcode:inspectorWidth", String(Math.round(current)));
      } catch {
        // 存储失败忽略
      }
      return current;
    });
  }, []);

  const [listDragging, setListDragging] = useState(false);
  const listDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const startListResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      listDragRef.current = { startX: event.clientX, startWidth: listWidth };
      setListDragging(true);
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        // 指针捕获失败也不影响拖拽
      }
    },
    [listWidth],
  );
  const moveListResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    trackResizeCursor(event);
    const drag = listDragRef.current;
    if (!drag) return;
    // 左栏在左侧：向右拖 = 变宽
    setListWidth(
      clampListWidth(
        drag.startWidth + (event.clientX - drag.startX),
        inspectorWidth,
        inspectorOccupied,
      ),
    );
  }, [inspectorWidth, inspectorOccupied]);
  const endListResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!listDragRef.current) return;
    listDragRef.current = null;
    setListDragging(false);
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // 已释放
    }
    setListWidth((current) => {
      try {
        window.localStorage.setItem("meowcode:listWidth", String(Math.round(current)));
      } catch {
        // 存储失败忽略
      }
      return current;
    });
  }, []);
  // 窗口缩放 / 侧栏开关后重新分配宽度：聊天区始终保留 CHAT_MIN_WIDTH。
  // 先按当前右栏压左栏，再按新左栏压右栏；每轮只会向预算内收敛，不会来回震荡。
  useEffect(() => {
    const enforceChatWidth = () => {
      setListWidth((current) => clampListWidth(current, inspectorWidth, inspectorOccupied));
      setInspectorWidth((current) => clampInspectorWidth(current, listWidth));
    };
    enforceChatWidth();
    window.addEventListener("resize", enforceChatWidth);
    return () => window.removeEventListener("resize", enforceChatWidth);
  }, [listWidth, inspectorWidth, inspectorOccupied]);

  const openSideTab = useCallback(
    (request: SideTabOpen) => {
      sideTabs.open(request);
      setShowInspector(true);
    },
    [sideTabs],
  );

  // Ctrl+P 文件快开 / Ctrl+Alt+S 侧边聊天 / Ctrl+` 终端
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".mc-rtp__term")) return; // 终端内不抢键
      if (event.key.toLowerCase() === "p" && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        setShowInspector(true);
        sideTabs.setPaletteOpen(true);
        return;
      }
      if (event.key.toLowerCase() === "k" && !event.altKey && !event.shiftKey) {
        // Ctrl+K 会话全文检索
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        openSideTab({ kind: "sidechat" });
        return;
      }
      if (event.code === "Backquote" && !event.altKey) {
        event.preventDefault();
        const terminalTab = sideTabs.tabs.find((tab) => tab.kind === "terminal");
        if (terminalTab && sideTabs.activeId === terminalTab.id) {
          sideTabs.close(terminalTab.id);
        } else if (terminalTab) {
          setShowInspector(true);
          sideTabs.activate(terminalTab.id);
        } else {
          openSideTab({ kind: "terminal" });
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sideTabs, openSideTab]);
  // ---- 界面状态落盘：页签 / 活动页签 / 检查器显隐与宽度 ----
  useEffect(() => {
    if (!uiHydrated) return;
    const tabs: UiState["tabs"] = [];
    for (const tab of sideTabs.tabs) {
      if (tab.id === "home" || tab.kind === "home" || (tab.kind === "browser" && tab.agent)) {
        continue;
      }
      if (tab.kind === "browser") {
        tabs.push({ id: tab.id, kind: "browser", title: tab.title, url: tab.url });
        continue;
      }
      if (tab.kind === "workspace") {
        tabs.push({
          id: tab.id,
          kind: "workspace",
          title: tab.title,
          ...(tab.path ? { path: tab.path } : {}),
        });
        continue;
      }
      if (tab.kind === "subagent") {
        tabs.push({
          id: tab.id,
          kind: "subagent",
          title: tab.title,
          agentId: tab.agentId,
          parentSessionId: tab.parentSessionId,
          ...(tab.callId ? { callId: tab.callId } : {}),
          ...(tab.description ? { description: tab.description } : {}),
        });
        continue;
      }
      if (tab.kind === "plugin") {
        tabs.push({ id: tab.id, kind: "plugin", title: tab.title, pluginId: tab.pluginId });
        continue;
      }
      tabs.push({ id: tab.id, kind: tab.kind, title: tab.title });
    }
    void window.meow
      .saveUiState({
        inspector: { visible: showInspector, width: inspectorWidth },
        tabs,
        activeTabId: sideTabs.activeId,
      })
      .catch(() => undefined);
  }, [uiHydrated, showInspector, inspectorWidth, sideTabs.tabs, sideTabs.activeId]);

  // ---- 草稿按会话落盘（主进程防抖原子写；清空即删除） ----
  useEffect(() => {
    if (!uiHydrated || !activeDraftKey) return;
    const draft = drafts[activeDraftKey];
    void window.meow
      .saveUiState({
        drafts: {
          [activeDraftKey]: draft
            ? { text: draft.text, updatedAt: draft.updatedAt }
            : null,
        },
      })
      .catch(() => undefined);
  }, [uiHydrated, activeDraftKey, drafts]);

  /** 所有待审批：callId → 请求；并行子 Agent 可能同时有多条，弹窗按到达顺序展示 */
  const [approvals, setApprovals] = useState<Record<string, PendingApproval>>({});
  /** ask_user 澄清问题卡片（模型调用 ask_user 虚拟工具时挂起等待） */
  const [pendingAsk, setPendingAsk] = useState<{
    callId: string;
    questions: Array<{ question: string; options: string[] }>;
  } | null>(null);
  const approvalsRef = useRef<Record<string, PendingApproval>>({});
  const replaceApprovals = useCallback((items: PendingApproval[]) => {
    const map: Record<string, PendingApproval> = {};
    for (const item of items) if (item.callId) map[item.callId] = item;
    approvalsRef.current = map;
    setApprovals(map);
  }, []);
  const upsertApproval = useCallback((pending: PendingApproval) => {
    if (!pending.callId) return;
    const next = { ...approvalsRef.current, [pending.callId]: pending };
    approvalsRef.current = next;
    setApprovals(next);
  }, []);
  const removeApproval = useCallback((sessionId?: string | null, callId?: string) => {
    const next = { ...approvalsRef.current };
    let changed = false;
    for (const [key, item] of Object.entries(next)) {
      if ((sessionId && item.sessionId === sessionId) || (callId && item.callId === callId)) {
        delete next[key];
        changed = true;
      }
    }
    if (!changed) return;
    approvalsRef.current = next;
    setApprovals(next);
  }, []);
  /** 主回合结束/停止只清理主 Agent 自己的审批；后台子 Agent 的审批不能跟着丢。 */
  const removeOwnApprovals = useCallback((sessionId?: string | null) => {
    if (!sessionId) return;
    const next = { ...approvalsRef.current };
    let changed = false;
    for (const [key, item] of Object.entries(next)) {
      if (item.sessionId === sessionId && !item.agentId) {
        delete next[key];
        changed = true;
      }
    }
    if (!changed) return;
    approvalsRef.current = next;
    setApprovals(next);
  }, []);
  const removeAgentApprovals = useCallback((agentId: string) => {
    const next = { ...approvalsRef.current };
    let changed = false;
    for (const [key, item] of Object.entries(next)) {
      if (item.agentId === agentId) {
        delete next[key];
        changed = true;
      }
    }
    if (!changed) return;
    approvalsRef.current = next;
    setApprovals(next);
  }, []);
  const approval = session
    ? (() => {
        const pending = Object.values(approvals).filter(
          (item) => item.sessionId === session.id,
        );
        // hook 命令审批优先：否则工具弹窗会挡住「运行 hook 命令」的确认，两边互相等待。
        return pending.find((item) => item.kind === "hook") ?? pending[0] ?? null;
      })()
    : null;

  /** 子 Agent 运行状态：按 agentId 累积，跨父会话保留，页签按 parentSessionId 过滤。 */
  const [subagentRuns, setSubagentRuns] = useState<Record<string, SubagentRun>>({});
  const subagentRunsRef = useRef<Record<string, SubagentRun>>({});
  /** 治理 roadmap 快照：按会话累积，计划页签顶部展示 lanes 与 gate 状态 */
  const [workflowRoadmaps, setWorkflowRoadmaps] = useState<Record<string, WorkflowRoadmap>>({});
  /** 正在拉转录的 agentId，避免页签挂载与点击同时触发重复请求 */
  const subagentHydratingRef = useRef<Set<string>>(new Set());
  const updateSubagentRuns = useCallback(
    (updater: (current: Record<string, SubagentRun>) => Record<string, SubagentRun>) => {
      setSubagentRuns((current) => {
        const next = updater(current);
        subagentRunsRef.current = next;
        return next;
      });
    },
    [],
  );
  /** 当前主会话的子智能体：右上角概览只列本会话（subagentRuns 跨会话累积） */
  const currentSessionSubagents = useMemo(
    () =>
      Object.values(subagentRuns)
        .filter((run) => run.parentSessionId === session?.id)
        .sort((left, right) => {
          const leftRunning = left.status === "running" ? 0 : 1;
          const rightRunning = right.status === "running" ? 0 : 1;
          if (leftRunning !== rightRunning) return leftRunning - rightRunning;
          return (right.startedAt ?? "").localeCompare(left.startedAt ?? "");
        }),
    [subagentRuns, session?.id],
  );
  /** 快速切换时丢弃旧 loadCurrentSession 的迟到结果 */
  const sessionLoadIdRef = useRef(0);
  /** 全局运行/审批快照版本；后台会话的回合事件也会推进 */
  const runStateVersionRef = useRef(0);
  /** 按会话的运行状态版本：当前会话自己的事件才让它的队列/压缩状态回填失效 */
  const sessionRunVersionsRef = useRef<Record<string, number>>({});
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [themePreference, setThemePreference] = useState<ThemePreference>("system");

  useEffect(() => {
    const timer = window.setTimeout(() => setSplashDone(true), 1000);
    return () => window.clearTimeout(timer);
  }, []);

  // 启动画面结束前保持黑底（index.html 的 data-booting），避免露出主题底色
  useEffect(() => {
    if (!ready || !splashDone) return;
    delete document.documentElement.dataset.booting;
  }, [ready, splashDone]);

  // ---- 派生：当前生效的模型（按 providerId 解析，而不是死用 providers[0]）----
  const providers = useMemo(() => settings?.providers ?? [], [settings]);
  /** 当前生效的工作区：优先跟随会话 cwd，没有会话时用设置里的工作区 */
  const activeWorkspace = session?.cwd ?? settings?.workspace;
  /** 当前项目目录：worktree 会话归回原项目，避免侧栏把它当成新项目 */
  const projectCwd = session?.worktree?.sourceCwd ?? session?.cwd ?? settings?.workspace;
  /** 标题栏第二行：worktree 会话显示「项目 · 分支」，悬停给完整 worktree 路径 */
  const headerWorkspace = session?.worktree
    ? `${
        settings?.projectNames?.[session.worktree.sourceCwd]?.trim() ||
        baseName(session.worktree.sourceCwd)
      } · ${session.worktree.branch}`
    : session?.cwd;
  const headerWorkspaceTitle = session?.worktree?.path ?? session?.cwd;
  /** 工作区目录被用户在系统里删掉后，输入框上方要回退成「选择工作区」 */
  useEffect(() => {
    let cancelled = false;
    setWorkspaceAvailable(null);
    const check = async () => {
      try {
        const exists = activeWorkspace
          ? await window.meow.workspaceExists(activeWorkspace)
          : false;
        if (!cancelled) setWorkspaceAvailable(exists);
      } catch {
        if (!cancelled) setWorkspaceAvailable(false);
      }
    };
    void check();
    // 切回窗口时重新校验：运行期间在资源管理器里删掉目录也能及时回退
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", check);
    };
  }, [activeWorkspace]);
  // worktree 意图只属于当前这次新对话：切会话/换项目/新建后自动失效
  useEffect(() => {
    setWorktreeIntent(false);
  }, [session?.id]);
  // 分支胶囊：跟着当前会话的 cwd 走（worktree 会话显示 worktree 自己的分支），非 git 仓库不显示
  useEffect(() => {
    let cancelled = false;
    if (!activeWorkspace) {
      setGitBranch(null);
      return;
    }
    void (async () => {
      try {
        const status = await gitStatus();
        if (cancelled) return;
        const name = status.isRepo ? (status.branch ?? "").trim() : "";
        if (!status.isRepo || (!name && !status.detached)) {
          setGitBranch(null);
          return;
        }
        setGitBranch({ name, detached: Boolean(status.detached) || !name });
      } catch {
        if (!cancelled) setGitBranch(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace, session?.id, gitRevision]);
  const activeProvider = useMemo(() => {
    // 停用的模型不在选择器里，也不能继续当激活模型（旧设置可能残留这种状态）
    const configured = providers.find((item) => item.id === settings?.providerId);
    if (configured && configured.enabled !== false) return configured;
    return providers.find((item) => item.enabled !== false) ?? providers[0];
  }, [providers, settings?.providerId]);
  const activeProviderId = activeProvider?.id ?? "";
  /** 子 Agent 页签只属于发起它的父会话；其他父会话的页签保留但隐藏。 */
  const visibleSideTabs = useMemo(
    () =>
      sideTabs.tabs.filter(
        (tab) => tab.kind !== "subagent" || tab.parentSessionId === session?.id,
      ),
    [sideTabs.tabs, session?.id],
  );
  const visibleActiveTabId = visibleSideTabs.some((tab) => tab.id === sideTabs.activeId)
    ? sideTabs.activeId
    : "home";
  /** 主对话 Task 卡片 → 子 Agent（按 callId 关联） */
  const subagentsByCallId = useMemo(() => {
    const map: Record<string, SubagentRun> = {};
    for (const run of Object.values(subagentRuns)) {
      if (run.parentSessionId === session?.id && run.callId) map[run.callId] = run;
    }
    return map;
  }, [subagentRuns, session?.id]);
  const preferences = useMemo<Preferences>(
    () => ({
      theme: settings?.theme ?? "system",
      closeAction: settings?.closeAction ?? "ask",
      language: settings?.language ?? "system",
      speechStyle: settings?.speechStyle ?? "normal",
      silentUpdate: settings?.silentUpdate ?? true,
      notifications: settings?.notifications ?? true,
      floatingIsland: settings?.floatingIsland ?? false,
      worktreeFetchUpstream: settings?.worktreeFetchUpstream ?? false,
      worktreeAutoCleanup: settings?.worktreeAutoCleanup ?? true,
      worktreeMaxKeep: settings?.worktreeMaxKeep ?? 15,
      includeAgentsMd: settings?.includeAgentsMd ?? true,
      includeClaudeMd: settings?.includeClaudeMd ?? true,
      fontFamily: settings?.fontFamily ?? "",
      codeFontFamily: settings?.codeFontFamily ?? "",
    }),
    [
      settings?.theme,
      settings?.closeAction,
      settings?.language,
      settings?.speechStyle,
      settings?.silentUpdate,
      settings?.notifications,
      settings?.floatingIsland,
      settings?.worktreeFetchUpstream,
      settings?.worktreeAutoCleanup,
      settings?.worktreeMaxKeep,
      settings?.includeAgentsMd,
      settings?.includeClaudeMd,
      settings?.fontFamily,
      settings?.codeFontFamily,
    ],
  );

  const reloadSessions = useCallback(async () => {
    try {
      const result = await api<{ sessions: SessionSummary[] }>("/sessions");
      setSessions(result.sessions);
    } catch {
      // 保持上一次列表：瞬时失败不应把侧栏清空
    }
  }, []);

  /** /session 快照里的子 Agent 元数据；保留已有的实时时间线，不顺带降级状态。 */
  const mergeSubagentSummaries = useCallback(
    (items: SubagentSummary[]) => {
      if (!items.length) return;
      updateSubagentRuns((current) => {
        const next = { ...current };
        for (const item of items) {
          const existing = next[item.agentId];
          const live = item.status === "running";
          next[item.agentId] = existing
            ? {
                ...existing,
                ...item,
                // 终态以服务端为准；running 时保留本地实时状态
                status: live && existing.live ? existing.status : item.status,
                timeline: existing.timeline,
                hydrated: existing.hydrated,
                live,
              }
            : {
                ...item,
                timeline: [],
                hydrated: false,
                live,
              };
        }
        return next;
      });
    },
    [updateSubagentRuns],
  );

  /** 切会话 / 新回合开始时清空响应统计（历史回合的 usage 没有持久化，无法回放） */
  const resetTurnMetrics = useCallback(() => {
    turnStartAtRef.current = null;
    turnFirstTokenAtRef.current = null;
    roundFirstTokenAtRef.current = null;
    setTurnMetrics(null);
  }, []);

  /** 切会话/重载：丢掉旧会话的样本，统计以会话文件里的汇总为基座。 */
  const resetSessionUsage = useCallback(() => {
    usageSamplesRef.current = new Map();
    subagentUsageSamplesRef.current = new Map();
    usageTotalsRef.current = { ...EMPTY_SAMPLE };
    lastCacheReadRef.current = null;
  }, []);

  /** 写入一条 usage 事件并按 roundId 替换样本，返回新的累计总量。 */
  const updateUsageSample = useCallback(
    (event: {
      roundId?: string;
      final?: boolean;
      retracted?: boolean;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }): UsageSample => {
      const roundId = event.roundId ?? `legacy-${(legacyUsageRoundRef.current += 1)}`;
      const previous = usageSamplesRef.current.get(roundId);
      if (event.retracted) {
        usageSamplesRef.current.delete(roundId);
        usageTotalsRef.current = retractSample(usageTotalsRef.current, previous);
      } else {
        const next = mergeSample(previous, event);
        usageSamplesRef.current.set(roundId, next);
        usageTotalsRef.current = applySample(usageTotalsRef.current, previous, next);
      }
      return usageTotalsRef.current;
    },
    [],
  );

  const loadCurrentSession = useCallback(async () => {
    const loadId = ++sessionLoadIdRef.current;
    const globalRunVersion = runStateVersionRef.current;
    const sessionVersions = { ...sessionRunVersionsRef.current };
    const queueVersion = queueVersionRef.current;
    setToolProgress(null);
    resetTurnMetrics();
    try {
      const current = await api<{
        id: string;
        cwd: string;
        filePath: string;
        createdAt: string;
        worktree?: SessionWorktree | null;
        title?: string | null;
        plan?: PlanState | null;
        runningSessionIds?: string[];
        pendingApprovals?: PendingApproval[];
        pendingAsk?: { callId: string; questions: Array<{ question: string; options: string[] }> } | null;
        queuedPrompts?: QueuedPrompt[];
        recoveredPrompts?: QueuedPrompt[];
        /** 旧会话可能存的是 "default"（语义等于 ask） */
        approvalMode?: PermissionMode | "default";
        /** 会话模式：plan / goal / default */
        mode?: SessionMode;
        agentProfile?: AgentProfileId;
        /** 当前生效的架构图 id：自定义架构（custom-*）优先，否则等于档位 */
        harnessArchitecture?: string;
        lastTurn?: {
          status: "completed" | "aborted" | "error" | "interrupted";
          error?: string;
        } | null;
        compactingSessionIds?: string[];
        lastError?: string | null;
        usage?: {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
          cacheInputTokens: number;
          cacheReported: boolean;
          hasUsage: boolean;
        } | null;
        metrics?: {
          tokensPerSecond?: number;
          responseMs?: number;
          firstTokenMs?: number;
        } | null;
        subagents?: SubagentSummary[];
      }>("/session");
      const messages = await api<{
        messages: ChatMessage[];
        compaction?: { messageIndex: number; summary: string } | null;
        compactions?: CompactionPoint[];
        checkpoints?: SessionCheckpoint[];
      }>("/session/messages");
      // 快速切换时旧请求可能后到，直接丢弃
      if (loadId !== sessionLoadIdRef.current) return false;
      setSession(current);
      mergeSubagentSummaries(current.subagents ?? []);
      setSessionTitle(current.title ?? null);
      setPlan(current.plan ?? null);
      setPermissionMode(
        current.approvalMode === "default" ? "ask" : (current.approvalMode ?? "auto"),
      );
      // 历史回放不推断确认面板：切会话/重载后清空，等下一次写计划再弹
      chatModeRef.current = current.mode ?? "default";
      setChatMode(current.mode ?? "default");
      setAgentProfile(current.agentProfile ?? "standard");
      // 聊天框的架构胶囊：自定义架构优先，否则跟随档位
      setSessionArchitecture(
        current.harnessArchitecture || current.agentProfile || "standard",
      );
      setPlanDocPath(null);
      setPlanTabPath(null);
      setPlanWriting(null);
      setRecoveredPrompts(current.recoveredPrompts ?? []);
      setLastTurn(current.lastTurn ?? null);
      const usage = current.usage;
      const lastMetrics = current.metrics;
      // 会话级统计以文件汇总为基座：切回来时历史累计仍在
      resetSessionUsage();
      usageTotalsRef.current = totalsFromServer(usage);
      if (usage?.hasUsage || lastMetrics) {
        const totals = usageTotalsRef.current;
        setTurnMetrics({
          ...EMPTY_TURN_METRICS,
          inputTokens: usage?.hasUsage ? totals.input : null,
          cacheReadTokens: totals.cacheReported ? totals.cacheRead : null,
          cacheWriteTokens: usage?.hasUsage ? totals.cacheWrite : null,
          outputTokens: usage?.hasUsage ? totals.output : null,
          tokensPerSecond: lastMetrics?.tokensPerSecond ?? null,
          responseMs: lastMetrics?.responseMs ?? null,
          firstTokenMs: lastMetrics?.firstTokenMs ?? null,
          cacheHitRate: hitRate(totals),
        });
      } else {
        setTurnMetrics(null);
      }
      // 加载期间已有回合事件时，按事件驱动状态优先，避免旧快照回填
      const targetStable =
        (sessionVersions[current.id] ?? 0) === (sessionRunVersionsRef.current[current.id] ?? 0);
      if (targetStable) {
        if (queueVersion === queueVersionRef.current) {
          replaceQueuedPrompts(current.queuedPrompts ?? []);
        }
        // 本次快照已生效，作废更早发出的对账请求
        sessionRunVersionsRef.current[current.id] =
          (sessionRunVersionsRef.current[current.id] ?? 0) + 1;
      }
      if (globalRunVersion === runStateVersionRef.current) {
        setRunningSessions(current.runningSessionIds ?? []);
        replaceApprovals(current.pendingApprovals ?? []);
        if ("pendingAsk" in current) setPendingAsk(current.pendingAsk ?? null);
        setCompactingSessions(current.compactingSessionIds ?? []);
        runStateVersionRef.current += 1;
      }
      const history = timelineFromHistory(
        messages.messages,
        nextKey,
        messages.compactions?.length ? messages.compactions : (messages.compaction ?? null),
        messages.checkpoints,
      );
      if (current.lastTurn?.status === "interrupted") {
        history.push({
          kind: "notice",
          key: nextKey("notice"),
          message: i18n.t("shell:notice.interrupted"),
        });
      }
      if (current.lastError) {
        history.push({ kind: "error", key: nextKey("error"), message: current.lastError });
      }
      // 切回仍在压缩的会话时补一条运行中分隔线；完成后由事件原地改写
      if (compactingSessionIdsRef.current.has(current.id)) {
        history.push({ kind: "compaction", key: nextKey("compaction"), running: true });
      }
      setTimeline(history);
      // 撤销回滚入口：当前会话最近一次可撤销的回滚（无则隐藏横幅）
      void api<{ undoable: { rewindId: string; mode: RewindMode; fileCount: number } | null }>(
        "/session/rewind/undoable",
      )
        .then((res) => {
          if (loadId === sessionLoadIdRef.current) {
            setUndoableRewind(res.undoable ?? null);
          }
        })
        .catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }, [
    resetTurnMetrics,
    setRunningSessions,
    replaceApprovals,
    replaceQueuedPrompts,
    setCompactingSessions,
    mergeSubagentSummaries,
  ]);

  /** 拉取当前会话的上下文占用（输入框圆圈与弹层的数据源）。 */
  const refreshContextUsage = useCallback(async () => {
    try {
      setContextUsage(await api<ContextUsage>("/session/context"));
    } catch {
      // agent server 未就绪时保留旧值
    }
  }, []);

  // 回落到 85% 以下后，下次再接近上限时重新提示
  useEffect(() => {
    if (!contextUsage?.recommendedCompaction) setContextWarningDismissed(false);
  }, [contextUsage?.recommendedCompaction]);

  /** 报错以时间线条目呈现：跟着消息流出现在聊天里，不再是顶部横幅。 */
  const pushError = useCallback((message: string) => {
    setTimeline((items) => [...items, { kind: "error", key: nextKey("error"), message }]);
  }, []);

  /** 右上角轻提示（如「已是最新版本」）：几秒后自动消失 */
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const showToast = useCallback((text: string) => {
    setToast({ key: Date.now(), text });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  /**
   * Git 管理：状态放在 App —— 切到对话/设置时 GitBody 会卸载，
   * 选中文件、diff、提交草稿不能跟着丢。只有视图可见时才轮询。
   */
  const git = useGitView({
    workspace: session?.cwd ?? settings?.workspace,
    active: view === "git",
  });
  /** 聊天页常驻的轻量 git 状态：右上角概览摘要 + 输入框胶囊的未提交过滤共用 */
  const workspaceGitStatus = useWorkspaceGit({
    workspace: session?.cwd ?? settings?.workspace,
    active: view === "chat",
  });
  const uncommittedSessionChanges = useMemo(
    () =>
      filterUncommittedSessionChanges(
        sessionChanges,
        workspaceGitStatus,
        session?.cwd ?? settings?.workspace ?? null,
      ),
    [sessionChanges, workspaceGitStatus, session?.cwd, settings?.workspace],
  );
  const [gitBranchOpen, setGitBranchOpen] = useState(false);

  /**
   * 更新（GitCode releases）：检查到新版本后可以下载安装包并打开安装程序。
   * 状态放这里，更新弹窗在设置页之外也能弹（比如聊天区里的"立即更新"提示）。
   */
  const [updateRelease, setUpdateRelease] = useState<UpdateInfo | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  /** 发现新版本（启动自动检查或关于页手动检查）：只记录结果，弹窗由用户主动打开 */
  const discoverUpdate = useCallback((release: UpdateInfo) => {
    setUpdateRelease(release);
  }, []);

  // 启动时静默查一次：有新版就在聊天里留一条带"立即更新"的提示（不打扰，但不藏）
  useEffect(() => {
    let disposed = false;
    void checkForUpdates()
      .then((result) => {
        if (disposed || !result.ok || !result.hasUpdate) return;
        setUpdateRelease(result.latest);
        setTimeline((items) => [
          ...items,
          {
            kind: "notice",
            key: nextKey("update"),
            message: i18n.t("shell:notice.updateAvailable", { version: result.latest.version }),
            action: {
              label: i18n.t("shell:notice.updateNow"),
              run: () => setUpdateOpen(true),
            },
          },
        ]);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  /**
   * 静默下载更新（设置里默认开）：检查到新版本就在后台拉安装包。
   * 进度显示在导航栏左下角的圆环图标上，下完变成重启按钮，点一下打开安装包。
   */
  const [silentUpdate, setSilentUpdate] = useState<SilentUpdateState>({ status: "hidden" });
  const silentStartedRef = useRef(false);

  // 进度事件是全广播：手动弹窗下载与静默下载共用，只在静默进行中才更新圆环
  useEffect(() => {
    return onUpdateProgress((next) => {
      setSilentUpdate((current) =>
        current.status === "downloading"
          ? { status: "downloading", percent: next.percent }
          : current,
      );
    });
  }, []);

  useEffect(() => {
    if (silentStartedRef.current || !updateRelease?.asset) return;
    if (!settings) return; // 等设置加载完再决定：用户可能把静默下载关了
    if (settings.silentUpdate === false) return;
    silentStartedRef.current = true;
    setSilentUpdate({ status: "downloading", percent: 0 });
    void downloadUpdate({ url: updateRelease.asset.url, fileName: updateRelease.asset.name })
      .then((result) => setSilentUpdate({ status: "done", path: result.path }))
      .catch(() => setSilentUpdate({ status: "error" }));
  }, [updateRelease, settings]);

  /** 静默下载完成后的重启安装：打开安装包，Windows 上应用会随之退出 */
  const restartUpdate = useCallback(async () => {
    if (silentUpdate.status !== "done") return;
    try {
      await openInstaller(silentUpdate.path);
    } catch (error) {
      pushError(error instanceof Error ? error.message : String(error));
    }
  }, [silentUpdate, pushError]);

  const enqueueQueuedPrompt = useCallback((item: QueuedPrompt) => {
    queueVersionRef.current += 1;
    queuedPromptsRef.current = [...queuedPromptsRef.current, item];
    setQueuedPrompts(queuedPromptsRef.current);
  }, []);

  const dropQueuedPrompt = useCallback((id: string) => {
    queueVersionRef.current += 1;
    queuedPromptsRef.current = queuedPromptsRef.current.filter((item) => item.id !== id);
    setQueuedPrompts(queuedPromptsRef.current);
  }, []);

  const clearQueuedPrompts = useCallback(() => {
    queueVersionRef.current += 1;
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
  }, []);

  /** 服务端告诉前端某个排队项已开始执行：把它从队列移到时间线。 */
  const completeQueuedPrompt = useCallback((id: string) => {
    const item = queuedPromptsRef.current.find((entry) => entry.id === id);
    queueVersionRef.current += 1;
    queuedPromptsRef.current = queuedPromptsRef.current.filter((entry) => entry.id !== id);
    setQueuedPrompts(queuedPromptsRef.current);
    if (!item) return;
    setTimeline((items) => [
      ...items,
      { kind: "message", key: nextKey("user"), role: "user", content: item.text },
    ]);
  }, []);

  const removeQueuedPrompt = useCallback(
    async (id: string) => {
      try {
        await api("/session/queue/remove", {
          method: "POST",
          body: JSON.stringify({ id }),
        });
        dropQueuedPrompt(id);
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      }
    },
    [dropQueuedPrompt, pushError],
  );

  const steerQueuedPrompt = useCallback(
    async (id: string) => {
      try {
        await api("/session/steer", { method: "POST", body: JSON.stringify({ id }) });
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      }
    },
    [pushError],
  );

  /** 恢复已结束子 Agent 的完整转录；运行中的实时内容不会被快照覆盖。 */
  const hydrateSubagent = useCallback(
    async (agentId: string, force = false) => {
      const run = subagentRunsRef.current[agentId];
      if (!force && run && (run.hydrated || (run.live && run.timeline.length > 0))) return;
      if (subagentHydratingRef.current.has(agentId)) return;
      subagentHydratingRef.current.add(agentId);
      try {
        const data = await api<SubagentTranscript>(
          `/session/subagents/${encodeURIComponent(agentId)}/messages`,
        );
        const timeline = timelineFromHistory(
          data.messages,
          nextKey,
          data.compactions?.length ? data.compactions : (data.compaction ?? null),
        );
        if (data.status === "interrupted" || data.openTurn) {
          timeline.push({
            kind: "notice",
            key: nextKey("notice"),
            message: i18n.t("shell:notice.subagentInterrupted"),
          });
        }
        updateSubagentRuns((current) => {
          const existing = current[agentId];
          if (!force && existing?.live && existing.timeline.length > 0) return current;
          return {
            ...current,
            [agentId]: {
              agentId,
              parentSessionId: data.parentSessionId,
              callId: data.callId || existing?.callId || "",
              description: data.description,
              ...(data.agentType ? { agentType: data.agentType } : {}),
              ...(existing?.background !== undefined
                ? { background: existing.background }
                : {}),
              status: data.status,
              startedAt: data.createdAt,
              timeline,
              hydrated: true,
              live: data.status === "running",
              ...(data.lastTurn?.error
                ? { error: data.lastTurn.error }
                : existing?.error
                  ? { error: existing.error }
                  : {}),
              ...(data.usage
                ? { usage: data.usage }
                : existing?.usage
                  ? { usage: existing.usage }
                  : {}),
              ...(existing?.prompt ? { prompt: existing.prompt } : {}),
            },
          };
        });
      } catch {
        // 父会话已切换或文件不存在：结束加载态，页签显示空态而不是一直转圈。
        updateSubagentRuns((current) =>
          current[agentId]
            ? { ...current, [agentId]: { ...current[agentId], hydrated: true } }
            : {
                ...current,
                [agentId]: {
                  agentId,
                  parentSessionId: "",
                  callId: "",
                  description: i18n.t("shell:subagent.label"),
                  status: "interrupted",
                  startedAt: new Date().toISOString(),
                  timeline: [],
                  hydrated: true,
                  live: false,
                  error: i18n.t("shell:subagent.loadFailed"),
                },
              },
        );
      } finally {
        subagentHydratingRef.current.delete(agentId);
      }
    },
    [updateSubagentRuns],
  );

  const openSubagentById = useCallback(
    (agentId: string) => {
      const run = subagentRunsRef.current[agentId];
      if (!run) return;
      sideTabs.openSubagent({
        agentId,
        parentSessionId: run.parentSessionId,
        callId: run.callId,
        description: run.description,
      });
      setShowInspector(true);
      void hydrateSubagent(agentId);
    },
    [hydrateSubagent, sideTabs],
  );
  const ensureSubagentTranscript = useCallback(
    (agentId: string) => {
      void hydrateSubagent(agentId);
    },
    [hydrateSubagent],
  );
  const stopSubagent = useCallback(async (agentId: string) => {
    try {
      await api(`/session/subagents/${encodeURIComponent(agentId)}/abort`, {
        method: "POST",
        body: "{}",
      });
    } catch {
      // 已结束/已停止：状态会由完成事件/快照收敛
    }
  }, []);
  const continueSubagent = useCallback(async (agentId: string, message: string) => {
    await api(`/session/subagents/${encodeURIComponent(agentId)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }, []);
  const steerSubagent = useCallback(async (agentId: string, message: string) => {
    await api(`/session/subagents/${encodeURIComponent(agentId)}/steer`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }, []);

  /** 子 Agent 事件必须最先分流，不能进入主时间线/运行圆点/审批清理逻辑。 */
  const handleSubagentEvent = useCallback(
    (event: MeowEvent) => {
      const agentId = event.agentId;
      if (!agentId) return;
      // 契约角色结算：把宿主校验结论挂到对应 run 上（子 Agent 列表徽章）
      if (event.type === "child_result") {
        if (!event.result) return;
        const result = { ...event.result };
        updateSubagentRuns((current) => {
          const existing = current[agentId];
          if (!existing) return current;
          return { ...current, [agentId]: { ...existing, childResult: result } };
        });
        return;
      }
      if (event.type === "subagent_steer_queued") {
        const steerId = event.steerId ?? "";
        const text = event.text ?? "";
        if (!steerId) return;
        updateSubagentRuns((current) => {
          const existing = current[agentId];
          if (!existing) return current;
          const pending = existing.pendingSteers ?? [];
          if (pending.some((item) => item.id === steerId)) return current;
          return {
            ...current,
            [agentId]: {
              ...existing,
              pendingSteers: [...pending, { id: steerId, text }],
              steerError: undefined,
            },
          };
        });
        return;
      }
      if (event.type === "subagent_steer_delivered") {
        const steerId = event.steerId ?? "";
        const text = event.text ?? "";
        updateSubagentRuns((current) => {
          const existing = current[agentId];
          if (!existing) return current;
          const key = `steer-${steerId}`;
          const timeline = existing.timeline.some((item) => item.key === key)
            ? existing.timeline
            : [
                ...existing.timeline,
                {
                  kind: "message" as const,
                  key,
                  role: "user" as const,
                  content: text,
                },
              ];
          return {
            ...current,
            [agentId]: {
              ...existing,
              pendingSteers: (existing.pendingSteers ?? []).filter((item) => item.id !== steerId),
              timeline,
              steerError: undefined,
            },
          };
        });
        return;
      }
      if (event.type === "subagent_steer_dropped") {
        const steerId = event.steerId ?? "";
        updateSubagentRuns((current) => {
          const existing = current[agentId];
          if (!existing) return current;
          return {
            ...current,
            [agentId]: {
              ...existing,
              pendingSteers: (existing.pendingSteers ?? []).filter((item) => item.id !== steerId),
              steerError:
                event.reason === "aborted"
                  ? i18n.t("shell:subagent.steerAborted")
                  : i18n.t("shell:subagent.steerFinished"),
            },
          };
        });
        return;
      }
      if (event.type === "subagent_started") {
        const parentSessionId = event.parentSessionId ?? "";
        if (parentSessionId && parentSessionId === mainSessionIdRef.current) {
          setWorkspaceOverviewOpen(true);
        }
        const description = event.description ?? event.agentDescription ?? i18n.t("shell:subagent.label");
        // 先建 UI，再等子 Agent 首字：自动创建页签但不切换，避免打断当前阅读。
        if (
          !subagentRunsRef.current[agentId] &&
          parentSessionId &&
          parentSessionId === mainSessionIdRef.current
        ) {
          sideTabsRef.current.prepareSubagent({
            agentId,
            parentSessionId,
            ...(event.callId ? { callId: event.callId } : {}),
            description,
          });
          sideTabsRef.current.prepareSubagentsDirectory();
        }
        updateSubagentRuns((current) => {
          const existing = current[agentId];
          // SSE 重放可能再次送来 started：不能把已结束的 Agent 回退成运行中
          if (existing && existing.status !== "running") {
            return {
              ...current,
              [agentId]: {
                ...existing,
                callId: event.callId || existing.callId,
                description,
                ...(event.agentType ? { agentType: event.agentType } : {}),
                ...(event.background !== undefined ? { background: event.background } : {}),
                ...(event.prompt ? { prompt: event.prompt } : {}),
              },
            };
          }
          const timeline =
            existing?.timeline.length
              ? existing.timeline
              : [
                  {
                    kind: "message" as const,
                    key: nextKey("user"),
                    role: "user" as const,
                    content: event.prompt ?? "",
                  },
                ];
          return {
            ...current,
            [agentId]: {
              agentId,
              parentSessionId,
              callId: event.callId ?? existing?.callId ?? "",
              description,
              ...(event.agentType ? { agentType: event.agentType } : {}),
              ...(event.background !== undefined ? { background: event.background } : {}),
              status: "running",
              startedAt: event.startedAt ?? new Date().toISOString(),
              timeline,
              hydrated: existing?.hydrated ?? false,
              live: true,
              pendingSteers: [],
              steerError: undefined,
              ...(event.prompt ? { prompt: event.prompt } : {}),
              ...(existing?.usage ? { usage: existing.usage } : {}),
            },
          };
        });
        return;
      }
      if (event.type === "subagent_resumed") {
        const parentSessionId = event.parentSessionId ?? "";
        const description = event.description ?? event.agentDescription ?? i18n.t("shell:subagent.label");
        if (parentSessionId && parentSessionId === mainSessionIdRef.current) {
          sideTabsRef.current.prepareSubagent({
            agentId,
            parentSessionId,
            ...(event.callId ? { callId: event.callId } : {}),
            description,
          });
          sideTabsRef.current.prepareSubagentsDirectory();
        }
        updateSubagentRuns((current) => {
          const existing = current[agentId];
          const timeline = [...(existing?.timeline ?? [])];
          if (event.prompt) {
            timeline.push({
              kind: "message",
              key: nextKey("user"),
              role: "user",
              content: event.prompt,
            });
          }
          return {
            ...current,
            [agentId]: {
              ...existing,
              agentId,
              parentSessionId,
              callId: event.callId ?? existing?.callId ?? "",
              description,
              ...(event.agentType ? { agentType: event.agentType } : {}),
              background: event.background ?? true,
              status: "running",
              startedAt: event.startedAt ?? new Date().toISOString(),
              timeline,
              hydrated: existing?.hydrated ?? false,
              live: true,
              preparing: undefined,
              pendingSteers: [],
              steerError: undefined,
              ...(existing?.usage ? { usage: existing.usage } : {}),
            },
          };
        });
        return;
      }
      if (event.type === "tool_call_progress") {
        const preparing = toolPreparingLabel(t, event.count, event.names) ?? undefined;
        updateSubagentRuns((current) => {
          const existing = current[agentId];
          if (!existing) return current;
          return { ...current, [agentId]: { ...existing, preparing } };
        });
        return;
      }
      if (event.type === "subagent_completed") {
        removeAgentApprovals(agentId);
        updateSubagentRuns((current) => {
          const existing = current[agentId];
          const base: SubagentRun = existing ?? {
            agentId,
            parentSessionId: event.parentSessionId ?? "",
            callId: event.callId ?? "",
            description: event.description ?? event.agentDescription ?? i18n.t("shell:subagent.label"),
            ...(event.agentType ? { agentType: event.agentType } : {}),
            background: event.background ?? false,
            status: event.status ?? "completed",
            startedAt: event.startedAt ?? new Date().toISOString(),
            timeline: [],
            hydrated: false,
            live: false,
          };
          const timeline = [...base.timeline];
          finalizeStreamingAssistants(timeline);
          return {
            ...current,
            [agentId]: {
              ...base,
              callId: event.callId || base.callId,
              ...(event.agentType ? { agentType: event.agentType } : {}),
              ...(event.background !== undefined ? { background: event.background } : {}),
              status: event.status ?? "completed",
              ...(event.endedAt ? { endedAt: event.endedAt } : {}),
              ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
              ...(event.error ? { error: event.error } : {}),
              ...(event.usage ? { usage: event.usage } : {}),
              timeline,
              preparing: undefined,
              pendingSteers: [],
              live: false,
            },
          };
        });
        // 后台任务完成通知：主回合没有等它，这里在时间线上补一条中性提示。
        if (
          event.background &&
          event.parentSessionId &&
          event.parentSessionId === mainSessionIdRef.current
        ) {
          const statusLabel =
            event.status === "completed"
              ? i18n.t("shell:subagent.status.completed")
              : event.status === "failed"
                ? i18n.t("shell:subagent.status.failed")
                : event.status === "aborted"
                  ? i18n.t("shell:subagent.status.aborted")
                  : i18n.t("shell:subagent.status.interrupted");
          const key = `subagent-notice-${agentId}-${event.endedAt ?? ""}`;
          const name = event.description ?? i18n.t("shell:subagent.label");
          const message = event.report
            ? i18n.t("shell:subagent.noticeWithReport", {
                name,
                status: statusLabel,
                report: event.report.slice(0, 120),
              })
            : i18n.t("shell:subagent.notice", { name, status: statusLabel });
          setTimeline((items) =>
            items.some((item) => item.key === key)
              ? items
              : [...items, { kind: "notice", key, message }],
          );
        }
        return;
      }
      if (event.type === "approval_required") {
        upsertApproval({
          sessionId: event.parentSessionId ?? event.sessionId ?? "",
          ...(event.parentSessionId ? { parentSessionId: event.parentSessionId } : {}),
          agentId,
          ...(event.agentDescription ? { agentDescription: event.agentDescription } : {}),
          callId: event.callId ?? "",
          tool: event.tool ?? "",
          input: event.input,
          ...(event.diff ? { diff: event.diff } : {}),
          ...(event.risk ? { risk: event.risk } : {}),
          ...(event.stale ? { stale: true } : {}),
          ...(event.kind ? { kind: event.kind } : {}),
          ...(event.command ? { command: event.command } : {}),
          ...(event.hookEvent ? { hookEvent: event.hookEvent } : {}),
          ...(event.matcher ? { matcher: event.matcher } : {}),
          ...(event.source ? { source: event.source } : {}),
          ...(event.hookReason ? { hookReason: event.hookReason } : {}),
        });
      }
      if (event.type === "approval_resolved" || event.type === "tool_finished") {
        removeApproval(undefined, event.callId);
      }
      updateSubagentRuns((current) => {
        const existing = current[agentId] ?? {
          agentId,
          parentSessionId: event.parentSessionId ?? "",
          callId: "",
          description: event.agentDescription ?? i18n.t("shell:subagent.label"),
          ...(event.agentType ? { agentType: event.agentType } : {}),
          status: "running" as const,
          startedAt: new Date().toISOString(),
          timeline: [],
          hydrated: false,
          live: true,
        };
        // 已结束的 Agent 不再接受迟到的流式/工具事件（重放或乱序）
        if (existing.status !== "running") return current;
        const clearPreparing =
          event.type === "message_start" ||
          event.type === "tool_started" ||
          event.type === "turn_complete" ||
          event.type === "error";
        let timeline = applyTimelineEvent(existing.timeline, event, nextKey);
        if (event.type === "error" && event.message) {
          timeline = [
            ...timeline,
            { kind: "error", key: nextKey("error"), message: event.message },
          ];
        }
        const usage: UsageSummary | undefined =
          event.type === "usage"
            ? (() => {
                // 子 Agent 也走同一套 roundId 替换语义：先撤旧样本再加新样本
                const key = `${agentId}:${event.roundId}`;
                const previous = subagentUsageSamplesRef.current.get(key);
                const base = {
                  inputTokens: existing.usage?.inputTokens ?? 0,
                  outputTokens: existing.usage?.outputTokens ?? 0,
                  cacheReadTokens: existing.usage?.cacheReadTokens ?? 0,
                  cacheWriteTokens: existing.usage?.cacheWriteTokens ?? 0,
                };
                if (event.retracted) {
                  subagentUsageSamplesRef.current.delete(key);
                  if (!previous) return existing.usage;
                  return {
                    inputTokens: Math.max(0, base.inputTokens - previous.input),
                    outputTokens: Math.max(0, base.outputTokens - previous.output),
                    cacheReadTokens: Math.max(0, base.cacheReadTokens - previous.cacheRead),
                    cacheWriteTokens: Math.max(0, base.cacheWriteTokens - previous.cacheWrite),
                  };
                }
                const next = mergeSample(previous, event);
                subagentUsageSamplesRef.current.set(key, next);
                return {
                  inputTokens: base.inputTokens + next.input - (previous?.input ?? 0),
                  outputTokens: base.outputTokens + next.output - (previous?.output ?? 0),
                  cacheReadTokens:
                    base.cacheReadTokens + next.cacheRead - (previous?.cacheRead ?? 0),
                  cacheWriteTokens:
                    base.cacheWriteTokens + next.cacheWrite - (previous?.cacheWrite ?? 0),
                };
              })()
            : existing.usage;
        return {
          ...current,
          [agentId]: {
            ...existing,
            timeline,
            live: existing.status === "running" ? true : existing.live,
            ...(clearPreparing ? { preparing: undefined } : {}),
            ...(usage ? { usage } : {}),
          },
        };
      });
    },
    [removeAgentApprovals, removeApproval, updateSubagentRuns, upsertApproval],
  );

  const handleEvent = useCallback((event: MeowEvent) => {
    if (event.agentId) {
      handleSubagentEvent(event);
      return;
    }
    // 源码管理里有动作（暂存/提交/切分支）：分支胶囊跟着刷新
    if (event.type === "git_changed") {
      setGitRevision((current) => current + 1);
      return;
    }
    if (event.type === "tool_call_progress") {
      if (!event.sessionId || event.sessionId === mainSessionIdRef.current) {
        setToolProgress({
          count: event.count ?? 0,
          ...(event.names?.length ? { names: event.names } : {}),
          ...(event.path ? { path: event.path } : {}),
        });
      }
      return;
    }
    // ask_user：模型反问澄清问题（可批量多题），挂起回合等用户点选/输入
    if (event.type === "ask_user" && (!event.sessionId || event.sessionId === mainSessionIdRef.current)) {
      setPendingAsk({
        callId: event.callId ?? "",
        questions: event.questions ?? [],
      });
      return;
    }
    // 治理 roadmap 快照：按会话保存最新状态（计划页签数据源）
    if (event.type === "workflow_roadmap" && event.sessionId) {
      const id = event.sessionId;
      const roadmap: WorkflowRoadmap = {
        tier: event.tier ?? "T1",
        completed: event.completed ?? false,
        lanes: event.lanes ?? [],
      };
      setWorkflowRoadmaps((current) => ({ ...current, [id]: roadmap }));
      return;
    }
    // 运行状态变化会让进行中的 loadCurrentSession 快照过期
    if (
      !event.side &&
      (event.type === "message_start" ||
        event.type === "turn_complete" ||
        event.type === "approval_required" ||
        event.type === "compaction_started" ||
        event.type === "compaction_completed" ||
        event.type === "compaction_failed")
    ) {
      runStateVersionRef.current += 1;
      if ("sessionId" in event && event.sessionId) {
        const id = event.sessionId;
        sessionRunVersionsRef.current[id] = (sessionRunVersionsRef.current[id] ?? 0) + 1;
      }
    }
    // 每个会话独立 runtime：事件只更新对应会话的运行圆点和审批，不影响当前会话
    if (!event.side && "sessionId" in event && event.sessionId) {
      if (event.type === "message_start" || event.type === "approval_required") {
        addRunningSession(event.sessionId);
      } else if (event.type === "turn_complete") {
        removeRunningSession(event.sessionId);
      }
      // ask_user 回合结束/中止/出错：挂起卡片一并清除（ask 挂起时回合不会正常结束，能到这里就该清）
      if (event.type === "turn_complete" || event.type === "error") {
        setPendingAsk(null);
      }
      // 压缩状态按会话记录：后台会话也已开始/结束压缩时同步更新
      if (event.type === "compaction_started") {
        addCompactingSession(event.sessionId);
      } else if (
        event.type === "compaction_completed" ||
        event.type === "compaction_failed" ||
        event.type === "turn_complete"
      ) {
        removeCompactingSession(event.sessionId);
      }
    }
    if (!event.side && event.type === "approval_required" && event.sessionId) {
      upsertApproval({
        sessionId: event.sessionId,
        callId: event.callId ?? "",
        tool: event.tool ?? "",
        input: event.input,
        ...(event.diff ? { diff: event.diff } : {}),
        ...(event.risk ? { risk: event.risk } : {}),
        ...(event.stale ? { stale: true } : {}),
        ...(event.kind ? { kind: event.kind } : {}),
        ...(event.command ? { command: event.command } : {}),
        ...(event.hookEvent ? { hookEvent: event.hookEvent } : {}),
        ...(event.matcher ? { matcher: event.matcher } : {}),
        ...(event.source ? { source: event.source } : {}),
        ...(event.hookReason ? { hookReason: event.hookReason } : {}),
      });
    }
    if (!event.side && event.type === "approval_resolved" && event.callId) {
      removeApproval(undefined, event.callId);
    }
    if (!event.side && event.type === "tool_finished") {
      removeApproval(undefined, event.callId);
    }
    if (!event.side && event.type === "turn_complete") {
      removeOwnApprovals(event.sessionId);
    }
    // 侧栏列表与后台会话也要刷新：切走时消息事件会被过滤，但会话不能从列表消失
    if (
      event.type === "message_start" ||
      event.type === "turn_complete" ||
      event.type === "session_title"
    ) {
      void reloadSessions();
    }
    // 后台会话的 AI 标题也要立即反映到左侧列表
    if (event.type === "session_title" && event.title && event.sessionId) {
      setSessions((prev) =>
        prev.map((item) =>
          item.id === event.sessionId ? { ...item, title: event.title ?? null } : item,
        ),
      );
    }
    // 关键分流：主/侧边会话共用一条 SSE——这里只处理主会话事件，
    // 侧边聊天页签自行订阅并按自己的 sessionId 过滤，避免流式增量互相污染。
    if (
      "sessionId" in event &&
      event.sessionId &&
      mainSessionIdRef.current &&
      event.sessionId !== mainSessionIdRef.current
    ) {
      return;
    }
    // 计划文档的写入过程：先开计划页签显示「正在写入」，写完由 plan_documented 刷新内容
    if (event.type === "tool_started") {
      const docPath = event.tool ? planDocPathOf(event.tool, event.input) : null;
      if (docPath) {
        setPlanWriting({ callId: event.callId ?? "", path: docPath });
        setPlanTabPath(docPath);
        sideTabsRef.current.open({ kind: "plan" });
        setShowInspector(true);
      }
    }
    if (event.type === "tool_finished") {
      setPlanWriting((current) => (current && current.callId === event.callId ? null : current));
    }
    // 回合结束兜底：工具事件缺失（中止/报错）时不让「正在写入」卡住
    if (event.type === "turn_complete") setPlanWriting(null);
    if (event.type === "agent_profile") {
      setAgentProfile(event.profile ?? "standard");
      return;
    }
    if (event.type === "session_mode") {
      const mode = event.mode ?? "default";
      chatModeRef.current = mode;
      setChatMode(mode);
      if (mode !== "plan") setPlanDocPath(null);
      return;
    }
    if (event.type === "plan_documented") {
      if (event.path) {
        // 只有仍在计划模式才弹确认卡片：确认执行后模型回写文档不该再拦输入框
        if (chatModeRef.current === "plan") setPlanDocPath(event.path);
        setPlanTabPath(event.path);
        setPlanDocVersion((current) => current + 1);
        setPlanWriting(null);
        sideTabsRef.current.open({ kind: "plan" });
        setShowInspector(true);
      }
      return;
    }
    if (event.type === "server.resync") {
      // 事件缺口超出重放缓冲（或服务端重启）：基于持久化状态整体恢复
      if (!mainSessionIdRef.current) return;
      void loadCurrentSession().then(() => {
        // 已结束子 Agent 的转录重新拉取；运行中的继续依赖 SSE 补发，避免覆盖实时增量。
        for (const tab of sideTabsRef.current.tabs) {
          if (tab.kind !== "subagent") continue;
          const run = subagentRunsRef.current[tab.agentId];
          if (!run || !run.live) void hydrateSubagent(tab.agentId, true);
        }
      });
      void reloadSessions();
      void refreshContextUsage();
      return;
    }
    if (event.type === "server.connected") {
      // 首次连接时还没有当前会话，交给启动时的 loadCurrentSession，避免空 id 误判
      if (!mainSessionIdRef.current) return;
      // SSE 重连：重新对账所有会话的运行/审批/队列状态（后台回合可能已经开始或结束）
      const wasRunning = runningSessionIdsRef.current.has(mainSessionIdRef.current);
      const globalVersion = runStateVersionRef.current;
      const sessionVersions = { ...sessionRunVersionsRef.current };
      const queueVersion = queueVersionRef.current;
      void api<{
        id?: string;
        runningSessionIds?: string[];
        pendingApprovals?: PendingApproval[];
        pendingAsk?: { callId: string; questions: Array<{ question: string; options: string[] }> } | null;
        queuedPrompts?: QueuedPrompt[];
        compactingSessionIds?: string[];
        subagents?: SubagentSummary[];
      }>("/session")
        .then((current) => {
          // 服务端重启/换工作区后当前会话可能已经变了：先对齐 id，再拉完整历史
          if (typeof current.id === "string" && current.id !== mainSessionIdRef.current) {
            mainSessionIdRef.current = current.id;
            clearQueuedPrompts();
            void reloadSessions();
            void loadCurrentSession();
            return;
          }
          mergeSubagentSummaries(current.subagents ?? []);
          // 断线期间已结束的子 Agent：重拉打开页签的转录，避免停在断线前的半截内容。
          const openSubagentIds = new Set(
            sideTabsRef.current.tabs
              .filter((tab) => tab.kind === "subagent")
              .map((tab) => (tab.kind === "subagent" ? tab.agentId : "")),
          );
          for (const item of current.subagents ?? []) {
            if (item.status !== "running" && openSubagentIds.has(item.agentId)) {
              void hydrateSubagent(item.agentId, true);
            }
          }
          const targetId = mainSessionIdRef.current ?? "";
          const targetStable =
            (sessionVersions[targetId] ?? 0) === (sessionRunVersionsRef.current[targetId] ?? 0);
          const globalStable = globalVersion === runStateVersionRef.current;
          if (!targetStable && !globalStable) return;
          if (targetStable) {
            if (queueVersion === queueVersionRef.current) {
              replaceQueuedPrompts(current.queuedPrompts ?? []);
            }
            sessionRunVersionsRef.current[targetId] =
              (sessionRunVersionsRef.current[targetId] ?? 0) + 1;
          }
          if (globalStable) {
            setRunningSessions(current.runningSessionIds ?? []);
            replaceApprovals(current.pendingApprovals ?? []);
        if ("pendingAsk" in current) setPendingAsk(current.pendingAsk ?? null);
            setCompactingSessions(current.compactingSessionIds ?? []);
            runStateVersionRef.current += 1;
          }
          if (!runningSessionIdsRef.current.has(targetId) && wasRunning) {
            // 断线期间当前回合已经结束：重拉历史，收尾等待状态
            clearQueuedPrompts();
            void loadCurrentSession();
          }
        })
        .catch(() => undefined);
      return;
    }
    setTimeline((items) => {
      const next = [...items];
      switch (event.type) {
        case "thinking_delta": {
          const last = next.at(-1);
          if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
            next[next.length - 1] = {
              ...last,
              thinking: (last.thinking ?? "") + (event.delta ?? ""),
            };
          } else {
            next.push({
              kind: "message",
              key: nextKey("thinking"),
              role: "assistant",
              content: "",
              thinking: event.delta ?? "",
              streaming: true,
            });
          }
          break;
        }
        case "assistant_delta": {
          const last = next.at(-1);
          if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
            next[next.length - 1] = { ...last, content: last.content + (event.delta ?? "") };
          } else {
            next.push({
              kind: "message",
              key: nextKey("assistant"),
              role: "assistant",
              content: event.delta ?? "",
              streaming: true,
            });
          }
          break;
        }
        case "message_complete": {
          const last = next.at(-1);
          if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
            next[next.length - 1] = {
              ...last,
              content: event.text ?? last.content,
              // 思考流已经累加在 item.thinking 里；complete 事件带回的全文优先（会话重连等场景）
              thinking: event.reasoning ?? last.thinking,
              streaming: false,
            };
          } else {
            next.push({
              kind: "message",
              key: nextKey("assistant"),
              role: "assistant",
              content: event.text ?? "",
              thinking: event.reasoning,
            });
          }
          break;
        }
        case "tool_started": {
          // 工具调用开始 = 上一条模型回复已经结束（中间轮次没有 message_complete）：先收尾流式条目
          finalizeStreamingAssistants(next);
          next.push({
            kind: "tool",
            key: nextKey("tool"),
            callId: event.callId ?? "",
            tool: event.tool ?? "",
            input: event.input,
          });
          break;
        }
        case "tool_output": {
          const index = next.findIndex((item) => item.kind === "tool" && item.callId === event.callId) as number;
          if (index >= 0) {
            const item = next[index] as TimelineTool;
            next[index] = {
          ...item,
          output: event.output ?? "",
          truncated: event.truncated,
          ...(event.spilled ? { spilled: event.spilled } : {}),
        };
          }
          break;
        }
        case "tool_finished": {
          const index = next.findIndex((item) => item.kind === "tool" && item.callId === event.callId) as number;
          if (index >= 0) {
            const item = next[index] as TimelineTool;
            next[index] = { ...item, ok: event.ok };
          }
          break;
        }
        case "turn_complete": {
          // 兜底：中止 / 报错 / 协议异常时也要让所有流式条目收尾
          finalizeStreamingAssistants(next);
          break;
        }
        default:
          break;
      }
      return next;
    });

    if (event.type === "message_start") {
      setToolProgress(null);
      if (event.queuedId) completeQueuedPrompt(event.queuedId);
      // 新回合：只重置回合计时；会话累计 token / 缓存命中率保留
      turnStartAtRef.current = performance.now();
      turnFirstTokenAtRef.current = null;
      roundFirstTokenAtRef.current = null;
      const totals = usageTotalsRef.current;
      setTurnMetrics({
        ...EMPTY_TURN_METRICS,
        inputTokens: totals.input || null,
        cacheReadTokens: totals.cacheReported ? totals.cacheRead : null,
        cacheWriteTokens: totals.cacheWrite || null,
        outputTokens: totals.output || null,
        cacheHitRate: hitRate(totals),
      });
    }
    if (event.type === "checkpoint_created") {
      // 流式回合的回退锚点：服务端打点后补挂到刚乐观追加的用户气泡上（时间线里最后一条没挂过的）
      setTimeline((items) => {
        for (let index = items.length - 1; index >= 0; index -= 1) {
          const item = items[index];
          if (item.kind !== "message" || item.role !== "user") continue;
          if (item.checkpointId) break; // 最早的一条未挂锚点的用户消息才是本次回合的
          const next = [...items];
          next[index] = {
            ...item,
            checkpointId: event.checkpointId,
            checkpointHasSnapshot: event.hasSnapshot,
          };
          return next;
        }
        return items;
      });
    }
    // 流式增量：记录首字延迟（整回合一次）与当轮首字时间（结算速度用）
    if (event.type === "thinking_delta" || event.type === "assistant_delta") {
      const now = performance.now();
      const start = turnStartAtRef.current;
      if (start != null && turnFirstTokenAtRef.current == null) {
        turnFirstTokenAtRef.current = now;
        setTurnMetrics((prev) => ({ ...(prev ?? EMPTY_TURN_METRICS), firstTokenMs: now - start }));
      }
      if (roundFirstTokenAtRef.current == null) roundFirstTokenAtRef.current = now;
    }
    if (event.type === "turn_complete") {
      const start = turnStartAtRef.current;
      if (start != null) turnStartAtRef.current = null;
      // 缓存命中率是会话累计，usage 到达时已实时更新，这里只补回合耗时
      setTurnMetrics((prev) => ({
        ...(prev ?? EMPTY_TURN_METRICS),
        ...(start != null ? { responseMs: performance.now() - start } : {}),
      }));
      roundFirstTokenAtRef.current = null;
      // 压缩被中止时不会收到 completed，收尾残留的运行中分隔线
      setTimeline((items) => clearRunningCompaction(items));
      // 每轮结束都重拉一次占用：服务商不回传用量时走估算，也能看到增长
      void refreshContextUsage();
    }
    if (event.type === "compaction_started") {
      const key = nextKey("compaction");
      setTimeline((items) => markCompactionStarted(items, key));
    }
    if (event.type === "compaction_completed") {
      const key = nextKey("compaction");
      setTimeline((items) => markCompactionCompleted(items, key, event.summary ?? ""));
      void refreshContextUsage(); // 压缩后占用骤降，重新拉一次（此时真实用量还没来）
    }
    if (event.type === "compaction_failed") {
      setTimeline((items) => clearRunningCompaction(items));
      void refreshContextUsage();
    }
    if (event.type === "usage") {
      // 真实 inputTokens 到达即更新圆圈，不用再拉一次接口；
      // 分类明细沿用上一次接口结果（回合结束会重拉刷新），没有就置零
      setContextUsage((prev) => {
        if (!event.inputTokens) return prev;
        const contextWindow = prev?.contextWindow ?? null;
        return {
          contextWindow,
          usedTokens: event.inputTokens,
          source: "usage",
          breakdown: prev?.breakdown ?? { system: 0, tools: 0, skills: 0, messages: 0, other: 0 },
          skillCount: prev?.skillCount,
          recommendedCompaction: shouldRecommendCompaction(event.inputTokens, contextWindow),
        };
      });
      // 响应统计：流中会多次上报同一轮，按 roundId 替换样本后派生累计
      const totals = updateUsageSample(event);
      const now = performance.now();
      const roundStart = roundFirstTokenAtRef.current;
      const roundOutput = typeof event.outputTokens === "number" ? event.outputTokens : null;
      // 速度只在最终真值上结算：实时样本提前清掉起点会把本轮速度算到下一轮头上
      const final = event.final === true;
      const seconds = final && roundStart != null ? (now - roundStart) / 1000 : 0;
      const speed =
        final && roundOutput != null && roundOutput > 0 && seconds >= 0.05
          ? roundOutput / seconds
          : null;
      if (final) roundFirstTokenAtRef.current = null;
      setTurnMetrics((prev) => {
        const base = prev ?? EMPTY_TURN_METRICS;
        return {
          ...base,
          inputTokens: totals.input || base.inputTokens,
          cacheReadTokens: totals.cacheReported ? totals.cacheRead : null,
          cacheWriteTokens: totals.cacheWrite || null,
          outputTokens: totals.output || base.outputTokens,
          tokensPerSecond: speed ?? base.tokensPerSecond,
          cacheHitRate: hitRate(totals),
        };
      });
      // 缓存诊断（只在最终真值上结算）：本轮读/写给弹层，状态/原因与失配计数进聚合。
      // bust 基线按模型分：换模型后的读数跌落是冷启动，不算失配。
      if (final) {
        const sample = event.roundId ? usageSamplesRef.current.get(event.roundId) : undefined;
        const read = sample?.cacheReported ? sample.cacheRead : null;
        const write = sample?.cacheWrite ?? null;
        const model = event.model ?? "";
        const baseline = lastCacheReadRef.current;
        const bust =
          read != null && baseline != null && baseline.model === model && isCacheBust(baseline, { read });
        if (read != null) lastCacheReadRef.current = { model, read };
        setCacheDiagnostics((prev) => ({
          lastRound: { read, write },
          lastState: event.cacheState ?? prev.lastState,
          lastReason: event.cacheReason ?? prev.lastReason,
          busts: prev.busts + (bust ? 1 : 0),
          lastBustDrop: bust && baseline != null && read != null ? baseline.read - read : prev.lastBustDrop,
          rebuilds:
            event.cacheState && event.cacheState !== "warm" && event.cacheReason
              ? { ...prev.rebuilds, [event.cacheReason]: (prev.rebuilds[event.cacheReason] ?? 0) + 1 }
              : prev.rebuilds,
        }));
      }
      // 网关缓存诊断：逐出/不支持时留一条轻提示，每个会话每种状态只提示一次。
      if (event.cacheState === "evicted" || event.cacheState === "unsupported") {
        const sessionKey = `${event.sessionId ?? ""}:${event.cacheState}`;
        if (cacheNoticeRef.current !== sessionKey) {
          cacheNoticeRef.current = sessionKey;
          const message =
            event.cacheState === "evicted"
              ? i18n.t("shell:notice.cacheEvicted")
              : i18n.t("shell:notice.cacheUnsupported");
          setTimeline((items) => [
            ...items,
            { kind: "notice", key: `cache-${sessionKey}-${Date.now()}`, message },
          ]);
        }
      }
    }
    if (
      event.type === "tool_started" ||
      event.type === "tool_finished" ||
      event.type === "turn_complete" ||
      event.type === "error"
    ) {
      setToolProgress(null);
    }
    if (event.type === "error") {
      pushError(event.message ?? "Agent error");
    }
    if (event.type === "session_title" && event.title) {
      setSessionTitle(event.title);
    }
    if (event.type === "provider_switched") {
      // 故障转移：服务商临时故障（超时/限流/5xx）时本回合已换到备用模型，
      // 在时间线留一条轻提示，避免用户以为模型"脾气变了"。
      const reason =
        event.reason === "timeout"
          ? i18n.t("shell:error.reason.timeout")
          : event.reason === "rate_limit"
            ? i18n.t("shell:error.reason.rateLimit")
            : event.reason === "server"
              ? i18n.t("shell:error.reason.server")
              : event.reason;
      const key = `provider-switched-${event.from}-${event.to}-${Date.now()}`;
      setTimeline((items) => [
        ...items,
        {
          kind: "notice",
          key,
          message: i18n.t("shell:notice.providerSwitched", {
            from: event.from,
            to: event.to,
            reason,
          }),
        },
      ]);
    }
    if (event.type === "file_changed") {
      // 审阅自动展开：页签不存在才新建并激活；已存在只让 ReviewTab 自己刷新
      if (!event.sessionId || event.sessionId === sessionIdRef.current) {
        scheduleSessionChangesRefresh();
      }
      if (sideTabsRef.current.openIfAbsent("review")) setShowInspector(true);
    }
    if (event.type === "files_rewound") {
      // 仅回滚代码完成：审阅面板与 git 面板的数据源（磁盘）已变化，自动展开审阅
      if (!event.sessionId || event.sessionId === sessionIdRef.current) {
        scheduleSessionChangesRefresh();
      }
      if (sideTabsRef.current.openIfAbsent("review")) setShowInspector(true);
    }
    if (
      event.type === "turn_complete" &&
      (!event.sessionId || event.sessionId === sessionIdRef.current)
    ) {
      scheduleSessionChangesRefresh();
    }
    if (event.type === "plan_updated") {
      setPlan({
        steps: event.steps ?? [],
        ...(event.explanation ? { explanation: event.explanation } : {}),
      });
    }
  }, [
    scheduleSessionChangesRefresh,
    refreshContextUsage,
    pushError,
    reloadSessions,
    updateUsageSample,
    completeQueuedPrompt,
    loadCurrentSession,
    clearQueuedPrompts,
    addRunningSession,
    removeRunningSession,
    setRunningSessions,
    replaceApprovals,
    replaceQueuedPrompts,
    upsertApproval,
    removeApproval,
    removeOwnApprovals,
    removeAgentApprovals,
    handleSubagentEvent,
    mergeSubagentSummaries,
    hydrateSubagent,
  ]);

  useEffect(() => {
    let disposed = false;

    const boot = async () => {
      try {
        const [loadedSettings, loadedUi] = await Promise.all([
          window.meow.getSettings(),
          window.meow.getUiState(),
        ]);
        if (disposed) return;
        setSettings(loadedSettings);
        setThemePreference(loadedSettings.theme ?? "system");
        // 磁盘上的偏好是权威值：镜像可能滞后（换机、清缓存、旧版本写过别的语言）
        syncLanguageFromSettings(loadedSettings.language);
        setDrafts(loadedUi.drafts ?? {});
        setShowInspector(loadedUi.inspector.visible);
        setInspectorWidth(clampInspectorWidth(loadedUi.inspector.width, LIST_MIN_WIDTH));
        const restoredTabs: SideTab[] = (loadedUi.tabs ?? []).flatMap((tab): SideTab[] => {
          if (tab.kind === "browser") {
            return [{ id: tab.id, kind: "browser", title: tab.title, url: tab.url ?? "" }];
          }
          if (tab.kind === "workspace") {
            return [
              {
                id: tab.id,
                kind: "workspace",
                title: tab.title,
                ...(tab.path ? { path: tab.path } : {}),
              },
            ];
          }
          if (tab.kind === "subagent") {
            if (!tab.agentId || !tab.parentSessionId) return [];
            return [
              {
                id: tab.id,
                kind: "subagent",
                title: tab.title,
                agentId: tab.agentId,
                parentSessionId: tab.parentSessionId,
                ...(tab.callId ? { callId: tab.callId } : {}),
                ...(tab.description ? { description: tab.description } : {}),
              },
            ];
          }
          if (tab.kind === "plugin") {
            if (!tab.pluginId) return [];
            return [{ id: tab.id, kind: "plugin", title: tab.title, pluginId: tab.pluginId }];
          }
          return [{ id: tab.id, kind: tab.kind, title: tab.title }];
        });
        sideTabs.hydrate(restoredTabs, loadedUi.activeTabId);
        setUiHydrated(true);
        // 首次启动先进引导；已完成引导但一个模型都没配时直接进设置页
        if (loadedSettings.onboardingCompleted === false) {
          setOnboardingOpen(true);
        } else if (!loadedSettings.providers?.length) {
          setView("settings");
        }
        const active = await loadCurrentSession();
        if (!active && loadedSettings.workspace) {
          await api("/session/new", {
            method: "POST",
            body: JSON.stringify({ cwd: loadedSettings.workspace }),
          });
          await loadCurrentSession();
        }
        void refreshContextUsage();
        void window.meow.getAppInfo().then((info) => {
          if (!disposed) setAppInfo(info);
        });
      } catch (err) {
        if (!disposed) pushError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!disposed) setReady(true);
      }
      void reloadSessions();
    };

    void boot();
    const unsubscribe = window.meow.onEvent(handleEvent);
    // 悬浮岛发出的 prompt：服务端事件不携带用户消息文本，当前会话命中时在这里补气泡。
    // 排队场景（回合进行中）气泡会先于执行出现——悬浮岛侧已有同款展示，可接受。
    const unsubscribeIslandPrompt = window.meow.onIslandPromptSent(({ sessionId, text }) => {
      if (disposed || !sessionId || sessionId !== mainSessionIdRef.current || !text) return;
      setTimeline((items) => [
        ...items,
        { kind: "message", key: nextKey("user"), role: "user", content: text },
      ]);
    });
    const unsubscribeSettings = window.meow.onOpenSettings(() => {
      if (!disposed) setView("settings");
    });
    const unsubscribeClose = window.meow.onCloseRequest(() => {
      if (!disposed) setCloseAsk(true);
    });
    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeIslandPrompt();
      unsubscribeSettings();
      unsubscribeClose();
    };
  }, [handleEvent, loadCurrentSession, refreshContextUsage, reloadSessions, sideTabs.hydrate]);

  const sendPrompt = useCallback(async (
    overrideText?: string,
    recoveredId?: string,
    images?: ComposerImage[],
  ) => {
    // 附件 chip：绝对路径（不限工作区），作为首部【附件】行交给运行时注入文件内容
    const attachmentLines = chips
      .filter((chip) => chip.kind === "file")
      .map((chip) => `【附件】${chip.name} · ${chip.path}`); // i18n-allow 消息首部协议标记，与 src/agent 解析约定一致
    // 技能/插件引用 chip：首部叠加多行标记；插件命令独占，展开后是一整段指令
    const rawInput = overrideText ?? input;
    const commandChip = chips.find((chip) => chip.kind === "command");
    // 手输 `/命令` 时 Composer 已构造好命令标记，不能再把技能引用前缀叠到它前面
    const inputIsCommandMarker = rawInput.trimStart().startsWith("【插件命令】"); // i18n-allow 消息首部协议标记，与 src/agent 解析约定一致
    const referenceLines = inputIsCommandMarker
      ? []
      : [
          ...attachmentLines,
          ...chips
            .filter((chip) => chip.kind === "skill" || chip.kind === "plugin")
            .map((chip) =>
              chip.kind === "skill"
                ? `【技能引用】${chip.name} · ${chip.id}` // i18n-allow 消息首部协议标记，与 src/agent 解析约定一致
                : `【插件引用】${chip.name} · ${chip.id}`, // i18n-allow 消息首部协议标记，与 src/agent 解析约定一致
            ),
        ];
    const referencePrefix = referenceLines.length
      ? `${referenceLines.join("\n")}\n\n`
      : "";
    const trimmedArgs = rawInput.trim();
    // 命令 + 附件：附件行贴在命令头下一行（仍在首部块内，运行时照常注入），
    // 空行之后才是展开的指令 —— UserBubble / 运行时都按这个结构解析。
    const commandAttachments = attachmentLines.length ? `\n${attachmentLines.join("\n")}` : "";
    const commandText =
      commandChip && commandChip.kind === "command"
        ? `【插件命令】${commandChip.name} · ${commandChip.id} · ${commandChip.command}${commandAttachments}\n\n/${commandChip.command}${trimmedArgs ? ` ${trimmedArgs}` : ""}` // i18n-allow 消息首部协议标记，与 src/agent 解析约定一致
        : "";
    // 手输 `/命令`（Composer 已把标记拼进 overrideText）：附件行插进标记的首部块，
    // 不能挂在前面 —— 否则 `【插件命令】` 不再是首行，气泡与运行时都解析不到命令。
    const withAttachments = (marker: string): string => {
      if (!attachmentLines.length) return marker;
      const block = attachmentLines.join("\n");
      const blank = marker.indexOf("\n\n");
      return blank < 0
        ? `${marker}\n${block}`
        : `${marker.slice(0, blank)}\n${block}${marker.slice(blank)}`;
    };
    const text = (
      commandChip
        ? commandText
        : inputIsCommandMarker
          ? withAttachments(rawInput)
          : referencePrefix + rawInput
    ).trim();
    if (!text && !images?.length) return;
    if (compacting || sessionSwitching || worktreeBusy) return;
    const queued = streaming;
    const firstSend = !timeline.some(
      (item) => item.kind === "message" && item.role === "user",
    );
    let targetSessionId = session?.id;
    let createdWorktree = false;
    if (!queued && worktreeIntent && firstSend && !session?.worktree && projectCwd) {
      setSessionSwitching(true);
      try {
        const created = await api<{
          id?: string;
          worktree?: SessionWorktree | null;
          worktreeDirty?: boolean;
        }>("/session/new", {
          method: "POST",
          body: JSON.stringify({
            cwd: projectCwd,
            worktree: true,
            worktreeSettings: {
              fetchUpstream: settings?.worktreeFetchUpstream ?? false,
              autoCleanup: settings?.worktreeAutoCleanup ?? true,
              maxKeep: settings?.worktreeMaxKeep ?? 15,
            },
          }),
        });
        if (!created?.id) throw new Error("Worktree session was not created.");
        mainSessionIdRef.current = created.id;
        targetSessionId = created.id;
        createdWorktree = true;
        setWorktreeIntent(false);
        setTimeline([]);
        setSessionTitle(null);
        setPlan(null);
        setContextWarningDismissed(false);
        const loaded = await loadCurrentSession();
        if (!loaded) throw new Error(t("error.worktreeLoad"));
        void refreshContextUsage();
        await reloadSessions();
        if (created.worktreeDirty) {
          showToast(t("toast.worktreeDirty"));
        }
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
        return;
      } finally {
        setSessionSwitching(false);
      }
    }
    if (overrideText === undefined) setInput("");
    if (chips.length) setChips([]);
    let queueId: string | undefined;
    let userKey: string | undefined;
    if (queued) {
      queueId = nextKey("queued");
      enqueueQueuedPrompt({ id: queueId, text });
    } else {
      const key = nextKey("user");
      userKey = key;
      // 缩略图只在前端时间线里用，发给后端的是纯 base64
      const timelineImages = images?.map(({ mimeType, dataUrl, name }) => ({
        mimeType,
        dataUrl,
        ...(name ? { name } : {}),
      }));
      setTimeline((items) => [
        ...items,
        {
          kind: "message",
          key,
          role: "user",
          content: text,
          ...(timelineImages?.length ? { images: timelineImages } : {}),
        },
      ]);
    }
    // 乐观入列：发送即出现在左侧列表，不等 message_start / 标题生成
    if (targetSessionId) {
      setSessions((list) => {
        const existing = list.find((item) => item.id === targetSessionId);
        if (existing) {
          if (existing.messageCount > 0) return list;
          return list.map((item) =>
            item.id === targetSessionId ? { ...item, messageCount: 1 } : item,
          );
        }
        // 刚建的 worktree 会话已经由 reloadSessions 带入；没有会话对象可复用时不硬造
        if (createdWorktree || !session) return list;
        return [
          {
            id: session.id,
            filePath: session.filePath,
            cwd: session.cwd,
            createdAt: session.createdAt,
            title: sessionTitle,
            messageCount: 1,
          },
          ...list,
        ];
      });
    }
    try {
      await api("/session/prompt", {
        method: "POST",
        body: JSON.stringify({
          message: text,
          ...(queueId ? { queueId } : {}),
          ...(images?.length
            ? { images: images.map(({ mimeType, data }) => ({ mimeType, data })) }
            : {}),
        }),
      });
      // 乐观置位：POST 受理后立刻把本会话标成运行中，不等 message_start
      if (!queued && targetSessionId) addRunningSession(targetSessionId);
      if (recoveredId) {
        setRecoveredPrompts((items) => items.filter((item) => item.id !== recoveredId));
        void api("/session/recovered/discard", {
          method: "POST",
          body: JSON.stringify({ id: recoveredId }),
        }).catch(() => undefined);
      }
    } catch (err) {
      if (queueId) dropQueuedPrompt(queueId);
      // 请求没被受理：撤掉乐观消息/队列项，输入还给用户
      setInput((current) => (current ? current : text));
      if (!queued) {
        setTimeline((items) => items.filter((item) => item.key !== userKey));
        if (targetSessionId) removeRunningSession(targetSessionId);
        void reloadSessions();
      }
      pushError(err instanceof Error ? err.message : String(err));
    }
  }, [
    input,
    chips,
    streaming,
    compacting,
    sessionSwitching,
    session,
    sessionTitle,
    timeline,
    worktreeIntent,
    worktreeBusy,
    projectCwd,
    loadCurrentSession,
    refreshContextUsage,
    showToast,
    addRunningSession,
    removeRunningSession,
    enqueueQueuedPrompt,
    dropQueuedPrompt,
    pushError,
    reloadSessions,
    t,
  ]);

  /** 发送上次未交付的排队消息：走正常 prompt，并把它从恢复列表移除。 */
  const sendRecoveredPrompt = useCallback(
    (item: QueuedPrompt) => {
      void sendPrompt(item.text, item.id);
    },
    [sendPrompt],
  );

  const discardRecoveredPrompt = useCallback(
    async (id: string) => {
      try {
        await api("/session/recovered/discard", {
          method: "POST",
          body: JSON.stringify({ id }),
        });
        setRecoveredPrompts((items) => items.filter((item) => item.id !== id));
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      }
    },
    [pushError],
  );

  /** 回答 ask_user 问题：清卡片 + 通知 server resolve 挂起的工具（answers 按题序对齐） */
  const answerAsk = useCallback((callId: string, answers: string[]) => {
    setPendingAsk(null);
    void api("/session/answer", {
      method: "POST",
      body: JSON.stringify({ callId, answers }),
    }).catch(() => undefined);
  }, []);

  const respondApproval = useCallback(
    async (approved: boolean) => {
      if (!approval) return;
      const current = approval;
      removeApproval(current.sessionId, current.callId);
      try {
        await api("/approval/response", {
          method: "POST",
          body: JSON.stringify({ callId: current.callId, approved }),
        });
        setTimeline((items) => {
          const index = items.findIndex((item) => item.kind === "tool" && item.callId === current.callId);
          if (index < 0) return items;
          const next = [...items];
          const item = next[index] as TimelineTool;
          next[index] = approved ? item : { ...item, ok: false, output: "User denied this tool call." };
          return next;
        });
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      }
    },
    [approval, pushError, removeApproval],
  );

  /** 关闭确认结果回传主进程：托盘 / 退出由主进程执行，取消什么都不做 */
  const decideClose = useCallback((choice: "tray" | "quit" | "cancel", remember: boolean) => {
    setCloseAsk(false);
    void window.meow.respondClose(choice, remember);
  }, []);

  /** 轻量偏好（主题 / 关闭方式 / 归档 / 侧栏项目）：只写盘，不重启 agent server。返回值同步回 state。 */
  const savePreferences = useCallback(async (prefs: Partial<Preferences>): Promise<boolean> => {
    if (prefs.theme !== undefined) setThemePreference(prefs.theme);
    // 语言先就地切换：界面要立即跟随，落盘由下面的 IPC 负责，不阻塞视觉反馈
    if (prefs.language !== undefined) applyLanguage(prefs.language);
    // 语色先乐观更新：下拉立即显示新值；落盘失败再回滚
    const nextSpeechStyle = prefs.speechStyle;
    const previousSpeechStyle = settings?.speechStyle ?? "normal";
    if (nextSpeechStyle !== undefined) {
      setSettings((prev) => (prev ? { ...prev, speechStyle: nextSpeechStyle } : prev));
    }
    // 系统通知开关同理：点一下立刻变，落盘失败再回滚，避免"点了没反应"
    const nextNotifications = prefs.notifications;
    const previousNotifications = settings?.notifications ?? true;
    if (nextNotifications !== undefined) {
      setSettings((prev) => (prev ? { ...prev, notifications: nextNotifications } : prev));
    }
    try {
      const saved = await window.meow.savePreferences(prefs);
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              theme: saved?.theme ?? prev.theme,
              closeAction: saved?.closeAction ?? prev.closeAction,
              language: saved?.language ?? prev.language,
              speechStyle: saved?.speechStyle ?? prev.speechStyle,
              onboardingCompleted: saved?.onboardingCompleted ?? prev.onboardingCompleted,
              silentUpdate: typeof saved?.silentUpdate === "boolean" ? saved.silentUpdate : prev.silentUpdate,
              notifications:
                typeof saved?.notifications === "boolean"
                  ? saved.notifications
                  : prev.notifications,
              floatingIsland:
                typeof saved?.floatingIsland === "boolean" ? saved.floatingIsland : prev.floatingIsland,
              worktreeFetchUpstream:
                typeof saved?.worktreeFetchUpstream === "boolean"
                  ? saved.worktreeFetchUpstream
                  : prev.worktreeFetchUpstream,
              worktreeAutoCleanup:
                typeof saved?.worktreeAutoCleanup === "boolean"
                  ? saved.worktreeAutoCleanup
                  : prev.worktreeAutoCleanup,
              worktreeMaxKeep:
                typeof saved?.worktreeMaxKeep === "number"
                  ? saved.worktreeMaxKeep
                  : prev.worktreeMaxKeep,
              includeAgentsMd:
                typeof saved?.includeAgentsMd === "boolean"
                  ? saved.includeAgentsMd
                  : prev.includeAgentsMd,
              includeClaudeMd:
                typeof saved?.includeClaudeMd === "boolean"
                  ? saved.includeClaudeMd
                  : prev.includeClaudeMd,
              fontFamily: typeof saved?.fontFamily === "string" ? saved.fontFamily : prev.fontFamily,
              codeFontFamily:
                typeof saved?.codeFontFamily === "string" ? saved.codeFontFamily : prev.codeFontFamily,
              projectNames: saved?.projectNames ?? prev.projectNames,
              pinnedProjects: saved?.pinnedProjects ?? prev.pinnedProjects,
              removedProjects: saved?.removedProjects ?? prev.removedProjects,
              ...(Array.isArray(saved?.archivedSessions)
                ? { archivedSessions: saved.archivedSessions }
                : Array.isArray(prefs.archivedSessions)
                  ? { archivedSessions: prefs.archivedSessions }
                  : {}),
            }
          : prev,
      );
      // 落盘成功后热更新运行中的 server；失败不回滚偏好（下次启动仍会生效）
      if (nextSpeechStyle !== undefined) {
        try {
          await setSpeechStyle(nextSpeechStyle);
        } catch (err) {
          pushError(
            `语色已保存，重启 MeowCode 后生效：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return true;
    } catch (err) {
      if (nextSpeechStyle !== undefined) {
        setSettings((prev) => (prev ? { ...prev, speechStyle: previousSpeechStyle } : prev));
      }
      if (nextNotifications !== undefined) {
        setSettings((prev) => (prev ? { ...prev, notifications: previousNotifications } : prev));
      }
      pushError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [pushError, settings?.speechStyle, settings?.notifications]);

  // ---- 界面字体（外观设置）：导入的自定义字体注册成 @font-face，选中字体写进 --font-app ----

  const [customFonts, setCustomFonts] = useState<Array<{ family: string; url: string }>>([]);
  const reloadCustomFonts = useCallback(() => {
    void listCustomFonts()
      .then(setCustomFonts)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    reloadCustomFonts();
  }, [reloadCustomFonts]);

  // 自定义字体挂到 head 里的专用 style 节点：导入新字体后整段重写
  useEffect(() => {
    let style = document.getElementById("mc-custom-fonts") as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "mc-custom-fonts";
      document.head.appendChild(style);
    }
    style.textContent = customFonts
      .map(
        (font) =>
          `@font-face { font-family: "${font.family}"; src: url("${font.url}"); font-display: swap; }`,
      )
      .join("\n");
  }, [customFonts]);

  // tokens.css 的 --font-sans 首选位读 --font-app；空串清掉变量，回退内置 MiSans
  const fontFamily = (settings?.fontFamily ?? "").trim();
  useEffect(() => {
    if (fontFamily) {
      document.documentElement.style.setProperty("--font-app", `"${fontFamily.replace(/"/g, "")}"`);
    } else {
      document.documentElement.style.removeProperty("--font-app");
    }
  }, [fontFamily]);

  // tokens.css 的 --font-mono 首选位读 --font-code；空串清掉变量，回退默认等宽栈
  const codeFontFamily = (settings?.codeFontFamily ?? "").trim();
  useEffect(() => {
    if (codeFontFamily) {
      document.documentElement.style.setProperty("--font-code", `"${codeFontFamily.replace(/"/g, "")}"`);
    } else {
      document.documentElement.style.removeProperty("--font-code");
    }
  }, [codeFontFamily]);

  /** 外观设置「导入字体…」：主进程拷文件入库，成功后刷新 @font-face 并返回展示名 */
  const importFont = useCallback(async (): Promise<string | null> => {
    try {
      const result = await importFontFile();
      if (!result.ok || !result.family) return null;
      reloadCustomFonts();
      return result.family;
    } catch {
      return null;
    }
  }, [reloadCustomFonts]);

  /** 删除已导入的自定义字体：清记录删文件；当前正使用它时由外观页把选择重置回默认 */
  const removeCustomFont = useCallback(
    async (family: string): Promise<boolean> => {
      try {
        const result = await window.meow.removeCustomFont(family);
        if (!result.ok) return false;
        reloadCustomFonts();
        return true;
      } catch {
        return false;
      }
    },
    [reloadCustomFonts],
  );

  // ---- 侧栏项目（工作区）操作 ----

  /** 编辑显示名（只改侧栏标签；空名恢复文件夹名） */
  const renameProject = useCallback(
    (cwd: string, name: string) => {
      const next = { ...settings?.projectNames };
      const trimmed = name.trim();
      if (trimmed) next[cwd] = trimmed;
      else delete next[cwd];
      void savePreferences({ projectNames: next });
    },
    [settings?.projectNames, savePreferences],
  );

  const togglePinProject = useCallback(
    (cwd: string) => {
      const current = settings?.pinnedProjects ?? [];
      void savePreferences({
        pinnedProjects: current.includes(cwd) ? current.filter((item) => item !== cwd) : [...current, cwd],
      });
    },
    [settings?.pinnedProjects, savePreferences],
  );

  /** 移除项目 = 侧栏隐藏（会话与磁盘文件都不动）；之后在该工作区新建聊天时自动恢复 */
  const removeProject = useCallback(
    (cwd: string) => {
      const current = settings?.removedProjects ?? [];
      if (!current.includes(cwd)) void savePreferences({ removedProjects: [...current, cwd] });
    },
    [settings?.removedProjects, savePreferences],
  );

  /** 归档整个项目的聊天（并入归档列表，可在 设置 → 归档 恢复） */
  const archiveProject = useCallback(
    (filePaths: string[]) => {
      const current = settings?.archivedSessions ?? [];
      void savePreferences({ archivedSessions: [...new Set([...current, ...filePaths])] });
    },
    [settings?.archivedSessions, savePreferences],
  );

  const openProject = useCallback(
    async (cwd: string) => {
      const message = await window.meow.openPath(cwd);
      if (message) pushError(message);
    },
    [pushError],
  );

  const createSession = useCallback(
    async (cwd?: string) => {
      setSessionSwitching(true);
      try {
        const target = cwd ?? settings?.workspace;
        if (!target) {
          setView("settings");
          return;
        }
        clearQueuedPrompts();
        setRecoveredPrompts([]);
        setLastTurn(null);
        const created = await api<{ id?: string }>("/session/new", {
          method: "POST",
          body: JSON.stringify({ cwd: target }),
        });
        // 立即切换事件过滤目标：否则新会话正在流式时，开头事件会被当成别的会话丢掉
        if (created?.id) mainSessionIdRef.current = created.id;
        // 在这个项目里新建聊天 → 若它被「移除项目」隐藏过，自动恢复（侧栏重新出现）
        const removed = settings?.removedProjects ?? [];
        if (removed.includes(target)) {
          void savePreferences({ removedProjects: removed.filter((item) => item !== target) });
        }
        setTimeline([]);
        setSessionTitle(null); // 新会话还没有标题
        setPlan(null);
        setContextWarningDismissed(false);
        setView("chat");
        await loadCurrentSession();
        void refreshContextUsage();
        await reloadSessions();
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      } finally {
        setSessionSwitching(false);
      }
    },
    [
      settings?.workspace,
      settings?.removedProjects,
      savePreferences,
      loadCurrentSession,
      refreshContextUsage,
      reloadSessions,
      pushError,
      clearQueuedPrompts,
    ],
  );

  const switchSession = useCallback(
    async (filePath: string) => {
      setSessionLoading(true);
      setSessionSwitching(true);
      try {
        clearQueuedPrompts();
        setRecoveredPrompts([]);
        setLastTurn(null);
        const switched = await api<{ id?: string }>("/session/switch", {
          method: "POST",
          body: JSON.stringify({ filePath }),
        });
        if (switched?.id) mainSessionIdRef.current = switched.id;
        setTimeline([]);
        setSessionTitle(null); // 切换后由 loadCurrentSession 恢复
        setPlan(null);
        setContextWarningDismissed(false);
        await loadCurrentSession();
        void refreshContextUsage();
        void reloadSessions();
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      } finally {
        setSessionLoading(false);
        setSessionSwitching(false);
      }
    },
    [loadCurrentSession, refreshContextUsage, pushError, clearQueuedPrompts, reloadSessions],
  );

  /** 检索命中 → 打开会话并定位到命中消息；当前会话内直接滚过去（switchSession 不抛错，失败时锚点找不到即无操作） */
  const openSearchHit = useCallback(
    async (hit: SessionSearchHit, snippet: SessionSearchSnippet | null) => {
      if (hit.filePath !== session?.filePath) {
        await switchSession(hit.filePath);
      }
      if (!snippet) return;
      setMessageFocus(null);
      requestAnimationFrame(() => {
        searchFocusSeqRef.current += 1;
        setMessageFocus({ messageIndex: snippet.messageIndex, token: searchFocusSeqRef.current });
      });
    },
    [session?.filePath, switchSession],
  );

  /** 侧栏重命名任意会话：立即更新列表与当前标题，服务端也会广播。 */
  const renameSessionByPath = useCallback(
    async (filePath: string, title: string) => {
      try {
        const saved = await api<{ title: string }>("/sessions/title", {
          method: "PUT",
          body: JSON.stringify({ filePath, title }),
        });
        setSessions((list) =>
          list.map((item) =>
            item.filePath === filePath ? { ...item, title: saved.title } : item,
          ),
        );
        if (session?.filePath === filePath) setSessionTitle(saved.title);
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      }
    },
    [session?.filePath, pushError],
  );

  // 回退/恢复的派生会话标题会带「（回滚）/（检查点…）」后缀；加载到这种会话时还原成原标题。
  useEffect(() => {
    if (!session?.filePath || !sessionTitle) return;
    const original = sessionTitle
      .replace(/（回滚）$/, "")
      .replace(/（检查点[^）]*）$/, "");
    if (original !== sessionTitle && original.trim()) {
      void renameSessionByPath(session.filePath, original);
    }
  }, [session?.filePath, sessionTitle, renameSessionByPath]);

  /**
   * 批量删除会话文件（聊天列表单删与归档区单删/全删共用）。
   * 逐个删：一个失败（比如会话还在生成）不该把其余的也拦下来；
   * 返回真正删掉的路径，调用方据此决定要不要从归档列表里移除。
   */
  const deleteSessionsByPath = useCallback(
    async (filePaths: string[]): Promise<string[]> => {
      if (!filePaths.length) return [];
      const currentPath = session?.filePath;
      const deletedPaths: string[] = [];
      let deletedCurrent = false;
      for (const filePath of filePaths) {
        try {
          const deleted = await api<{ activeSessionId?: string }>("/sessions/delete", {
            method: "POST",
            body: JSON.stringify({ filePath }),
          });
          if (deleted?.activeSessionId) mainSessionIdRef.current = deleted.activeSessionId;
          deletedPaths.push(filePath);
          if (currentPath === filePath) deletedCurrent = true;
        } catch (err) {
          pushError(err instanceof Error ? err.message : String(err));
        }
      }
      if (deletedCurrent) {
        clearQueuedPrompts();
        setRecoveredPrompts([]);
        setLastTurn(null);
        setTimeline([]);
        setSessionTitle(null);
        setPlan(null);
        setContextWarningDismissed(false);
        await loadCurrentSession();
        void refreshContextUsage();
      }
      if (deletedPaths.length) await reloadSessions();
      return deletedPaths;
    },
    [
      session?.filePath,
      clearQueuedPrompts,
      loadCurrentSession,
      refreshContextUsage,
      reloadSessions,
      pushError,
    ],
  );

  /** 删除会话；若删的是当前会话，服务端会立刻新建一个同工作区的空会话。 */
  const deleteSessionByPath = useCallback(
    async (filePath: string) => {
      await deleteSessionsByPath([filePath]);
    },
    [deleteSessionsByPath],
  );

  /**
   * 归档区删除：先删文件，再把**真正删掉的**从 archivedSessions 里摘掉。
   * 顺序很重要 —— 删除失败（会话还在生成）时它得继续留在归档列表里，
   * 否则文件还在、列表里却看不见，就成了谁都找不到的孤儿。
   */
  const deleteArchivedSessions = useCallback(
    async (filePaths: string[]) => {
      const current = settings?.archivedSessions ?? [];
      const targets = filePaths.filter((path) => current.includes(path));
      if (!targets.length) return;
      const deleted = await deleteSessionsByPath(targets);
      if (!deleted.length) return;
      const remaining = current.filter((path) => !deleted.includes(path));
      void savePreferences({ archivedSessions: remaining });
    },
    [settings?.archivedSessions, deleteSessionsByPath, savePreferences],
  );

  /** 从会话末尾复制一份完整历史，创建并切换到新分支。 */
  const branchSessionByPath = useCallback(
    async (filePath: string) => {
      setSessionLoading(true);
      setSessionSwitching(true);
      try {
        clearQueuedPrompts();
        setRecoveredPrompts([]);
        setLastTurn(null);
        const branch = await api<{ id?: string }>("/sessions/branch", {
          method: "POST",
          body: JSON.stringify({ filePath }),
        });
        if (branch?.id) mainSessionIdRef.current = branch.id;
        setTimeline([]);
        setSessionTitle(null);
        setPlan(null);
        setContextWarningDismissed(false);
        await loadCurrentSession();
        void refreshContextUsage();
        void reloadSessions();
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      } finally {
        setSessionLoading(false);
        setSessionSwitching(false);
      }
    },
    [loadCurrentSession, refreshContextUsage, pushError, clearQueuedPrompts, reloadSessions],
  );

  /** 归档 / 恢复会话：只改 settings.json 里的路径列表，会话文件本身不动。 */
  const archiveSession = useCallback(
    (filePath: string) => {
      const current = settings?.archivedSessions ?? [];
      if (!current.includes(filePath)) void savePreferences({ archivedSessions: [...current, filePath] });
    },
    [settings?.archivedSessions, savePreferences],
  );

  const unarchiveSession = useCallback(
    (filePath: string) => {
      const current = settings?.archivedSessions ?? [];
      void savePreferences({ archivedSessions: current.filter((item) => item !== filePath) });
    },
    [settings?.archivedSessions, savePreferences],
  );

  /** 恢复检查点：从该检查点截断分支出新会话并切换过去；原会话归档隐藏（可从归档恢复）。 */
  const restoreCheckpoint = useCallback(
    async (checkpointId: string) => {
      const source = session;
      const sourceTitle = sessionTitle?.trim() || null;
      setSessionLoading(true);
      setSessionSwitching(true);
      try {
        clearQueuedPrompts();
        setRecoveredPrompts([]);
        setLastTurn(null);
        const restored = await api<{ id?: string; filePath?: string }>(
          "/session/checkpoints/restore",
          {
            method: "POST",
            body: JSON.stringify({ checkpointId }),
          },
        );
        if (restored?.id) {
          mainSessionIdRef.current = restored.id;
          if (restored.id !== source?.id && source?.filePath) archiveSession(source.filePath);
          if (restored.id !== source?.id && sourceTitle && restored.filePath) {
            await renameSessionByPath(restored.filePath, sourceTitle);
          }
        }
        setTimeline([]);
        setSessionTitle(null);
        setPlan(null);
        setContextWarningDismissed(false);
        await loadCurrentSession();
        void refreshContextUsage();
        void reloadSessions();
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      } finally {
        setSessionLoading(false);
        setSessionSwitching(false);
      }
    },
    [
      session,
      sessionTitle,
      loadCurrentSession,
      refreshContextUsage,
      pushError,
      clearQueuedPrompts,
      reloadSessions,
      archiveSession,
      renameSessionByPath,
    ],
  );

  /** 预览回滚：dryRun 拿计划，打开预览对话框；确认后才真正执行。 */
  const rewindCheckpoint = useCallback(
    async (checkpointId: string, mode: RewindMode = "both") => {
      try {
        const plan = await api<RewindPlan>("/session/rewind", {
          method: "POST",
          body: JSON.stringify({ checkpointId, mode, dryRun: true }),
        });
        setRewindDialog({ plan, busy: false });
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      }
    },
    [pushError],
  );

  /** 执行回滚：重新预览（keepNewFiles 可能变）拿新 planId，再 apply；派生会话时归档源会话，避免侧栏多出分支。 */
  const confirmRewind = useCallback(
    async (force: boolean, keepNewFiles: boolean) => {
      const current = rewindDialogRef.current;
      if (!current) return;
      const source = session;
      const sourceTitle = sessionTitle?.trim() || null;
      setRewindDialog({ plan: current.plan, busy: true });
      const { checkpointId, mode } = {
        checkpointId: current.plan.checkpoint.id,
        mode: current.plan.mode,
      };
      try {
        const plan = await api<RewindPlan>("/session/rewind", {
          method: "POST",
          body: JSON.stringify({ checkpointId, mode, dryRun: true, keepNewFiles }),
        });
        const applied = await api<{ rewindId?: string; id?: string; filePath?: string }>(
          "/session/rewind",
          {
            method: "POST",
            body: JSON.stringify({ checkpointId, mode, dryRun: false, planId: plan.planId, force, keepNewFiles }),
          },
        );
        setRewindDialog(null);
        if (applied?.id) {
          mainSessionIdRef.current = applied.id;
          if (mode !== "code" && applied.id !== source?.id) {
            if (source?.filePath) archiveSession(source.filePath);
            if (sourceTitle && applied.filePath) {
              await renameSessionByPath(applied.filePath, sourceTitle);
            }
          }
        }
        clearQueuedPrompts();
        setRecoveredPrompts([]);
        setLastTurn(null);
        setTimeline([]);
        setSessionTitle(null);
        setPlan(null);
        setContextWarningDismissed(false);
        await loadCurrentSession();
        void refreshContextUsage();
        void reloadSessions();
      } catch (err) {
        setRewindDialog((prev) => (prev ? { ...prev, busy: false } : prev));
        pushError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      session,
      sessionTitle,
      loadCurrentSession,
      refreshContextUsage,
      pushError,
      clearQueuedPrompts,
      reloadSessions,
      archiveSession,
      renameSessionByPath,
    ],
  );

  /** 撤销最近一次回滚：文件改回回滚前状态；切回源会话并恢复它在列表中的显示，隐藏派生会话。 */
  const undoRewind = useCallback(async () => {
    const current = undoableRewind;
    if (!current) return;
    const derived = session;
    setSessionLoading(true);
    setSessionSwitching(true);
    try {
      clearQueuedPrompts();
      setRecoveredPrompts([]);
      setLastTurn(null);
      const undone = await api<{ switched?: { id?: string; filePath?: string } }>(
        "/session/rewind/undo",
        {
          method: "POST",
          body: JSON.stringify({ rewindId: current.rewindId, switchBack: true }),
        },
      );
      if (undone?.switched?.id) mainSessionIdRef.current = undone.switched.id;
      const sourcePath = undone?.switched?.filePath;
      if (sourcePath) {
        const archived = settings?.archivedSessions ?? [];
        const next = new Set(archived);
        next.delete(sourcePath);
        if (derived?.filePath && derived.filePath !== sourcePath) next.add(derived.filePath);
        const nextList = [...next];
        if (
          nextList.length !== archived.length ||
          nextList.some((path) => !archived.includes(path))
        ) {
          void savePreferences({ archivedSessions: nextList });
        }
      }
      setUndoableRewind(null);
      setTimeline([]);
      setSessionTitle(null);
      setPlan(null);
      setContextWarningDismissed(false);
      await loadCurrentSession();
      void refreshContextUsage();
      void reloadSessions();
    } catch (err) {
      pushError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionLoading(false);
      setSessionSwitching(false);
    }
  }, [
    undoableRewind,
    session,
    settings?.archivedSessions,
    savePreferences,
    loadCurrentSession,
    refreshContextUsage,
    pushError,
    clearQueuedPrompts,
    reloadSessions,
  ]);

  /** 切到某个工作区（项目）：保存设置 + 在该项目里开会话。新建项目与切换项目共用。 */
  const applyWorkspace = useCallback(
    async (cwd: string) => {
      setWorktreeIntent(false);
      setSettings((prev) => (prev ? { ...prev, workspace: cwd } : prev));
      // 工作区只影响下次新建会话的默认目录，走轻量偏好通道只写盘。
      // 用 saveSettings 会让主进程重启 agent server，把运行中的回合直接杀掉。
      const saved = await savePreferences({ workspace: cwd });
      if (!saved) return;
      await createSession(cwd);
    },
    [savePreferences, createSession],
  );

  /** 项目行右侧按钮：当前项目直接新开对话，其他项目先切换工作区。 */
  const newChatInProject = useCallback(
    (cwd: string) => {
      const activeWorkspace = projectCwd;
      if (cwd === activeWorkspace) void createSession(cwd);
      else void applyWorkspace(cwd);
    },
    [projectCwd, createSession, applyWorkspace],
  );

  const pickWorkspace = useCallback(async () => {
    const cwd = await window.meow.pickWorkspace();
    if (!cwd) return;
    await applyWorkspace(cwd);
  }, [applyWorkspace]);

  /** 项目切换菜单选中某项：已是当前项目则什么都不做 */
  const switchProject = useCallback(
    (cwd: string) => {
      if (cwd === projectCwd) return;
      void applyWorkspace(cwd);
    },
    [projectCwd, applyWorkspace],
  );

  // 托盘菜单的「最近对话」：会话列表或当前会话变化就推一次（主进程只做展示与分发）。
  // 只推最近的一小段，够填满「3 条 + 更多」即可，避免整库列表过 IPC。
  useEffect(() => {
    void window.meow?.syncTraySessions?.({
      activeFilePath: session?.filePath ?? null,
      activeSessionId: session?.id ?? null,
      sessions: sessions.slice(0, TRAY_SYNC_LIMIT).map((item) => ({
        filePath: item.filePath,
        title: item.title,
        createdAt: item.createdAt,
        messageCount: item.messageCount,
      })),
    });
  }, [sessions, session?.filePath, session?.id]);

  // 托盘里点会话 / 点「新对话」：复用侧栏同一条切换与新建逻辑
  const trayActionsRef = useRef({ switchSession, createSession });
  useEffect(() => {
    trayActionsRef.current = { switchSession, createSession };
  }, [switchSession, createSession]);
  useEffect(() => {
    const unsubscribeSwitch = window.meow?.onTraySwitchSession?.((filePath) => {
      if (filePath) void trayActionsRef.current.switchSession(filePath);
    });
    const unsubscribeNew = window.meow?.onTrayNewSession?.(() => {
      void trayActionsRef.current.createSession();
    });
    // 订阅好后再握手：主进程把窗口加载期间排队的那次托盘点击补发过来
    void window.meow?.notifyTrayReady?.();
    return () => {
      unsubscribeSwitch?.();
      unsubscribeNew?.();
    };
  }, []);

  /**
   * worktree 开关：只记“这次新对话要在独立 worktree 中开始”的意图，首次发送时才创建。
   * 先查 git 状态：非仓库直接拒绝；主工作区脏只提示（worktree 基于 HEAD）。
   */
  const toggleWorktree = useCallback(
    async (next: boolean) => {
      if (!next) {
        setWorktreeIntent(false);
        return;
      }
      if (!session || session.worktree || !projectCwd) return;
      const expectedSessionId = session.id;
      setWorktreeBusy(true);
      try {
        const status = await api<GitStatus>("/git/status");
        if (mainSessionIdRef.current !== expectedSessionId) return;
        if (!status.isRepo) {
          pushError(t("error.notGitRepo"));
          return;
        }
        setWorktreeIntent(true);
        if (status.staged.length || status.unstaged.length || status.conflicted.length) {
          showToast(t("toast.worktreeDirty"));
        }
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      } finally {
        setWorktreeBusy(false);
      }
    },
    [session, projectCwd, pushError, showToast, t],
  );

  /**
   * 保存模型列表（增删改 / 启用开关）。
   * 走 saveSettings —— 会重启 agent server，因为模型列表要进 MEOWCODE_PROVIDERS 环境变量。
   * 模型增删是低频的显式动作，重启可以接受。
   */
  const saveProviders = useCallback(
    async (nextProviders: ProviderSettings[], nextActiveId?: string): Promise<boolean> => {
      if (!settings) return false;
      const usable = (id: string | undefined) =>
        nextProviders.some((item) => item.id === id && item.enabled !== false);
      const requested = nextActiveId ?? settings.providerId;
      const nextSettings: Settings = {
        ...settings,
        providers: nextProviders.map((provider) => ({ ...provider, apiKey: provider.apiKey || undefined })),
        // 被停用/删除的激活模型要让位给第一个仍启用的模型，否则 UI 隐藏它、引擎还在用它
        providerId: usable(requested)
          ? requested
          : (nextProviders.find((item) => item.enabled !== false)?.id ?? nextProviders[0]?.id),
      };
      try {
        const saved = await window.meow.saveSettings(nextSettings);
        setSettings(saved);
        return true;
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [settings, pushError],
  );

  /** 引导完成：先落盘完成标记；没有工作区时落到设置 → 通用，避免停在不可用的输入框 */
  const finishOnboarding = useCallback(async () => {
    const ok = await savePreferences({ onboardingCompleted: true });
    if (!ok) return;
    setOnboardingOpen(false);
    if (!settings?.workspace) {
      setSettingsSection("general");
      setView("settings");
    } else {
      setView("chat");
    }
  }, [savePreferences, settings?.workspace]);

  /** 会话导出：主进程弹保存框 → 拉 server 内容 → 写盘，成功提示完整路径 */
  const exportSessionByPath = useCallback(
    async (filePath: string, title: string | null) => {
      try {
        const result = await window.meow.exportSession({
          filePath,
          ...(title ? { title } : {}),
          format: "markdown",
          includeThinking: true,
          includeTools: true,
          inlineImages: true,
        });
        if (result.canceled) return;
        if (!result.ok || !result.filePath) {
          pushError(result.error ?? "Export failed");
          return;
        }
        showToast(t("chat:conversation.exported", { path: result.filePath }));
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      }
    },
    [pushError, showToast, t],
  );

  /** 用服务端真实运行/审批/队列状态对账；停止后清除“幽灵运行”。 */
  const syncRunState = useCallback(async () => {
    const globalVersion = runStateVersionRef.current;
    const sessionVersions = { ...sessionRunVersionsRef.current };
    const queueVersion = queueVersionRef.current;
    try {
      const current = await api<{
        runningSessionIds?: string[];
        pendingApprovals?: PendingApproval[];
        pendingAsk?: { callId: string; questions: Array<{ question: string; options: string[] }> } | null;
        queuedPrompts?: QueuedPrompt[];
        compactingSessionIds?: string[];
      }>("/session");
      const targetId = mainSessionIdRef.current ?? "";
      const targetStable =
        (sessionVersions[targetId] ?? 0) === (sessionRunVersionsRef.current[targetId] ?? 0);
      const globalStable = globalVersion === runStateVersionRef.current;
      if (targetStable) {
        if (queueVersion === queueVersionRef.current) {
          replaceQueuedPrompts(current.queuedPrompts ?? []);
        }
        sessionRunVersionsRef.current[targetId] =
          (sessionRunVersionsRef.current[targetId] ?? 0) + 1;
      }
      if (globalStable) {
        setRunningSessions(current.runningSessionIds ?? []);
        replaceApprovals(current.pendingApprovals ?? []);
        if ("pendingAsk" in current) setPendingAsk(current.pendingAsk ?? null);
        setCompactingSessions(current.compactingSessionIds ?? []);
        runStateVersionRef.current += 1;
      }
    } catch {
      // 保留乐观清理结果
    }
  }, [
    setRunningSessions,
    replaceApprovals,
    replaceQueuedPrompts,
    setCompactingSessions,
  ]);

  const abortSession = useCallback(async () => {
    clearQueuedPrompts();
    // 立刻解除当前会话的等待；其他后台会话的运行圆点不动
    if (session) {
      removeRunningSession(session.id);
      removeOwnApprovals(session.id);
    }
    runStateVersionRef.current += 1;
    try {
      await api("/session/abort", { method: "POST" });
    } catch (err) {
      pushError(err instanceof Error ? err.message : String(err));
    } finally {
      void syncRunState();
    }
  }, [
    clearQueuedPrompts,
    pushError,
    session?.id,
    removeRunningSession,
    removeOwnApprovals,
    syncRunState,
  ]);

  /** 侧栏停止任意运行中的会话：后台会话带 sessionId，不必先切过去。 */
  const stopSessionById = useCallback(
    async (sessionId: string) => {
      if (session?.id === sessionId) {
        await abortSession();
        return;
      }
      removeRunningSession(sessionId);
      removeOwnApprovals(sessionId);
      runStateVersionRef.current += 1;
      try {
        await api("/session/abort", {
          method: "POST",
          body: JSON.stringify({ sessionId }),
        });
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      } finally {
        void syncRunState();
      }
    },
    [
      abortSession,
      pushError,
      removeOwnApprovals,
      removeRunningSession,
      session?.id,
      syncRunState,
    ],
  );

  /** 手动压缩上下文（占用弹层里的按钮）。错误进消息流，横幅与占用刷新由事件驱动。 */
  const manualCompact = useCallback(async () => {
    try {
      await api("/session/compact", { method: "POST" });
    } catch (err) {
      pushError(err instanceof Error ? err.message : String(err));
      // 压缩没跑起来/中途失败时，用服务端状态清掉可能残留的压缩标记
      void syncRunState();
    }
  }, [pushError, syncRunState]);

  /** 切换工具审批模式（完全访问）。后端是会话级状态，前端同步本地 state。 */
  const changePermissionMode = useCallback(async (mode: PermissionMode) => {
    setPermissionMode(mode);
    try {
      await api("/session/permissions", {
        method: "PUT",
        body: JSON.stringify({ mode }),
      });
    } catch (err) {
      pushError(err instanceof Error ? err.message : String(err));
    }
  }, [pushError]);

  /** 切换会话模式（计划 / 目标）：后端持有会话级状态，这里只做乐观更新。 */
  const changeChatMode = useCallback(async (mode: SessionMode) => {
    chatModeRef.current = mode;
    setChatMode(mode);
    if (mode !== "plan") setPlanDocPath(null);
    try {
      await api("/session/mode", { method: "PUT", body: JSON.stringify({ mode }) });
    } catch (err) {
      pushError(err instanceof Error ? err.message : String(err));
    }
  }, [pushError]);

  /** 架构页工作区：架构图读写目标 */
  const architectureWorkspace = session?.cwd ?? settings?.workspace;
  /**
   * 切换正在查看的架构图：立刻清空角色列表，等新图加载完由 onAgentsChange 填充。
   * 不清空的话，列表会先显示旧图的角色、数量也跟着跳一下（肉眼就是闪烁）。
   */
  const switchArchitecture = useCallback((id: string) => {
    setArchitectureProfile(id);
    setArchitectureAgents([]);
  }, []);

  // 档位切换（聊天框）后，架构页菜单跟着对齐到当前档位
  useEffect(() => {
    switchArchitecture(agentProfile);
  }, [agentProfile, switchArchitecture]);

  /** 重新拉取左栏「主 Agent」列表（内置三档 + 自定义架构） */
  const reloadHarnessArchitectures = useCallback(async () => {
    try {
      setHarnessArchitectures(await fetchHarnessArchitectures(architectureWorkspace));
    } catch {
      // 列表拉取失败不影响画布本身
    }
  }, [architectureWorkspace]);
  // 拉取/切架构时以服务端为准刷新列表：画布上未保存的改名不应残留在左栏
  useEffect(() => {
    void reloadHarnessArchitectures();
  }, [architectureProfile, reloadHarnessArchitectures]);

  /** 新建自定义 Agent 架构：复制标准 Agent 的整张图，命名「自定义 Agent」并切过去 */
  const addHarnessArchitecture = useCallback(async () => {
    try {
      const created = await createHarnessArchitecture(architectureWorkspace, {
        cloneFrom: "standard",
        name: t("architecture.customName"),
      });
      await reloadHarnessArchitectures();
      switchArchitecture(created.id);
    } catch (err) {
      pushError(err instanceof Error ? err.message : String(err));
    }
  }, [architectureWorkspace, reloadHarnessArchitectures, switchArchitecture, pushError, t]);

  /** 自定义架构改名（双击左栏名称触发） */
  const renameHarnessArchitectureById = useCallback(
    async (id: string, name: string) => {
      try {
        await renameHarnessArchitecture(architectureWorkspace, id, name);
        await reloadHarnessArchitectures();
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      }
    },
    [architectureWorkspace, reloadHarnessArchitectures, pushError],
  );

  /** 删除自定义架构；删的是当前正在看的图就退回会话档位 */
  const removeHarnessArchitecture = useCallback(
    async (id: string) => {
      try {
        await deleteHarnessArchitecture(architectureWorkspace, id);
        await reloadHarnessArchitectures();
        if (architectureProfile === id) switchArchitecture(agentProfile);
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      }
    },
    [architectureWorkspace, reloadHarnessArchitectures, agentProfile, architectureProfile, switchArchitecture, pushError],
  );

  /** 切换主 Agent 档位（标准 / 极简 / 复杂）：后端是会话级状态，这里只做乐观更新。 */
  const changeAgentProfile = useCallback(async (profile: AgentProfileId) => {
    setAgentProfile(profile);
    // 切档位 = 回到该档位的图，聊天框的架构胶囊跟着变
    setSessionArchitecture(profile);
    try {
      await api("/session/agent-profile", {
        method: "PUT",
        body: JSON.stringify({ profile }),
      });
    } catch (err) {
      pushError(err instanceof Error ? err.message : String(err));
    }
  }, [pushError]);

  /** 聊天框选中自定义架构：只换运行时的图，档位（提示词/工具）不变。 */
  const selectHarnessArchitecture = useCallback(async (id: string) => {
    setSessionArchitecture(id);
    // 架构页跟着切过去，方便直接查看/编辑这张图
    switchArchitecture(id);
    try {
      await api("/session/architecture", {
        method: "PUT",
        body: JSON.stringify({ id }),
      });
    } catch (err) {
      pushError(err instanceof Error ? err.message : String(err));
    }
  }, [switchArchitecture, pushError]);

  /** 调整意见发出后收起确认卡片（仍在计划模式，等新计划写完再弹） */
  const dismissPlan = useCallback(() => setPlanDocPath(null), []);

  /** 计划确认：先退出计划模式再发确认消息，保证后续工具不再被 plan 门控拦截。 */
  const confirmPlan = useCallback(async () => {
    const docPath = planDocPath;
    await changeChatMode("default");
    await sendPrompt(
      docPath
        ? t("plan.confirmedWithPath", { path: docPath })
        : t("plan.confirmed"),
    );
  }, [changeChatMode, planDocPath, sendPrompt, t]);

  /** 切换当前模型（Composer 的模型列表里点某个）。 */
  const changeActiveProvider = useCallback(
    async (providerId: string) => {
      if (!settings || !providers.some((item) => item.id === providerId)) return;
      const nextSettings: Settings = { ...settings, providerId };
      setSettings(nextSettings);
      // 换模型只是换请求目标，不清会话统计（把缓存写入/输出抹掉是 bug）；
      // 只重置本轮测速起点，避免把旧模型的速度算到新模型头上。
      roundFirstTokenAtRef.current = null;
      setTurnMetrics((prev) => (prev ? { ...prev, tokensPerSecond: null } : prev));
      try {
        // 只持久化激活项并热切换，绝不重启 agent server：
        // 重启会丢运行中的会话状态、还可能竞态新建空会话，导致「换模型后丢上下文」。
        await window.meow.saveProviderPrefs({ providerId });
        await api("/session/model", {
          method: "PUT",
          body: JSON.stringify({ provider: providerId }),
        });
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      }
    },
    [settings, providers, pushError],
  );

  /** 调节某个模型的思考强度（Composer 里调的是当前模型）。 */
  const changeEffortFor = useCallback(
    async (providerId: string, value: string) => {
      const target = providers.find((item) => item.id === providerId);
      if (!target) return;
      try {
        // 作用到运行中的 runtime（空值 = 不下发 reasoning_effort）
        await api("/session/model", {
          method: "PUT",
          body: JSON.stringify({
            provider: target.id,
            modelId: target.model,
            reasoningEffort: value || null,
          }),
        });
        // 落盘以便下次启动记住；走 saveProviderPrefs 而不是 saveSettings，避免重启 agent server
        await window.meow.saveProviderPrefs({ providers: [{ id: target.id, reasoningEffort: value }] });
        setSettings((prev) =>
          prev
            ? {
                ...prev,
                providers: prev.providers?.map((item) =>
                  item.id === providerId ? { ...item, reasoningEffort: value } : item,
                ),
              }
            : prev,
        );
      } catch (err) {
        pushError(err instanceof Error ? err.message : String(err));
      }
    },
    [providers, pushError],
  );

  const canUse = useMemo(
    () => Boolean(session && providers.length && workspaceAvailable !== false),
    [session, providers, workspaceAvailable],
  );
  /** 项目切换菜单的数据源：已知项目（worktree 会话归回原项目）；当前项排最前，其余按显示名排序 */
  const projects = useMemo(() => {
    const set = new Set<string>();
    if (settings?.workspace) set.add(settings.workspace);
    if (projectCwd) set.add(projectCwd);
    for (const item of sessions) {
      const cwd = item.worktree?.sourceCwd ?? item.cwd;
      if (cwd) set.add(cwd);
    }
    const active = projectCwd ?? "";
    const removed = settings?.removedProjects ?? [];
    // 侧栏里「移除过」的项目也一并从切换菜单隐藏（当前项目除外，不然正在用的会凭空消失）
    const visible = [...set].filter((cwd) => cwd === active || !removed.includes(cwd));
    const nameOf = (cwd: string) => settings?.projectNames?.[cwd]?.trim() || baseName(cwd);
    return visible.sort((a, b) => {
      if (a === active) return -1;
      if (b === active) return 1;
      return nameOf(a).localeCompare(nameOf(b), "zh");
    });
  }, [sessions, projectCwd, settings?.workspace, settings?.projectNames, settings?.removedProjects]);
  const toolCount = useMemo(() => timeline.filter((item) => item.kind === "tool").length, [timeline]);
  /** 当前会话发过对话才显示上下文占用圆圈（乐观：点发送立即出现） */
  const hasSentMessage = useMemo(
    () => timeline.some((item) => item.kind === "message" && item.role === "user"),
    [timeline],
  );
  /** 等待模型响应：流已开始，但最后一条还不是助手消息（发送后首字未到 / 工具执行间隙） */
  const waiting = useMemo(() => {
    if (!streaming) return false;
    const last = timeline.at(-1);
    return !(last?.kind === "message" && last.role === "assistant");
  }, [streaming, timeline]);
  /** 工具参数生成期间：内容流已停下、还没有任何 tool_started，必须给可见反馈 */
  const toolPreparing = useMemo(
    () =>
      streaming && toolProgress
        ? toolPreparingLabel(t, toolProgress.count, toolProgress.names)
        : null,
    [streaming, toolProgress, t],
  );
  /** 时间线里最近一次写/改的目标文件：参数还没流完时先用它填文件名（模型常在原文件上迭代） */
  const lastTouchedFile = useMemo(() => {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item.kind !== "tool") continue;
      if (item.tool !== "write_file" && item.tool !== "edit_file" && item.tool !== "multi_edit") {
        continue;
      }
      const args = (item.input ?? {}) as Record<string, unknown>;
      if (typeof args.path === "string" && args.path) return args.path;
      const edits = Array.isArray(args.edits) ? args.edits : [];
      for (const edit of edits) {
        const value = (edit as Record<string, unknown> | null)?.path;
        if (typeof value === "string" && value) return value;
      }
    }
    return null;
  }, [timeline]);

  /** 正在准备写/改文件：聊天区先占一条工具行，避免出现大片空白 */
  const preparingTool = useMemo(() => {
    if (!streaming || !toolProgress) return null;
    const info = preparingWriteTool(toolProgress.count, toolProgress.names, toolProgress.path);
    if (!info) return null;
    // 路径是 JSON 的最后一个键（模型按字母序输出参数），流式阶段读不到：
    // 改文件时先用计划页签 / 最近一次写改的文件名占位，拿到真实 path 后自动替换。
    const fallbackPath =
      !info.path && info.tool === "edit_file"
        ? chatMode === "plan"
          ? (planTabPath ?? lastTouchedFile)
          : lastTouchedFile
        : null;
    return { ...info, ...(fallbackPath ? { fallbackPath } : {}) };
  }, [streaming, toolProgress, chatMode, planTabPath, lastTouchedFile]);

  if (!ready || !splashDone) {
    return (
      <ThemeProvider preference={themePreference} onPreferenceChange={setThemePreference}>
        {/* 无边框窗口：启动阶段也必须保留标题栏，否则窗口无法拖动 */}
        <div className="mc-root mc-root--splash">
          <TitleBar forceDark />
          <BootSplash />
        </div>
      </ThemeProvider>
    );
  }

  if (onboardingOpen) {
    return (
      <ThemeProvider preference={themePreference} onPreferenceChange={setThemePreference}>
        <div className="mc-root">
          <TitleBar />
          <Onboarding
            initialLanguage={settings?.language ?? getStoredPreference()}
            initialTheme={themePreference}
            providers={providers}
            replay={Boolean(settings?.onboardingCompleted)}
            onSaveLanguage={(value) => void savePreferences({ language: value })}
            onSaveTheme={(value) => void savePreferences({ theme: value })}
            onSaveProviders={(entries) => {
              // 引导里返回再连接会用同一批 id：先按 id 去重，避免同一条模型落两次
              const ids = new Set(entries.map((entry) => entry.id));
              return saveProviders(
                [...providers.filter((item) => !ids.has(item.id)), ...entries],
                entries[0]?.id,
              );
            }}
            onFinish={finishOnboarding}
            onClose={() => setOnboardingOpen(false)}
          />
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider preference={themePreference} onPreferenceChange={setThemePreference}>
      {/* 接管全应用 title 提示，统一换成自绘气泡（不弹原生 tooltip） */}
      <GlobalTooltip />
      <AppShell
        listWidth={listWidth}
        listResizer={
          <div
            className="mc-listresize"
            role="separator"
            aria-label={t("resize.list")}
            data-dragging={listDragging}
            onPointerDown={startListResize}
            onPointerEnter={trackResizeCursor}
            onPointerMove={moveListResize}
            onPointerUp={endListResize}
          />
        }
        rail={
          <Rail
            active={
              view === "settings"
                ? "settings"
                : view === "plugins"
                  ? "plugins"
                  : view === "architecture"
                    ? "architecture"
                    : view === "git"
                      ? "git"
                      : "home"
            }
            onHome={() => setView("chat")}
            onOpenGit={() => setView("git")}
            onOpenPlugins={() => setView("plugins")}
            onOpenSettings={() => setView("settings")}
            onOpenArchitecture={() => setView("architecture")}
            update={
              silentUpdate.status === "hidden"
                ? null
                : {
                    status: silentUpdate.status,
                    percent: silentUpdate.status === "downloading" ? silentUpdate.percent : 0,
                  }
            }
            onUpdateClick={
              silentUpdate.status === "done"
                ? () => void restartUpdate()
                : silentUpdate.status === "error"
                  ? () => setUpdateOpen(true)
                  : undefined
            }
          />
        }
        conversations={
          /* 设置/市场/Git 管理视图：对应导航栏取代对话列表的槽位 */
          view === "git" ? (
            <GitNav git={git} onOpenBranches={() => setGitBranchOpen(true)} />
          ) : view === "settings" ? (
            <SettingsNav section={settingsSection} onSection={setSettingsSection} />
          ) : view === "plugins" ? (
            <MarketplaceNav tab={marketTab} onTab={setMarketTab} onClose={() => setView("chat")} />
          ) : view === "architecture" ? (
            <ArchitectureNav
              agents={architectureAgents}
              architectures={harnessArchitectures}
              selectedId={architectureAgentId}
              onSelect={setArchitectureAgentId}
              activeProfile={agentProfile}
              profile={architectureProfile}
              onSelectProfile={switchArchitecture}
              onAddArchitecture={() => void addHarnessArchitecture()}
              onRenameArchitecture={(id, name) => void renameHarnessArchitectureById(id, name)}
              onDeleteArchitecture={(id) => void removeHarnessArchitecture(id)}
              workspace={session?.cwd ?? settings?.workspace}
            />
          ) : (
            <ConversationPanel
              sessions={sessions}
              currentSessionId={session?.id}
              runningSessionIds={runningSessionIds}
              approvalSessionIds={[
                ...new Set(Object.values(approvals).map((item) => item.sessionId)),
              ]}
              workspace={projectCwd}
              archivedSessions={settings?.archivedSessions ?? []}
              projectNames={settings?.projectNames ?? {}}
              pinnedProjects={settings?.pinnedProjects ?? []}
              removedProjects={settings?.removedProjects ?? []}
              onNewChat={() => void createSession()}
              onNewChatInProject={newChatInProject}
              onSwitchSession={(filePath) => void switchSession(filePath)}
              onRenameSession={(filePath, title) => void renameSessionByPath(filePath, title)}
              onDeleteSession={(filePath) => void deleteSessionByPath(filePath)}
              onBranchSession={(filePath) => void branchSessionByPath(filePath)}
              onStopSession={(sessionId) => void stopSessionById(sessionId)}
              onArchiveSession={archiveSession}
              onExportSession={(filePath, title) => void exportSessionByPath(filePath, title)}
              onArchiveProject={archiveProject}
              onRenameProject={renameProject}
              onTogglePinProject={togglePinProject}
              onRemoveProject={removeProject}
              onOpenProject={(cwd) => void openProject(cwd)}
            />
          )
        }
        inspector={
          /* 右侧面板：宽度可拖拽（280–720）；容器常驻挂载做展开/收起滑动动画，设置视图下整个不渲染 */
          view === "chat" ? (
            <>
              {showInspector ? (
                <div
                  className="mc-inspresize"
                  role="separator"
                  aria-label={t("resize.inspector")}
                  onPointerDown={startResize}
                  onPointerEnter={trackResizeCursor}
                  onPointerMove={moveResize}
                  onPointerUp={endResize}
                />
              ) : null}
              <div
                className="mc-inspwrap"
                data-collapsed={!showInspector}
                data-animated={inspectorAnimated}
                style={{ "--inspector-w": `${inspectorWidth}px` } as CSSProperties}
              >
                <RightPanel
                  tabs={visibleSideTabs}
                  activeId={visibleActiveTabId}
                  onActivate={sideTabs.activate}
                  onClose={sideTabs.close}
                  onOpen={openSideTab}
                  onOpenPalette={() => {
                    setShowInspector(true);
                    sideTabs.setPaletteOpen(true);
                  }}
                  onOpenSearch={() => setSearchOpen(true)}
                  onOpenWorkspace={(cwd) => void openProject(cwd)}
                  onOpenFile={sideTabs.openFile}
                  onPatchTab={sideTabs.patchTab}
                  subagentRuns={subagentRuns}
                  onEnsureSubagent={ensureSubagentTranscript}
                  onOpenSubagent={openSubagentById}
                  onStopSubagent={(agentId) => void stopSubagent(agentId)}
                  onContinueSubagent={continueSubagent}
                  onSteerSubagent={steerSubagent}
                  workspace={session?.cwd ?? settings?.workspace}
                  session={session}
                  metrics={turnMetrics}
                  provider={activeProvider}
                  providers={providers}
                  onManageModels={() => {
                    setSettingsSection("models");
                    setView("settings");
                  }}
                  toolCount={toolCount}
                  planPath={planTabPath}
                  planWriting={Boolean(planWriting)}
                  planDocVersion={planDocVersion}
                  roadmap={session ? workflowRoadmaps[session.id] ?? null : null}
                />
              </div>
            </>
          ) : undefined
        }
      >
        {/* 对话保持挂载，切到设置页时只是隐藏，返回后滚动位置不丢 */}
        <div className="mc-contentview" data-hidden={view !== "chat"}>
          <ChatHeader
            title={sessionTitle}
            workspace={headerWorkspace}
            workspaceTitle={headerWorkspaceTitle}
            inspectorOpen={showInspector}
            onToggleInspector={toggleInspector}
            onOpenSearch={() => setSearchOpen(true)}
            overview={
              <WorkspaceOverview
                status={workspaceGitStatus}
                subagents={currentSessionSubagents}
                open={workspaceOverviewOpen}
                onToggle={toggleWorkspaceOverview}
                onClose={closeWorkspaceOverview}
                onOpenGit={() => {
                  setView("git");
                  closeWorkspaceOverview();
                }}
                onOpenSubagent={openSubagentById}
              />
            }
          />
          <ContextWarningBanner
            usage={contextUsage}
            streaming={streaming}
            compacting={compacting}
            dismissed={contextWarningDismissed}
            onCompact={manualCompact}
            onDismiss={() => setContextWarningDismissed(true)}
          />
          {/* 撤销回滚横幅：当前会话最近一次回滚仍可撤销（文件改回 + 切回源会话） */}
          {undoableRewind ? (
            <div className="mc-undobar" role="status">
              <span className="mc-undobar__text">
                {i18n.t("shell:notice.undoableRewind", { count: undoableRewind.fileCount })}
              </span>
              <button
                type="button"
                className="mc-undobar__button"
                onClick={() => void undoRewind()}
              >
                {i18n.t("shell:notice.undoRewind")}
              </button>
              <button
                type="button"
                className="mc-undobar__close"
                aria-label={i18n.t("shell:notice.dismiss")}
                onClick={() => setUndoableRewind(null)}
              >
                ×
              </button>
            </div>
          ) : null}
          <MessageList
            items={timeline}
            canUse={canUse}
            waiting={waiting}
            preparing={toolPreparing}
            preparingTool={preparingTool}
            loading={sessionLoading}
            subagentsByCallId={subagentsByCallId}
            onOpenSubagent={openSubagentById}
            onOpenFile={(path) => {
              sideTabs.openFile(path);
              setShowInspector(true);
            }}
            onRestoreCheckpoint={(checkpointId) => void restoreCheckpoint(checkpointId)}
            onRewindCheckpoint={(checkpointId, mode) => void rewindCheckpoint(checkpointId, mode)}
            focus={messageFocus}
          />
          <Composer
            value={input}
            onChange={setInput}
            chips={chips}
            onRemoveChip={removeChip}
            onAttachSkill={(chip) => addChip({ kind: "skill", ...chip })}
            onAttachPlugin={(chip) => addChip({ kind: "plugin", ...chip })}
            onAttachCommand={(chip) => addChip({ kind: "command", ...chip })}
            onAttachFile={({ name, path }) =>
              addChip({ kind: "file", id: path, name, path })
            }
            askCard={pendingAsk}
            onAnswerAsk={answerAsk}
            onSend={(images, overrideText) => void sendPrompt(overrideText, undefined, images)}
            onError={pushError}
            onStop={abortSession}
            // 切换/新建会话加载期间禁止发送，避免请求落到上一个会话的 runtime
            disabled={!canUse || sessionSwitching || worktreeBusy}
            streaming={streaming}
            queuedPrompts={queuedPrompts}
            onSteerQueued={(id) => void steerQueuedPrompt(id)}
            onRemoveQueued={(id) => void removeQueuedPrompt(id)}
            recoveredPrompts={recoveredPrompts}
            onSendRecovered={sendRecoveredPrompt}
            onDiscardRecovered={(id) => void discardRecoveredPrompt(id)}
            canUse={canUse}
            workspace={session?.cwd ?? settings?.workspace}
            projectCwd={projectCwd}
            gitBranch={gitBranch}
            onOpenGit={() => setView("git")}
            worktreeEnabled={worktreeIntent || Boolean(session?.worktree)}
            worktreeLocked={Boolean(session?.worktree)}
            worktreeBusy={worktreeBusy}
            onToggleWorktree={(next) => void toggleWorktree(next)}
            workspaceAvailable={workspaceAvailable}
            providers={providers}
            activeProviderId={activeProviderId}
            onChangeActiveProvider={(id) => void changeActiveProvider(id)}
            onManageModels={() => {
              setSettingsSection("models");
              setView("settings");
            }}
            model={activeProvider?.displayName || activeProvider?.model || t("model.unconfigured")}
            effort={activeProvider?.reasoningEffort ?? ""}
            onChangeEffort={(value) => void changeEffortFor(activeProviderId, value)}
            permissionMode={permissionMode}
            onChangePermissionMode={(mode) => void changePermissionMode(mode)}
            agentProfile={agentProfile}
            onChangeAgentProfile={(profile) => void changeAgentProfile(profile)}
            architectures={harnessArchitectures}
            activeArchitecture={sessionArchitecture}
            onSelectArchitecture={(id) => void selectHarnessArchitecture(id)}
            chatMode={chatMode}
            onChangeChatMode={(mode) => void changeChatMode(mode)}
            planDocPath={planDocPath}
            onConfirmPlan={() => void confirmPlan()}
            onDismissPlan={dismissPlan}
            contextUsage={contextUsage}
            showContext={hasSentMessage}
            compacting={compacting}
            cacheDiagnostics={cacheDiagnostics}
            onManualCompact={manualCompact}
            projects={projects}
            projectNames={settings?.projectNames ?? {}}
            onSwitchProject={switchProject}
            onNewProject={() => void pickWorkspace()}
            onRemoveProject={removeProject}
            plan={plan}
            changes={uncommittedSessionChanges}
          />
        </div>

        {view === "git" ? (
          <>
            <GitBody git={git} onOpenBranches={() => setGitBranchOpen(true)} />
            <BranchDialog
              open={gitBranchOpen}
              git={git}
              onClose={() => setGitBranchOpen(false)}
            />
          </>
        ) : null}

        {toast ? <Toast key={toast.key} text={toast.text} /> : null}

        <UpdateModal
          open={updateOpen}
          release={updateRelease}
          currentVersion={appInfo ? `v${appInfo.version}` : undefined}
          silent={
            silentUpdate.status === "downloading"
              ? { downloading: true, path: null }
              : silentUpdate.status === "done"
                ? { downloading: false, path: silentUpdate.path }
                : null
          }
          onClose={() => setUpdateOpen(false)}
        />

        {view === "settings" ? (
          <SettingsBody
            section={settingsSection}
            settings={settings}
            preferences={preferences}
            appInfo={appInfo}
            providers={providers}
            activeProviderId={activeProviderId}
            effort={activeProvider?.reasoningEffort ?? ""}
            turnRunning={runningSessionIds.length > 0}
            sessions={sessions}
            archivedSessions={settings?.archivedSessions ?? []}
            workspace={session?.cwd ?? settings?.workspace ?? null}
            onUnarchiveSession={unarchiveSession}
            onDeleteArchivedSession={(filePath) => void deleteArchivedSessions([filePath])}
            onDeleteAllArchived={() =>
              void deleteArchivedSessions(settings?.archivedSessions ?? [])
            }
            onSavePreferences={(prefs) => void savePreferences(prefs)}
            onSaveProviders={(next, activeId) => void saveProviders(next, activeId)}
            onChangeEffort={(id, value) => void changeEffortFor(id, value)}
            updateRelease={updateRelease}
            onUpdateDiscovered={discoverUpdate}
            onOpenUpdate={() => setUpdateOpen(true)}
            fontFamily={preferences.fontFamily ?? ""}
            codeFontFamily={preferences.codeFontFamily ?? ""}
            customFonts={customFonts.map((font) => font.family)}
            onFontChange={(value) => void savePreferences({ fontFamily: value })}
            onCodeFontChange={(value) => void savePreferences({ codeFontFamily: value })}
            onImportFont={importFont}
            onRemoveFont={removeCustomFont}
            onToast={showToast}
            onReloadSessions={() => void reloadSessions()}
          />
        ) : null}

        {view === "architecture" ? (
          <ArchitectureBody
            selectedAgentId={architectureAgentId}
            onAgentSelect={setArchitectureAgentId}
            onAgentsChange={setArchitectureAgents}
            workspace={session?.cwd ?? settings?.workspace}
            profile={architectureProfile}
            architectureName={
              harnessArchitectures.find((item) => item.id === architectureProfile)?.name ?? undefined
            }
            onArchitectureRename={(name) =>
              setHarnessArchitectures((list) =>
                list.map((item) =>
                  item.id === architectureProfile ? { ...item, name } : item,
                ),
              )
            }
          />
        ) : null}

        {view === "plugins" ? (
          <MarketplaceBody
            tab={marketTab}
            onUseSkill={(entry, iconUrl) => {
              // 输入框内追加技能引用 chip（可同时引用多个），跳回对话补任务
              addChip({ kind: "skill", id: entry.id, name: entry.name, iconUrl });
              setView("chat");
            }}
            onOpenPluginPanel={(pluginId, title) => {
              sideTabs.open({ kind: "plugin", pluginId, title });
              setView("chat");
            }}
          />
        ) : null}
      </AppShell>

      <ApprovalDialog
        open={Boolean(approval) && !sessionSwitching}
        tool={approval?.tool}
        input={approval?.input}
        diff={approval?.diff}
        risk={approval?.risk}
        stale={approval?.stale}
        agentDescription={approval?.agentDescription}
        kind={approval?.kind}
        command={approval?.command}
        hookEvent={approval?.hookEvent}
        matcher={approval?.matcher}
        source={approval?.source}
        hookReason={approval?.hookReason}
        sandboxEscape={approval?.sandboxEscape}
        onApprove={() => void respondApproval(true)}
        onDeny={() => void respondApproval(false)}
      />

      <CloseConfirmDialog open={closeAsk} onDecide={decideClose} />
      {rewindDialog ? (
        <RewindDialog
          plan={rewindDialog.plan}
          busy={rewindDialog.busy}
          onConfirm={({ force, keepNewFiles }) => void confirmRewind(force, keepNewFiles)}
          onCancel={() => setRewindDialog(null)}
        />
      ) : null}

      {/* 文件快速打开（Ctrl+P）：选中后在「文件」页签里预览 */}
      <QuickOpenDialog
        open={sideTabs.paletteOpen}
        onClose={() => sideTabs.setPaletteOpen(false)}
        onPick={(path) => {
          sideTabs.openFile(path);
          setShowInspector(true);
        }}
      />

      {/* 会话全文检索（Ctrl+K / 聊天头搜索按钮）：Enter 跳到命中会话并定位到那句话 */}
      <SessionSearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpen={(hit, snippet) => void openSearchHit(hit, snippet)}
      />
    </ThemeProvider>
  );
}

export { DEFAULT_PROVIDER };
