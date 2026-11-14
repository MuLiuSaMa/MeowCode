import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { LuArrowUp, LuCircleAlert, LuFileText, LuPaperclip, LuSquare, LuX } from "react-icons/lu";
import { applyLanguage } from "../i18n";
import { api, type ChatMessage, type MeowEvent, type TimelineItem } from "../api";
import { timelineFromHistory } from "../timeline";
import { AssistantMessage, ThinkingRow } from "../components/AssistantMessage";
import { ToolGroup } from "../components/ToolGroup";
import { ToolRow, presentTool } from "../components/ToolRow";
import { UserBubble } from "../components/UserBubble";
import appIcon from "../assets/icon.png";

/**
 * AI 悬浮岛：屏幕顶部居中的透明胶囊，聚合显示所有运行中会话的状态。
 * 悬停展开成迷你聊天窗（看流式输出 / 直接输入 / 停止），空闲时整窗鼠标穿透。
 * 状态真源是 agent server 的 SSE 事件流（window.meow.onEvent），按 sessionId 聚合。
 */

/** 尾流条目上限：只保留最近的，弹窗是「看当前动态」不是全量历史 */
const MAX_FEED = 60;
/** 单条文本上限：超长保留尾部（流式输出看的是最新内容） */
const MAX_TEXT = 4000;

type FeedItem =
  | { key: string; kind: "user"; text: string }
  | { key: string; kind: "assistant"; text: string; thinking?: string; streaming: boolean }
  | {
      key: string;
      kind: "tool";
      callId: string;
      tool: string;
      /** 工具入参（tool_started 带来 / 历史回放从 tool_calls 重建）：ToolRow 展开要显示 */
      input: unknown;
      /** 工具输出（tool_finished 带来 / 历史回放从 role:"tool" 消息对上） */
      output?: string;
      run: boolean;
      ok: boolean;
    }
  | { key: string; kind: "error"; text: string };

type SessionView = {
  id: string;
  title: string | null;
  running: boolean;
  /** 待审批的工具调用 id 列表（琥珀点；"*" 代表无 callId 的泛审批） */
  approvals: string[];
  /** 排队中的 prompt 数（仅当前会话有真值） */
  queued: number;
  /** 已开始回合但还没等到首个输出（思考中） */
  thinking: boolean;
  feed: FeedItem[];
  activityAt: number;
};

type State = {
  activeId: string | null;
  selectedId: string | null;
  connected: boolean;
  sessions: Record<string, SessionView>;
};

type Action =
  | {
      type: "snapshot";
      activeId: string | null;
      runningIds: string[];
      /** sessionId → 待审批 callId 列表 */
      approvals: Record<string, string[]>;
      queuedActive: number;
      titles: Record<string, string | null>;
    }
  | { type: "history"; sessionId: string; messages: ChatMessage[] }
  | { type: "event"; event: MeowEvent }
  | { type: "select"; sessionId: string }
  | { type: "sent"; sessionId: string; text: string }
  | { type: "sendFailed"; sessionId: string; text: string }
  | { type: "rewound"; sessionId: string };

const emptySession = (id: string): SessionView => ({
  id,
  title: null,
  running: false,
  approvals: [],
  queued: 0,
  thinking: false,
  feed: [],
  activityAt: 0,
});

const clip = (text: string) => (text.length > MAX_TEXT ? `…${text.slice(-MAX_TEXT)}` : text);

function upsert(state: State, id: string, patch: (s: SessionView) => SessionView): State {
  const existing = state.sessions[id] ?? emptySession(id);
  return { ...state, sessions: { ...state.sessions, [id]: patch(existing) } };
}

/** 尾流末尾的流式助手条目（追加 delta / 定稿都用它） */
function isStreamingAssistantTail(feed: FeedItem[]): boolean {
  const last = feed[feed.length - 1];
  return Boolean(last && last.kind === "assistant" && last.streaming);
}

/** 思考段结束时收尾：旧的流式助手条目应显示完成态，不能一直转圈。 */
function finalizeStreamingAssistants(feed: FeedItem[]): FeedItem[] {
  return feed.map((item) =>
    item.kind === "assistant" && item.streaming ? { ...item, streaming: false } : item,
  );
}

/** 会话历史快照 → 尾流种子：直接复用主窗口的 timelineFromHistory，思考/工具/输入输出完整重建 */
let historyKeySeq = 0;
function feedFromMessages(messages: ChatMessage[]): FeedItem[] {
  const timeline = timelineFromHistory(messages, (prefix) => `h${prefix}${historyKeySeq++}`);
  const feed: FeedItem[] = [];
  for (const item of timeline) {
    if (item.kind === "message") {
      if (item.role === "user") {
        feed.push({ key: item.key, kind: "user", text: clip(item.content) });
      } else if (item.role === "assistant" && (item.content || item.thinking)) {
        feed.push({
          key: item.key,
          kind: "assistant",
          text: clip(item.content),
          ...(item.thinking ? { thinking: clip(item.thinking) } : {}),
          streaming: false,
        });
      }
    } else if (item.kind === "tool") {
      feed.push({
        key: item.key,
        kind: "tool",
        callId: item.callId ?? "",
        tool: item.tool,
        input: item.input,
        ...(item.output !== undefined ? { output: item.output } : {}),
        run: false,
        ok: true,
      });
    }
  }
  return feed.slice(-MAX_FEED);
}

let feedKeySeq = 0;
const nextFeedKey = () => {
  feedKeySeq += 1;
  return `f${feedKeySeq}`;
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "snapshot": {
      const running = new Set(action.runningIds);
      let sessions: Record<string, SessionView> = {};
      // 只保留 active + 运行中 + 正在查看的会话，其余淘汰
      const keep = new Set<string>([...(action.activeId ? [action.activeId] : []), ...running]);
      if (state.selectedId) keep.add(state.selectedId);
      for (const id of keep) {
        const existing = state.sessions[id] ?? emptySession(id);
        sessions[id] = {
          ...existing,
          running: running.has(id),
          approvals: action.approvals[id] ?? [],
          // active 会话标题以快照为准；其他会话保留已知的（事件更新）标题
          title: id === action.activeId ? (action.titles[id] ?? existing.title) : (existing.title ?? action.titles[id] ?? null),
          ...(id === action.activeId ? { queued: action.queuedActive } : {}),
        };
      }
      // 选中项失效 → 最新运行中的会话，否则当前会话
      let selectedId = state.selectedId;
      if (!selectedId || !sessions[selectedId]) {
        const latestRunning = [...running]
          .map((id) => sessions[id])
          .filter(Boolean)
          .sort((a, b) => b.activityAt - a.activityAt)[0];
        selectedId = latestRunning?.id ?? action.activeId ?? null;
      }
      return { activeId: action.activeId, connected: true, selectedId, sessions };
    }
    case "history": {
      if (!action.messages.length) return state;
      return upsert(state, action.sessionId, (s) =>
        // 已经有实时尾流就不覆盖（快照可能晚于事件到达）
        s.feed.length ? s : { ...s, feed: feedFromMessages(action.messages) },
      );
    }
    case "select":
      return { ...state, selectedId: action.sessionId };
    case "rewound": {
      // 回滚：源会话尾流作废；正在看它就取消选中，让快照把视图带到回滚后的会话
      const sessions: Record<string, SessionView> = {};
      for (const [id, view] of Object.entries(state.sessions)) {
        sessions[id] = id === action.sessionId ? { ...view, feed: [], running: false } : view;
      }
      return {
        ...state,
        sessions,
        selectedId: state.selectedId === action.sessionId ? null : state.selectedId,
      };
    }
    case "sent":
      return upsert(state, action.sessionId, (s) => ({
        ...s,
        feed: [...s.feed, { key: nextFeedKey(), kind: "user" as const, text: clip(action.text) }].slice(-MAX_FEED),
      }));
    case "sendFailed":
      return upsert(state, action.sessionId, (s) => {
        let index = -1;
        for (let i = s.feed.length - 1; i >= 0; i -= 1) {
          const item = s.feed[i];
          if (item.kind === "user" && item.text === action.text) {
            index = i;
            break;
          }
        }
        if (index < 0) return s;
        return { ...s, feed: s.feed.filter((_, i) => i !== index) };
      });
    case "event": {
      const event = action.event;
      if (event.side) return state;
      // 子 Agent 事件：映射成父会话尾流里的一行 task 工具条目
      if (event.agentId && (event.type === "subagent_started" || event.type === "subagent_completed")) {
        const parentId = event.parentSessionId;
        if (!parentId) return state;
        return upsert(state, parentId, (s) => {
          const base = finalizeStreamingAssistants(s.feed);
          const index = base.findIndex((item) => item.kind === "tool" && item.callId === event.agentId);
          const toolItem: FeedItem = {
            key: nextFeedKey(),
            kind: "tool",
            callId: event.agentId ?? "",
            tool: event.description || "task",
            input: event.prompt,
            run: event.type === "subagent_started",
            ok: event.status !== "failed",
          };
          const feed =
            index >= 0
              ? base.map((item, i) => (i === index ? { ...toolItem, key: (item as { key: string }).key } : item))
              : [...base, toolItem].slice(-MAX_FEED);
          return { ...s, feed, activityAt: Date.now() };
        });
      }
      const sid = event.sessionId;
      if (!sid) return state;
      switch (event.type) {
        case "message_start": {
          // 主窗口发的消息 island 没有乐观气泡：用事件文本补一条；
          // island 自己发送的已由 sent 乐观加过，末尾同文本则去重
          const incoming = typeof event.text === "string" ? event.text : "";
          return upsert(state, sid, (s) => {
            let feed = finalizeStreamingAssistants(s.feed);
            const last = feed[feed.length - 1];
            const alreadyThere = Boolean(incoming) && last?.kind === "user" && last.text === clip(incoming);
            if (incoming && !alreadyThere) {
              feed = [
                ...feed,
                { key: nextFeedKey(), kind: "user" as const, text: clip(incoming) },
              ].slice(-MAX_FEED);
            }
            return { ...s, running: true, thinking: true, feed, activityAt: Date.now() };
          });
        }
        case "thinking_delta": {
          const delta = event.delta ?? "";
          if (!delta) return state;
          return upsert(state, sid, (s) => {
            // 与主窗口同款：增量只追加到"正在流式的末条"，否则新开一条（工具行插入后文本自然换段）
            if (isStreamingAssistantTail(s.feed)) {
              const feed = s.feed.map((item, i) =>
                i === s.feed.length - 1 && item.kind === "assistant"
                  ? { ...item, thinking: (item.thinking ?? "") + delta }
                  : item,
              );
              return { ...s, running: true, thinking: true, feed, activityAt: Date.now() };
            }
            const feed = [
              ...finalizeStreamingAssistants(s.feed),
              { key: nextFeedKey(), kind: "assistant" as const, text: "", thinking: delta, streaming: true },
            ].slice(-MAX_FEED);
            return { ...s, running: true, thinking: true, feed, activityAt: Date.now() };
          });
        }
        case "assistant_delta": {
          const delta = event.delta ?? "";
          if (!delta) return state;
          return upsert(state, sid, (s) => {
            if (isStreamingAssistantTail(s.feed)) {
              const feed = s.feed.map((item, i) =>
                i === s.feed.length - 1 && item.kind === "assistant"
                  ? { ...item, text: clip(item.text + delta) }
                  : item,
              );
              return { ...s, running: true, thinking: false, feed, activityAt: Date.now() };
            }
            const feed = [
              ...finalizeStreamingAssistants(s.feed),
              { key: nextFeedKey(), kind: "assistant" as const, text: clip(delta), streaming: true },
            ].slice(-MAX_FEED);
            return { ...s, running: true, thinking: false, feed, activityAt: Date.now() };
          });
        }
        case "tool_started":
          return upsert(state, sid, (s) => ({
            ...s,
            running: true,
            thinking: false,
            feed: [
              ...finalizeStreamingAssistants(s.feed),
              {
                key: nextFeedKey(),
                kind: "tool" as const,
                callId: event.callId ?? "",
                tool: event.tool ?? "?",
                input: event.input,
                run: true,
                ok: false,
              },
            ].slice(-MAX_FEED),
            activityAt: Date.now(),
          }));
        case "tool_finished":
          return upsert(state, sid, (s) => {
            const ok = event.ok !== false;
            const feed = s.feed.map((item) =>
              item.kind === "tool" && item.callId && item.callId === event.callId
                ? {
                    ...item,
                    run: false,
                    ok,
                    ...(event.output !== undefined ? { output: event.output } : {}),
                  }
                : item,
            );
            // 该工具的审批已处理完（通过或拒绝都伴随该 callId 的 tool_finished）
            const approvals = event.callId ? s.approvals.filter((id) => id !== event.callId) : s.approvals;
            return { ...s, feed, approvals, activityAt: Date.now() };
          });
        case "approval_required":
          return upsert(state, sid, (s) => ({
            ...s,
            approvals: event.callId ? [...s.approvals, event.callId ?? "*"] : [...s.approvals, "*"],
            activityAt: Date.now(),
          }));
        case "approval_resolved":
          return upsert(state, sid, (s) => ({
            ...s,
            approvals: event.callId
              ? s.approvals.filter((id) => id !== event.callId)
              : s.approvals,
            activityAt: Date.now(),
          }));
        case "turn_complete":
          return upsert(state, sid, (s) => ({
            ...s,
            running: false,
            thinking: false,
            approvals: [],
            queued: 0,
            feed: finalizeStreamingAssistants(s.feed),
            activityAt: Date.now(),
          }));
        case "error":
          return upsert(state, sid, (s) => ({
            ...s,
            running: false,
            thinking: false,
            feed: [
              ...finalizeStreamingAssistants(s.feed),
              { key: nextFeedKey(), kind: "error" as const, text: clip(event.message ?? event.error ?? "") },
            ].slice(-MAX_FEED),
            activityAt: Date.now(),
          }));
        case "session_title":
          if (!event.title) return state;
          return upsert(state, sid, (s) => ({ ...s, title: event.title ?? null }));
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

const initialState: State = { activeId: null, selectedId: null, connected: false, sessions: {} };

type SnapshotResponse = {
  id: string;
  title?: string | null;
  runningSessionIds?: string[];
  pendingApprovals?: Array<{ sessionId: string; callId?: string }>;
  queuedPrompts?: unknown[];
};

export default function IslandApp() {
  const { t } = useTranslation("shell");
  const [state, dispatch] = useReducer(reducer, initialState);
  /** 点击胶囊钉住的展开态：点击展开、失焦/移出/Esc 收起（hover 不自动展开） */
  const [pinned, setPinned] = useState(false);
  const [draft, setDraft] = useState("");
  /** 拖入的待发附件：非图片走【附件】协议行，图片走 base64（与主窗口 Composer 同协议） */
  const [pendingFiles, setPendingFiles] = useState<Array<{ key: string; name: string; path: string }>>([]);
  const [pendingImages, setPendingImages] = useState<
    Array<{ key: string; name: string; mimeType: string; data: string; dataUrl: string }>
  >([]);
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const islandRef = useRef<HTMLDivElement | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 隐藏的附件选择 input：与主窗口 Composer 同一套（type=file multiple，选完走 addIslandFiles） */
  const pickInputRef = useRef<HTMLInputElement | null>(null);
  const insideRef = useRef(false);
  const expandedRef = useRef(false);
  const stickRef = useRef(true);
  const snapshotTimerRef = useRef<number | null>(null);
  const connectedRef = useRef(false);
  const baseFontRef = useRef("");

  const expanded = pinned;

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  /** 收起并交还焦点：岛窗口可聚焦（输入框需要），不主动 blur 的话键盘会继续打进看不见的窗口 */
  const collapse = useCallback(() => {
    setPinned(false);
    if (document.hasFocus()) window.blur();
  }, []);

  /** 用户正在输入框里打字时鼠标移出不收起 */
  const isTyping = useCallback(() => document.activeElement === inputRef.current, []);

  // ---- 快照：启动 / server.resync / 回合结束时刷新（标题、运行集合、排队数）----

  const fetchedHistoryRef = useRef(new Set<string>());
  const fetchHistory = useCallback(async (id: string | null, isActive: boolean) => {
    if (!id || fetchedHistoryRef.current.has(id)) return;
    fetchedHistoryRef.current.add(id);
    try {
      const data = await api<{ messages: ChatMessage[] }>(
        isActive ? "/session/messages" : `/session/messages?sessionId=${encodeURIComponent(id)}`,
      );
      dispatch({ type: "history", sessionId: id, messages: data.messages ?? [] });
    } catch {
      // 会话没有 runtime（404）等情况：允许下次快照再试
      fetchedHistoryRef.current.delete(id);
    }
  }, []);

  const refreshSnapshot = useCallback(async () => {
    try {
      const current = await api<SnapshotResponse>("/session");
      let titles: Record<string, string | null> = {};
      try {
        const list = await api<{ sessions: Array<{ id: string; title: string | null }> }>("/sessions");
        titles = Object.fromEntries(list.sessions.map((s) => [s.id, s.title ?? null]));
      } catch {
        // 标题拉不到不阻塞状态刷新
      }
      const runningIds = current.runningSessionIds ?? [];
      const approvals: Record<string, string[]> = {};
      for (const item of current.pendingApprovals ?? []) {
        (approvals[item.sessionId] ??= []).push(item.callId || "*");
      }
      dispatch({
        type: "snapshot",
        activeId: current.id,
        runningIds,
        approvals,
        queuedActive: current.queuedPrompts?.length ?? 0,
        titles,
      });
      connectedRef.current = true;
      // 种子历史：active 永远可拉；运行中的后台会话走 sessionId（有 runtime 才有）
      void fetchHistory(current.id, true);
      for (const id of runningIds) void fetchHistory(id, false);
    } catch {
      // server 未就绪：由启动重试定时器兜底
    }
  }, [fetchHistory]);

  const scheduleSnapshot = useCallback(() => {
    if (snapshotTimerRef.current) window.clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = window.setTimeout(() => void refreshSnapshot(), 500);
  }, [refreshSnapshot]);

  useEffect(() => {
    void refreshSnapshot();
    // server 未就绪时 island 比 server 先起：定时重试直到连上
    const timer = window.setInterval(() => {
      if (!connectedRef.current) void refreshSnapshot();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refreshSnapshot]);

  // ---- 事件流 ----

  useEffect(() => {
    const off = window.meow.onEvent((event: MeowEvent) => {
      if (event.type === "server.resync" || event.type === "server.connected") {
        scheduleSnapshot();
        return;
      }
      if (event.type === "files_rewound" && event.sessionId) {
        // 回滚：源会话的尾流已过时（both/conversation 还切到了派生会话）——
        // 清掉该会话缓存并重拉快照，selectedId 指向源会话时由快照重选 active
        fetchedHistoryRef.current.delete(event.sessionId);
        dispatch({ type: "rewound", sessionId: event.sessionId });
        scheduleSnapshot();
        return;
      }
      dispatch({ type: "event", event });
      // 回合结束/出错后刷新排队数与运行集合（事件本身只做增量）
      if (event.type === "turn_complete" || event.type === "error") scheduleSnapshot();
    });
    return off;
  }, [scheduleSnapshot]);

  // ---- 主题 / 语言 / 字体跟随（preferences-changed 广播）----

  const applyTheme = useCallback((pref: string) => {
    const resolved =
      pref === "light" || pref === "dark"
        ? pref
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.documentElement.dataset.theme = resolved;
  }, []);

  const applyFont = useCallback(async (family: string) => {
    // 首次先记下 tokens 里的默认字体栈，作为自定义字体的回退
    if (!baseFontRef.current) {
      baseFontRef.current = getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim();
    }
    const fallback = baseFontRef.current || "system-ui, sans-serif";
    if (!family) {
      document.documentElement.style.setProperty("--font-sans", fallback);
      return;
    }
    // 导入的自定义字体文件（@font-face）只在主窗口注入过，岛窗口要自己注入一遍
    try {
      const fonts = await window.meow.listCustomFonts();
      const styleId = "island-custom-fonts";
      let style = document.getElementById(styleId) as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement("style");
        style.id = styleId;
        document.head.appendChild(style);
      }
      style.textContent = fonts
        .map((font) => `@font-face { font-family: "${font.family}"; src: url("${font.url}"); }`)
        .join("\n");
    } catch {
      // 拿不到字体列表就只用系统字体
    }
    document.documentElement.style.setProperty("--font-sans", `"${family}", ${fallback}`);
  }, []);

  useEffect(() => {
    // 首次读设置（岛比主窗口晚启动时补齐主题/语言/字体），之后跟随广播
    void window.meow
      .getSettings()
      .then((settings) => {
        applyTheme(settings.theme ?? "system");
        applyLanguage(settings.language ?? "system");
        void applyFont(settings.fontFamily ?? "");
      })
      .catch(() => undefined);
    const off = window.meow.onPreferencesChanged((prefs) => {
      applyTheme(prefs.theme ?? "system");
      applyLanguage(prefs.language ?? "system");
      void applyFont(prefs.fontFamily ?? "");
    });
    return off;
  }, [applyTheme, applyFont]);

  // 系统主题变化（跟随 system 时）
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [applyTheme]);

  // ---- 穿透：渲染层只上报岛体矩形，光标判定由主进程 60ms 轮询完成（meow:island-cursor 回报）----

  const pushIslandRect = useCallback(() => {
    const el = islandRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    void window.meow.setIslandRect({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }, []);

  useEffect(() => {
    pushIslandRect();
    // 形变动画期间宽高逐帧变化：ResizeObserver 每帧重报，主进程轮询始终拿到当前矩形
    const observer = new ResizeObserver(() => pushIslandRect());
    if (islandRef.current) observer.observe(islandRef.current);
    return () => observer.disconnect();
  }, [pushIslandRect, expanded]);

  useEffect(() => {
    const off = window.meow.onIslandCursor((inside) => {
      insideRef.current = inside;
      // 光标离开岛体：收起展开面板（输入中不收）
      if (!inside && expandedRef.current && !isTyping()) collapse();
    });
    return off;
  }, [collapse, isTyping]);

  useEffect(() => {
    const onBlur = () => {
      // 点到岛外（其他应用）：收起。穿透由主进程轮询按光标位置自理，这里不用管
      insideRef.current = false;
      setPinned(false);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  // ---- 展开面板数据 ----

  const visibleSessions = useMemo(() => {
    const list = Object.values(state.sessions).filter(
      (s) => s.running || s.approvals.length > 0 || s.queued > 0 || s.id === state.activeId,
    );
    // 运行中优先（按最近活跃），其后当前会话
    return list.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return b.activityAt - a.activityAt;
    });
  }, [state.sessions, state.activeId]);

  const selected = visibleSessions.find((s) => s.id === state.selectedId) ?? visibleSessions[0] ?? null;

  const approvalCount = visibleSessions.filter((s) => s.approvals.length > 0).length;
  /** 展开面板当前会话是否有 runtime 可收消息（active 恒有；后台要正在运行/排队/审批） */
  const canSend = Boolean(
    selected && (selected.id === state.activeId || selected.running || selected.approvals.length > 0 || selected.queued > 0),
  );

  // 顶栏状态：显示 Agent 当前正在干什么（当前工具 / 思考中 / 流式文本尾部），不显示会话计数
  const { t: tc } = useTranslation("chat");
  // 附件 chip 的标签复用 Composer 的词条
  const { t: tcomp } = useTranslation("composer");
  const activeSession =
    visibleSessions
      .filter((s) => s.running || s.approvals.length > 0)
      .sort((a, b) => b.activityAt - a.activityAt)[0] ?? null;
  const statusText = (() => {
    if (!state.connected) return t("island.connecting");
    if (!activeSession) return approvalCount > 0 ? t("island.waitingApproval") : t("island.idle");
    if (activeSession.approvals.length > 0) return t("island.approvalHint");
    // 最近的一个运行中工具：人话标签（+目标 chip），与主窗口工具行同源
    for (let i = activeSession.feed.length - 1; i >= 0; i -= 1) {
      const entry = activeSession.feed[i];
      if (entry.kind === "user") break;
      if (entry.kind === "tool" && entry.run) {
        const view = presentTool(
          { kind: "tool", key: entry.key, callId: entry.callId, tool: entry.tool, input: entry.input },
          "running",
          tc,
        );
        return clipTail(`${view.label}${view.chip ? ` · ${view.chip}` : ""}`, 42);
      }
    }
    if (activeSession.thinking) return tc("assistant.thinkingInProgress");
    const last = activeSession.feed[activeSession.feed.length - 1];
    if (last?.kind === "assistant" && last.streaming && last.text) return clipTail(last.text, 42);
    if (last?.kind === "error") return t("island.hadError");
    return t("island.working");
  })();

  // ---- 流式自动滚底 ----

  useEffect(() => {
    if (!stickRef.current) return;
    const el = feedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [selected?.feed, expanded]);

  useEffect(() => {
    // 切换查看的会话：回到底部
    stickRef.current = true;
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [selected?.id, expanded]);

  const onFeedScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    // 只有真正贴底才重新吸底：中间区间保持用户的选择，避免流式更新把视图拽回底部
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance > 48) stickRef.current = false;
    else if (distance < 1) stickRef.current = true;
  }, []);

  /** 流式更新可能抢在 scroll 事件之前：滚轮一向上就同步解除吸底 */
  const onFeedWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) stickRef.current = false;
  }, []);

  // ---- 发送 / 停止 / 打开主窗口 ----

  // ---- 拖放附件：文件/图片/文字均可拖到岛上（与主窗口输入框同一套协议） ----

  const addIslandFiles = useCallback(async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/")).slice(0, 8);
    const others = files.filter((file) => !file.type.startsWith("image/"));
    for (const file of images) {
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const data = dataUrl.split(",")[1] ?? "";
        if (!data) continue;
        setPendingImages((current) => [
          ...current,
          { key: nextFeedKey(), name: file.name, mimeType: file.type, data, dataUrl },
        ]);
      } catch {
        // 读取失败的单张图片直接跳过
      }
    }
    const picked: Array<{ key: string; name: string; path: string }> = [];
    const seen = new Set<string>();
    for (const file of others) {
      // 拖入目录时 Chromium 给的是 size=0、无 type 的伪文件：读不出内容，跳过
      if (file.size === 0 && !file.type) continue;
      const absolute = window.meow.getFilePath?.(file) ?? "";
      if (!absolute.trim()) continue;
      const dedupeKey = absolute.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      picked.push({
        key: nextFeedKey(),
        name: file.name || absolute.split(/[\\/]/).pop() || absolute,
        path: absolute,
      });
    }
    if (picked.length) setPendingFiles((current) => [...current, ...picked]);
  }, []);

  const onIslandDragEnter = useCallback((e: ReactDragEvent) => {
    dragDepthRef.current += 1;
    setDragging(true);
    e.preventDefault();
  }, []);

  const onIslandDragOver = useCallback((e: ReactDragEvent) => {
    // 文件与纯文本都允许放置
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onIslandDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }, []);

  const onIslandDrop = useCallback(
    (e: ReactDragEvent) => {
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) {
        // 拖文件进折叠胶囊：顺手展开，用户能看到附件挂上了
        setPinned(true);
        void addIslandFiles(files);
        return;
      }
      // 纯文本拖入：追加进输入框
      const text = e.dataTransfer?.getData("text/plain") ?? "";
      if (text.trim()) setDraft((current) => (current ? `${current}\n${text}` : text));
    },
    [addIslandFiles],
  );

  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (!selected || !canSend) return;
    if (!text && !pendingFiles.length && !pendingImages.length) return;
    setSendError(null);
    setDraft("");
    // 附件协议与主窗口一致：非图片文件 = 首部【附件】行（运行时按绝对路径读内容注入），图片 = 纯 base64 images 字段
    const head = pendingFiles.map((file) => `【附件】${file.name} · ${file.path}`).join("\n"); // i18n-allow 消息首部协议标记，与 src/agent 解析约定一致
    const message = head && text ? `${head}\n\n${text}` : head || text;
    dispatch({ type: "sent", sessionId: selected.id, text: message });
    const restoreFiles = pendingFiles;
    const restoreImages = pendingImages;
    setPendingFiles([]);
    setPendingImages([]);
    try {
      await api("/session/prompt", {
        method: "POST",
        body: JSON.stringify({
          message,
          sessionId: selected.id,
          ...(pendingImages.length
            ? { images: pendingImages.map(({ mimeType, data }) => ({ mimeType, data })) }
            : {}),
        }),
      });
      // 通知主进程广播：主窗口当前会话命中时补用户气泡
      void window.meow.notifyIslandPrompt({ sessionId: selected.id, text: message });
    } catch (err) {
      dispatch({ type: "sendFailed", sessionId: selected.id, text: message });
      setDraft(text);
      // 发送失败：附件还给用户
      setPendingFiles(restoreFiles);
      setPendingImages(restoreImages);
      setSendError(err instanceof Error ? err.message : String(err));
    }
  }, [draft, selected, canSend, pendingFiles, pendingImages]);

  const onInputKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // 中文 IME 组合中不触发发送
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void onSend();
      }
    },
    [onSend],
  );

  const onStop = useCallback(async () => {
    if (!selected) return;
    try {
      await api("/session/abort", { method: "POST", body: JSON.stringify({ sessionId: selected.id }) });
    } catch {
      // 中止失败静默：回合可能刚好结束
    }
  }, [selected]);

  const onInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const onBarClick = useCallback(() => {
    // 点击胶囊展开面板（hover 不自动展开）；打开主窗口走面板右下角的按钮
    setPinned(true);
  }, []);

  const onRootKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === "Escape") collapse();
    },
    [collapse],
  );

  const selectSession = useCallback((id: string) => {
    setSendError(null);
    dispatch({ type: "select", sessionId: id });
  }, []);

  /** 顶栏/面板头共用的状态簇：Logo 左、当前状态文字右（Agent 正在做什么） */
  const statusCluster = (
    <span className="island-pill__status">
      {approvalCount > 0 && <span className="island-dot" aria-hidden />}
      <span className="island-pill__text">{statusText}</span>
    </span>
  );

  return (
    <div className="island-root" ref={rootRef} onKeyDown={onRootKeyDown}>
      {/* 单容器形变：胶囊的宽/高/圆角直接过渡成面板，内容固定尺寸被裁切揭示 */}
      <div
        className="island"
        ref={islandRef}
        data-expanded={expanded}
        data-drag={dragging}
        onDragEnter={onIslandDragEnter}
        onDragOver={onIslandDragOver}
        onDragLeave={onIslandDragLeave}
        onDrop={onIslandDrop}
        onClick={() => {
          if (!expandedRef.current) onBarClick();
        }}
        role="button"
        aria-label={statusText}
      >
        <div className="island-head">
          <img className="island-pill__logo" src={appIcon} alt="" draggable={false} />
          {statusCluster}
        </div>

        <div className="island-rest">
          <div className="island-chips" role="tablist">
            {visibleSessions.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                className="mc-skillchip island-chip"
                data-active={selected?.id === s.id}
                data-run={s.running}
                data-approval={s.approvals.length > 0}
                onClick={() => selectSession(s.id)}
                title={s.title ?? s.id}
              >
                <i className="island-chip__dot" aria-hidden />
                <span className="mc-skillchip__name">{s.title ?? t("island.untitled")}</span>
              </button>
            ))}
          </div>

          <div className="island-feed" ref={feedRef} onScroll={onFeedScroll} onWheel={onFeedWheel}>
            {!selected || selected.feed.length === 0 ? (
              <div className="island-empty">{t("island.empty")}</div>
            ) : (
              <IslandFeed feed={selected.feed} running={selected.running} />
            )}
          </div>

          <div className="island-foot">
            <div className="island-composer">
              {(pendingImages.length > 0 || pendingFiles.length > 0) && (
                <div className="island-attach" role="list" aria-label={tcomp("attach.listAria")}>
                  {pendingImages.map((image) => (
                    <div className="mc-attach__item" role="listitem" key={image.key}>
                      <img className="mc-attach__thumb" src={image.dataUrl} alt={image.name} />
                      <button
                        type="button"
                        className="mc-attach__remove"
                        aria-label={tcomp("attach.removeImageAria")}
                        title={tcomp("attach.remove")}
                        onClick={() => setPendingImages((current) => current.filter((item) => item.key !== image.key))}
                      >
                        <LuX size={12} />
                      </button>
                    </div>
                  ))}
                  {pendingFiles.map((file) => (
                    <span
                      className="mc-skillchip mc-skillchip--file"
                      role="listitem"
                      key={file.key}
                      title={file.path}
                    >
                      <LuFileText size={12} className="mc-skillchip__icon" />
                      <span className="mc-skillchip__name">{file.name}</span>
                      <button
                        type="button"
                        className="island-attach__remove"
                        aria-label={tcomp("attach.remove")}
                        title={tcomp("attach.remove")}
                        onClick={() => setPendingFiles((current) => current.filter((item) => item.key !== file.key))}
                      >
                        <LuX size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                className="mc-composer__input"
                rows={1}
                value={draft}
                disabled={!canSend}
                placeholder={canSend ? t("island.inputPlaceholder") : t("island.inputIdle")}
                onChange={(e) => setDraft(e.target.value)}
                onInput={onInput}
                onKeyDown={onInputKeyDown}
                onPaste={(event) => {
                  // 与主窗口输入框一致：剪贴板里有文件/图片时挂成附件，不再把内容当文本粘进输入框
                  const files = [...(event.clipboardData?.files ?? [])];
                  if (!files.length) return;
                  event.preventDefault();
                  void addIslandFiles(files);
                }}
              />
              <input
                ref={pickInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = "";
                  if (files.length) void addIslandFiles(files);
                }}
              />
              <div className="island-composer__actions">
                <button
                  type="button"
                  className="mc-composer__icon island-composer__attach"
                  disabled={!canSend}
                  onClick={() => pickInputRef.current?.click()}
                  title={tcomp("action.upload")}
                  aria-label={tcomp("action.upload")}
                >
                  <LuPaperclip size={15} />
                </button>
                {selected?.running ? (
                  <button
                    type="button"
                    className="mc-sendbtn"
                    onClick={() => void onStop()}
                    title={t("island.stop")}
                    aria-label={t("island.stop")}
                  >
                    <LuSquare size={13} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="mc-sendbtn"
                    onClick={() => void onSend()}
                    disabled={
                      (!draft.trim() && !pendingFiles.length && !pendingImages.length) || !canSend
                    }
                    title={t("island.send")}
                    aria-label={t("island.send")}
                  >
                    <LuArrowUp size={17} />
                  </button>
                )}
              </div>
            </div>
            {sendError && <div className="island-senderror">{sendError}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}


/**
 * 尾流渲染：与主窗口 MessageList 同一套结构——
 * 按 user 消息切轮，思考/工具行归入 ToolGroup（运行中默认展开、可手动收起，回合结束折叠），
 * 正文单独成段；组件与间距规则全部复用主窗口，保证视觉一致。
 */
function IslandFeed({ feed, running }: { feed: FeedItem[]; running: boolean }) {
  const turns = useMemo(() => {
    const items: TimelineItem[] = feed.map((item) => {
      if (item.kind === "user") {
        return { kind: "message", role: "user", key: item.key, content: item.text };
      }
      if (item.kind === "assistant") {
        return {
          kind: "message",
          role: "assistant",
          key: item.key,
          content: item.text,
          ...(item.thinking ? { thinking: item.thinking } : {}),
          streaming: item.streaming,
        };
      }
      if (item.kind === "tool") {
        // 运行中不传 ok，ToolRow 自己判成 running（转圈）
        return {
          kind: "tool",
          key: item.key,
          callId: item.callId,
          tool: item.tool,
          input: item.input,
          ...(item.output !== undefined ? { output: item.output } : {}),
          ...(item.run ? {} : { ok: item.ok }),
        };
      }
      return { kind: "error", key: item.key, message: item.text };
    });
    const groups: TimelineItem[][] = [];
    let current: TimelineItem[] = [];
    for (const item of items) {
      if (item.kind === "message" && item.role === "user") {
        if (current.length) groups.push(current);
        current = [item];
      } else {
        current.push(item);
      }
    }
    if (current.length) groups.push(current);
    return groups;
  }, [feed]);

  const renderItem = (item: TimelineItem): ReactNode => {
    if (item.kind === "tool") {
      return <ToolRow key={item.key} item={item} />;
    }
    if (item.kind === "error") {
      return (
        <div key={item.key} className="mc-erritem" role="alert">
          <LuCircleAlert size={15} className="mc-erritem__icon" />
          <span className="mc-erritem__text">{item.message}</span>
        </div>
      );
    }
    if (item.kind === "message" && item.role === "user") {
      // 完整复用主窗口的 UserBubble：【附件】协议行会解析成附件 chip，视觉一致
      return <UserBubble key={item.key} content={item.content} />;
    }
    if (item.kind === "message") {
      return (
        <Fragment key={item.key}>
          {item.thinking ? (
            <ThinkingRow thinking={item.thinking} streaming={item.streaming} />
          ) : null}
          {item.content ? (
            <AssistantMessage content={item.content} streaming={item.streaming} />
          ) : null}
        </Fragment>
      );
    }
    return null;
  };

  return (
    <>
      {turns.map((turn, turnIndex) => {
        const isLast = turnIndex === turns.length - 1;
        // 与 MessageList 同款分组算法：正文之前的思考/工具行归入同一组，正文作为轮边界
        const nodes: ReactNode[] = [];
        let buffer: TimelineItem[] = [];
        const flush = () => {
          if (!buffer.length) return;
          nodes.push(
            <ToolGroup
              key={`group:${buffer[0].key}`}
              items={buffer}
              renderItem={renderItem}
              turnRunning={isLast && running}
            />,
          );
          buffer = [];
        };
        for (const item of turn) {
          const isText =
            item.kind === "message" &&
            item.role === "assistant" &&
            item.content.trim().length > 0;
          if (isText) {
            if (item.thinking) buffer.push({ ...item, content: "" });
            flush();
            nodes.push(renderItem(item.thinking ? { ...item, thinking: undefined } : item));
          } else if (
            item.kind === "tool" ||
            (item.kind === "message" && item.role === "assistant")
          ) {
            buffer.push(item);
          } else {
            flush();
            nodes.push(renderItem(item));
          }
        }
        flush();
        return (
          <div className="mc-turn" key={turn[0]?.key ?? `turn-${turnIndex}`}>
            <div className="mc-turn__body">{nodes}</div>
          </div>
        );
      })}
    </>
  );
}

/** 截取尾部片段：状态文字只显示最新内容 */
function clipTail(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/** File → dataURL（岛内图片附件读取） */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
