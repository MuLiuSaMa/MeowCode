import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { LuCircleAlert, LuInfo } from "react-icons/lu";
import type { PlanState, SubagentRun, TimelineCompaction, TimelineItem, TimelineMessage } from "../api";
import { wallpaperUrl } from "../api";
import logo from "../assets/logo-cat.webp";
import { planDocPathOf, samePlanDocPath } from "../plan-doc";
import { attachWallpaperLoopFade, bindWallpaperVideoReplica, captureVideoFirstFrame } from "../wallpaper-video";
import { useActiveWallpaperVideo } from "./AppBackground";
import { PlanDocCard } from "./PlanDocCard";
import { PluginSlot, PluginSlotSingle } from "../plugins/PluginSlot";
import { AssistantMessage, ThinkingRow } from "./AssistantMessage";
import { AssistantStatusLine, type AssistantStatus } from "./AssistantStatusLine";
import { CheckpointMarker } from "./CheckpointMarker";
import { CompactionBanner } from "./CompactionBanner";
import { MessageNavigator } from "./MessageNavigator";
import { PromptSuggestion } from "./PromptSuggestion";
import { ShotGallery } from "./ui/ShotGallery";
import { Spinner } from "./ui/Spinner";
import { ToolGroup } from "./ToolGroup";
import { TaskToolRow } from "./TaskToolRow";
import { ToolRow } from "./ToolRow";
import { TurnChangesCard } from "./TurnChangesCard";
import { TurnInfoBar } from "./TurnInfoBar";
import { UserBubble } from "./UserBubble";
import "./MessageList.css";

/** 按 user 消息切分出每一轮：user 开新组，其前的散项（notice/error 等）归第 0 组。 */
function groupIntoTurns(items: TimelineItem[]): TimelineItem[][] {
  const turns: TimelineItem[][] = [];
  let current: TimelineItem[] = [];
  for (const item of items) {
    if (item.kind === "message" && item.role === "user") {
      if (current.length) turns.push(current);
      current = [item];
    } else {
      current.push(item);
    }
  }
  if (current.length) turns.push(current);
  return turns;
}

/**
 * 落在流末尾的压缩提示：渲染到建议行下方，而不是夹在正文与操作行之间。
 *
 * 它不是「这一轮的产出」，放在正文后面会把正文和它的操作行切开。流中间的
 * 压缩提示仍保持原位——那标记的是「压缩发生在哪一段对话之后」，后续对话就
 * 排在它下面，语义不能挪。压缩进行中（running）的同样后置：那时它就是流末尾
 * 的最后一项，留在原处同样会插进正文和操作行之间。
 */
export function pickTrailingCompactions(items: TimelineItem[]): TimelineCompaction[] {
  let index = items.length - 1;
  for (; index >= 0; index -= 1) {
    const { kind } = items[index];
    // 每轮的操作行 / 改动卡 / 检查点不算「内容」：它们后面仍算流的末尾
    if (
      kind === "compaction" ||
      kind === "turn-info" ||
      kind === "turn-changes" ||
      kind === "turn-shots" ||
      kind === "checkpoint"
    ) {
      continue;
    }
    break;
  }
  return items.filter(
    (item, itemIndex): item is TimelineCompaction =>
      itemIndex > index && item.kind === "compaction",
  );
}

/** 状态行锚点：跳过 notice / checkpoint / error，取最后一条对话项。 */
function lastStatusAnchor(items: TimelineItem[]): TimelineItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "message" || item.kind === "tool" || item.kind === "compaction") {
      return item;
    }
  }
  return undefined;
}

function EmptyState({ canUse }: { canUse: boolean }) {
  const { t } = useTranslation("chat");
  const text = canUse ? t("empty.title") : t("empty.setup");

  return (
    <div className="mc-empty" aria-label={text}>
      <img src={logo} alt="" className="mc-empty__logo" draggable={false} />
      <p className="mc-empty__text">{text}</p>
    </div>
  );
}

export function MessageList({
  items,
  canUse,
  waiting,
  turnStartedAt,
  preparing,
  preparingTool,
  loading,
  subagentsByCallId,
  subagentsById,
  onOpenSubagent,
  onOpenFile,
  onRestoreCheckpoint,
  onRewindCheckpoint,
  onEditUserMessage,
  onOpenReview,
  onBranchSession,
  focus,
  suggestion,
  onSuggestionUse,
  onSuggestionDismiss,
  onScrolledAwayChange,
  scrollApiRef,
  onOpenPlan,
  planRevision,
  plan,
  reconnect,
}: {
  items: TimelineItem[];
  canUse: boolean;
  /** 等待模型响应：发送后首字未到 / 工具执行间隙 */
  waiting?: boolean;
  /** 当前生成轮的墙钟起点（毫秒）：消息流末尾状态行右侧实时显示已运行时间；回合结束置 null */
  turnStartedAt?: number | null;
  /** 模型正在生成工具调用参数：显示具体进度文案 */
  preparing?: string | null;
  /** 正在生成写/改文件的参数：先渲染一条「写入中 / 修改中」的工具行占位 */
  preparingTool?: {
    tool: "write_file" | "edit_file" | "delete_file" | "move_file";
    path?: string;
    /** 参数里还没读到 path 时的兜底文件名（计划模式下的计划文档） */
    fallbackPath?: string | null;
  } | null;
  /** 正在加载会话：时间线暂时为空时不渲染欢迎页，避免切换时闪烁 */
  loading?: boolean;
  /** 消息流是否已滚离底部（用于显示「返回底部」按钮） */
  onScrolledAwayChange?: (away: boolean) => void;
  /** 暴露给宿主的滚动操作（返回底部） */
  scrollApiRef?: RefObject<{ scrollToBottom: () => void } | null>;
  /** 主对话 task 工具行 → 子 Agent 状态（按 callId） */
  subagentsByCallId?: Record<string, SubagentRun>;
  /** 续聊 task 行没有新 callId：按输入里的 agent_id 回落到原子 Agent */
  subagentsById?: Record<string, SubagentRun>;
  onOpenSubagent?: (agentId: string) => void;
  /** read_file 工具行点击 → 右侧「文件」页签打开（不传则回落为展开输入/输出） */
  onOpenFile?: (path: string) => void;
  /** 检查点「恢复」：从该检查点截断分支出新会话 */
  onRestoreCheckpoint?: (checkpointId: string) => void;
  /** 预览式回滚（对话与代码 / 仅代码）：先出预览对话框再执行 */
  onRewindCheckpoint?: (checkpointId: string, mode: "both" | "code") => void;
  /** 就地编辑历史用户消息并从该点重跑（仅对话截断，不动文件） */
  onEditUserMessage?: (checkpointId: string, content: string) => void;
  /** 编辑汇总卡片的「审阅」：打开右侧审阅页签 */
  onOpenReview?: () => void;
  /** 每轮操作行的「创建新分支」：复制当前会话为新分支并切过去 */
  onBranchSession?: () => void;
  /** 会话全文检索跳转意图：滚动到指定消息并短暂高亮（token 变化触发重播） */
  focus?: { messageIndex: number; token: number } | null;
  /** 回合结束后预测的下一句：显示在对话末尾，点击填入输入框（不发送） */
  suggestion?: string | null;
  onSuggestionUse?: (text: string) => void;
  onSuggestionDismiss?: () => void;
  /** 打开任意一份计划文档（整卡点击） */
  onOpenPlan?: (path: string) => void;
  /** 最近一次落盘的计划文档：只有同一路径的卡片需要重读，避免全量刷新 */
  planRevision?: { path: string; version: number } | null;
  /** 当前会话的任务清单（plan_updated）：状态行显示进行中的步骤而非干转的点 */
  plan?: PlanState | null;
  /** 模型流断线后的自动重连状态：占用底部状态行 */
  reconnect?: { phase: "started" | "recovered"; attempt: number; maxAttempts: number } | null;
}) {
  const { t } = useTranslation("chat");
  const scrollRef = useRef<HTMLDivElement>(null);
  /* 视频壁纸当前文件：非空时在蒙版根里渲染 <video> 副本，供流内玻璃的 backdrop-filter 采样 */
  const wallpaperVideo = useActiveWallpaperVideo();
  const stickRef = useRef(true);
  /** 缓存的滚动上限（scrollHeight - clientHeight）：滚动回调里读它，避免每个 scroll 事件都强制布局 */
  const maxScrollRef = useRef(0);

  /** 稳定引用：ToolRow 已 memo，这个回调必须保持不变，否则每批增量都会让历史行重渲染 */
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const openFile = useCallback((path: string) => {
    onOpenFileRef.current?.(path);
  }, []);
  /** 上次上报的「是否滚离底部」，只在状态变化时通知宿主 */
  const scrolledAwayRef = useRef(false);
  const syncScrollBounds = (el: HTMLDivElement) => {
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    maxScrollRef.current = max;
    return max;
  };
  const reportScrolledAway = (el: HTMLDivElement | null) => {
    if (!el) return;
    // 平滑吸底过程中滚动位置本来就在追内容，别把「暂时落后」当成用户滚走
    if (smoothFollowRef.current) return;
    const away = maxScrollRef.current - el.scrollTop > 200;
    if (away === scrolledAwayRef.current) return;
    scrolledAwayRef.current = away;
    onScrolledAwayChange?.(away);
  };

  /**
   * 平滑吸底：内容每长出一行，用几帧把 scrollTop 追到新的底部。
   * 不用原生 scrollTo(smooth) —— 流式每 50ms 就会有新目标，原生动画每次
   * 都从静止重启，看起来还是一跳一跳的。这里持续朝最新上限收敛（速度连续），
   * 收敛到半像素内立即停，不空转。
   * 帧内不再读 el.scrollTop（读滚动位置会触发布局）：位置只在循环内追踪，
   * 需要时一次性写回。
   */
  const smoothFollowRef = useRef(false);
  /** 追帧循环自己写入的 scrollTop：滚动事件据此区分程序滚动和用户拖动 */
  const autoScrollTopRef = useRef(0);
  const followRafRef = useRef<number | null>(null);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const statusPinTimerRef = useRef<number | null>(null);
  const stopFollow = useCallback(() => {
    if (followRafRef.current !== null) {
      cancelAnimationFrame(followRafRef.current);
      followRafRef.current = null;
    }
    smoothFollowRef.current = false;
  }, []);
  /**
   * 用户滚动期间给滚动容器挂 data-scrolling：CSS 会把流内毛玻璃的
   * backdrop-filter 和水墨动画暂时停掉，滚动停下 140ms 后恢复。
   * 滚动的每一帧都要给可见玻璃重新采样背景，是掉帧的大头。
   */
  const markScrolling = (el: HTMLDivElement) => {
    if (el.dataset.scrolling !== "true") el.dataset.scrolling = "true";
    if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollIdleTimerRef.current = null;
      delete el.dataset.scrolling;
    }, 140);
  };
  /**
   * 程序化滚动的打点。切会话回填 / 首屏大位移 / 检索跳转 / 吸底追帧都是我们自己写
   * scrollTop，同样会派发 scroll 事件；这类一次性跳转没有逐帧重采样，不该当成用户
   * 滚动去挂 data-scrolling 或改变状态行钉位。滚动事件异步派发，所以同时记录
   * 时间戳和本次写入的位置；原生 smooth 不记位置，仍由实际滚动逐步判断贴底。
   */
  const programmaticScrollAtRef = useRef(0);
  const programmaticScrollTopRef = useRef<number | null>(null);
  const markProgrammaticScroll = useCallback((top?: number) => {
    programmaticScrollAtRef.current = performance.now();
    if (top == null) {
      programmaticScrollTopRef.current = null;
      return;
    }
    autoScrollTopRef.current = top;
    programmaticScrollTopRef.current = top;
  }, []);
  const applyStatusPin = useCallback((el: HTMLDivElement, offset: number, animate = false) => {
    const line = el.querySelector<HTMLElement>(".mc-statusline");
    if (!line) return;
    if (statusPinTimerRef.current !== null) {
      window.clearTimeout(statusPinTimerRef.current);
      statusPinTimerRef.current = null;
    }
    if (!animate && Math.abs(offset) < 0.01) {
      line.style.transition = "";
      line.style.transform = "";
      return;
    }
    line.style.transition = animate ? "transform 140ms ease-out" : "";
    line.style.transform = `translateY(${offset.toFixed(2)}px)`;
    if (animate) {
      statusPinTimerRef.current = window.setTimeout(() => {
        statusPinTimerRef.current = null;
        line.style.transition = "";
        line.style.transform = "";
      }, 140);
    }
  }, []);
  const releaseStatusPin = useCallback(
    (el: HTMLDivElement) => {
      const line = el.querySelector<HTMLElement>(".mc-statusline");
      if (!line?.style.transform) return;
      applyStatusPin(el, 0, true);
    },
    [applyStatusPin],
  );
  useEffect(
    () => () => {
      stopFollow();
      if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
      if (statusPinTimerRef.current !== null) window.clearTimeout(statusPinTimerRef.current);
    },
    [stopFollow],
  );
  const followBottom = (el: HTMLDivElement) => {
    // 已经在追就让循环自己读最新上限，不要重启动画（重启会从静止开始，发顿）
    if (followRafRef.current !== null) return;
    smoothFollowRef.current = true;
    let pos = el.scrollTop;
    applyStatusPin(el, pos - maxScrollRef.current);
    /** 速度：一阶追帧每来一行字速度会从 0 跳变，看起来“顿”一下；这里带速度积分 */
    let velocity = 0;
    const step = () => {
      if (!stickRef.current) {
        stopFollow();
        releaseStatusPin(el);
        return;
      }
      const target = maxScrollRef.current;
      // 内容变短时浏览器已把 scrollTop 钳回上限：本地位置同步，别反向追
      if (pos > target) pos = target;
      const delta = target - pos;
      // 到站且已停稳
      if (Math.abs(delta) < 0.4 && Math.abs(velocity) < 0.4) {
        pos = target;
        el.scrollTop = pos;
        markProgrammaticScroll(pos);
        applyStatusPin(el, 0);
        stopFollow();
        reportScrolledAway(el);
        return;
      }
      /*
       * 临界阻尼追帧：速度连续 —— 增量到来时只是目标变了，速度不会瞬间跳变，
       * 表现为起步加速、匀速跟随、停笔减速，而不是每行“顿”一下。
       */
      velocity = (velocity + delta * 0.14) * 0.76;
      pos += velocity;
      // 永不超过目标（浏览器越界钳位会造成一次硬跳）
      if (pos > target) pos = target;
      el.scrollTop = pos;
      markProgrammaticScroll(pos);
      applyStatusPin(el, pos - target);
      followRafRef.current = requestAnimationFrame(step);
    };
    followRafRef.current = requestAnimationFrame(step);
  };

  /** 回合进行中才显示：具体进度 > 压缩 > 等你回答 > 当前计划步骤 > 思考中 > 等待模型响应 > 随机文案；回合结束隐藏。 */
  const statusLine = useMemo<{ visible: boolean; status: AssistantStatus | null }>(() => {
    if (reconnect?.phase === "started") {
      return {
        visible: true,
        status: {
          text: t("status.reconnecting", {
            attempt: reconnect.attempt,
            max: reconnect.maxAttempts,
          }),
          busy: true,
        },
      };
    }
    if (reconnect?.phase === "recovered") {
      return { visible: true, status: { text: t("status.reconnected"), busy: false } };
    }
    if (preparing) return { visible: true, status: { text: preparing, busy: true } };

    const anchor = lastStatusAnchor(items);

    // 压缩进行中：末尾的压缩分隔线本身就是指示（它已经后置到底部），
    // 再叠一条状态行会出现两句「正在压缩对话历史」
    if (anchor?.kind === "compaction" && anchor.running) {
      return { visible: false, status: null };
    }

    // 任务感知（cc-haha 口径）：工具执行这类静默等待里，状态行显示当前计划
    // 步骤而不是干转的点；工具行本身就带人话标签，不重复。
    const steps = plan?.steps ?? [];
    const activeIndex = steps.findIndex((step) => step.status === "in_progress");
    const activeStep =
      activeIndex >= 0
        ? { title: steps[activeIndex].title, index: activeIndex + 1, total: steps.length }
        : null;

    if (anchor?.kind === "tool" && !anchor.replayed && anchor.ok === undefined) {
      if (anchor.tool === "ask_user") {
        return { visible: true, status: { text: t("status.waitingAnswer"), busy: false } };
      }
      if (activeStep) {
        return {
          visible: true,
          status: {
            text: t("status.step", {
              title: activeStep.title,
              index: activeStep.index,
              total: activeStep.total,
            }),
            busy: true,
          },
        };
      }
      return { visible: true, status: null };
    }

    if (anchor?.kind === "message" && anchor.role === "assistant" && anchor.streaming) {
      return {
        visible: true,
        status:
          anchor.thinking && !anchor.content
            ? { text: t("status.thinking"), busy: true }
            : null,
      };
    }

    if (waiting) return { visible: true, status: { text: t("waiting.response"), busy: true } };

    return { visible: false, status: null };
  }, [items, waiting, preparing, reconnect, plan, t]);

  // 对话浏览条只列用户消息；不足两条时没有浏览意义，不渲染
  const userNavItems = useMemo(
    () =>
      items.filter(
        (item): item is TimelineMessage =>
          item.kind === "message" && item.role === "user",
      ),
    [items],
  );

  // 按轮分组：每轮一个 hover 容器，末尾挂运行耗时信息条
  const turns = useMemo(() => groupIntoTurns(items), [items]);

  /**
   * 落在流末尾的压缩提示：渲染到建议行下方（规则见 pickTrailingCompactions）。
   */
  const trailingCompactions = useMemo(() => pickTrailingCompactions(items), [items]);

  /** 后置的压缩提示不再在回合内出现（避免重复 key 与重复渲染） */
  const tailCompactionKeys = useMemo(
    () => new Set(trailingCompactions.map((item) => item.key)),
    [trailingCompactions],
  );

  /** 正在压缩：底部只有那条分隔线在报状态，建议不该在这时候冒出来 */
  const compactingNow = trailingCompactions.some((item) => item.running);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 内容变了才重新量一次滚动上限；滚动回调随后只读缓存，不再强制布局
    const max = syncScrollBounds(el);
    // 新建/切换会话时时间线会先清空：吸底状态必须回到「贴底」，
    // 否则上一个会话里往上滚过的状态会带进新会话，第一句话都不跟底。
    if (!items.length) {
      stickRef.current = true;
      stopFollow();
      applyStatusPin(el, 0);
      return;
    }
    if (!stickRef.current) return;
    const delta = max - el.scrollTop;
    if (delta <= 0.5) {
      stopFollow();
      el.scrollTop = max;
      markProgrammaticScroll(max);
      applyStatusPin(el, 0);
      return;
    }
    // 切会话 / 首屏回填这类大位移直接到位；流式的一行一行平滑追。
    if (delta > 240 || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      stopFollow();
      el.scrollTop = max;
      markProgrammaticScroll(max);
      applyStatusPin(el, 0);
      return;
    }
    followBottom(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, waiting, preparing, suggestion]);

  // 检索跳转：滚到命中消息并触发描边。deps 只放 focus——
  // 放 items 会在流式输出期间每帧重滚，和用户抢滚动条。
  useEffect(() => {
    if (!focus) return;
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = false;
    stopFollow();
    releaseStatusPin(el);
    let raf = 0;
    const locate = (allowRetry: boolean) => {
      const anchor = el.querySelector<HTMLElement>(`[data-message-index="${focus.messageIndex}"]`);
      if (!anchor) {
        // 会话内容可能还在按需渲染：下一帧再找一次
        if (allowRetry) raf = requestAnimationFrame(() => locate(false));
        return;
      }
      // 只滚消息流自己（scrollIntoView 会连带滚动 overflow:hidden 的祖先）
      const top = anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const targetTop = top - Math.max(0, (el.clientHeight - anchor.offsetHeight) / 2);
      el.scrollTo({ top: targetTop });
      markProgrammaticScroll(el.scrollTop);
      const token = String(focus.token);
      anchor.dataset.flash = token;
      window.setTimeout(() => {
        // 只清除自己这一轮的标记，避免覆盖同 index 的下一次跳转
        if (anchor.dataset.flash === token) delete anchor.dataset.flash;
      }, 1800);
    };
    raf = requestAnimationFrame(() => locate(true));
    return () => cancelAnimationFrame(raf);
  }, [focus, markProgrammaticScroll, releaseStatusPin, stopFollow]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 追帧循环自己写的滚动不算用户操作；用户拖动/滚轮拖走它时停掉跟随
    if (smoothFollowRef.current) {
      if (Math.abs(el.scrollTop - autoScrollTopRef.current) < 2) return;
      stopFollow();
      releaseStatusPin(el);
    }
    const programmaticTop = programmaticScrollTopRef.current;
    if (programmaticTop !== null && Math.abs(el.scrollTop - programmaticTop) < 2) {
      programmaticScrollTopRef.current = null;
      reportScrolledAway(el);
      return;
    }
    programmaticScrollTopRef.current = null;
    // 用户/惯性滚动：滚动期间先关掉流里的毛玻璃和动画（见 MessageList.css）。
    // 但自己刚写过的 scrollTop（120ms 内）不算用户滚动：一次性跳转没有逐帧重采样，
    // 挂上去只会让整条流闪一下「没模糊」。其后的贴底判定照常执行。
    if (performance.now() - programmaticScrollAtRef.current > 120) markScrolling(el);
    // 用户一旦离开贴底位置就交还内容流；滚回真正贴底才重新吸底。
    // 滚动上限用缓存值，不读 scrollHeight，避免流式输出期间每个 scroll 事件都强制布局。
    const distance = maxScrollRef.current - el.scrollTop;
    if (distance > 2) {
      stickRef.current = false;
      releaseStatusPin(el);
    } else if (distance < 1) {
      stickRef.current = true;
    }
    reportScrolledAway(el);
  };

  /**
   * 流式输出时内容更新可能抢在 scroll 事件之前：滚轮一向上就同步解除吸底，
   * 否则下一次 delta 到达时 stick 还是 true，会把用户刚滚上去的视图拽回底部。
   * 用原生 passive 监听：React 的 onWheel 在根节点上非 passive，主线程忙时会拖住滚动。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      if (event.deltaY >= 0) return;
      stickRef.current = false;
      // 用户要往上滚：立刻停掉正在进行的平滑吸底，别和用户抢滚动条
      stopFollow();
      releaseStatusPin(el);
      markScrolling(el);
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, [releaseStatusPin, stopFollow]);

  // 滚到底 / 切换会话后重新上报一次（内容变化导致滚动位置被重置时同步按钮显隐）
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    syncScrollBounds(el);
    reportScrolledAway(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  /*
   * 展开/折叠工具组、思考行逐行变高、图片/懒加载回填都会改变内容高度，
   * 但这些变化不经过 React 更新，只靠 items 的 layout effect 驱动吸底会漏掉，
   * 表现为「行数一变页面直接跳」。ResizeObserver 里同样接上平滑跟随。
   */
  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    if (!el || !(inner instanceof HTMLElement)) return;
    const observer = new ResizeObserver(() => {
      const max = syncScrollBounds(el);
      reportScrolledAway(el);
      if (!stickRef.current) return;
      // 追帧循环在跑时不用管，它会读最新上限
      if (followRafRef.current !== null) return;
      const delta = max - el.scrollTop;
      if (delta <= 0.5) {
        applyStatusPin(el, 0);
        return;
      }
      if (delta > 240 || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        stopFollow();
        el.scrollTop = max;
        markProgrammaticScroll(max);
        applyStatusPin(el, 0);
        return;
      }
      followBottom(el);
    });
    observer.observe(inner);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!scrollApiRef) return;
    scrollApiRef.current = {
      scrollToBottom: () => {
        const el = scrollRef.current;
        if (!el) return;
        stopFollow();
        applyStatusPin(el, 0);
        markProgrammaticScroll();
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      },
    };
    return () => {
      scrollApiRef.current = null;
    };
  }, [scrollApiRef, applyStatusPin, markProgrammaticScroll, stopFollow]);

  // turn-info 不在流里平铺渲染，改由每轮末尾的 TurnInfoBar 承载
  const renderItem = (item: TimelineItem) =>
    item.kind === "compaction" ? (
      tailCompactionKeys.has(item.key) ? null : (
        <CompactionBanner
          key={item.key}
          compacting={Boolean(item.running)}
          interrupted={Boolean(item.interrupted)}
          failed={Boolean(item.failed)}
          note={item.summary ?? null}
        />
      )
    ) : item.kind === "checkpoint" ? (
      <CheckpointMarker
        key={item.key}
        item={item}
        onRestore={onRestoreCheckpoint}
        onRewind={onRewindCheckpoint}
      />
    ) : item.kind === "turn-changes" ? (
      <TurnChangesCard
        key={item.key}
        item={item}
        onUndo={onRewindCheckpoint}
        onReview={onOpenReview}
      />
    ) : item.kind === "turn-shots" ? (
      <ShotGallery
        key={item.key}
        images={item.images}
        label={t("user.imageAlt")}
        className="mc-turnshots"
      />
    ) : item.kind === "tool" ? (
      (() => {
        const args =
          item.input && typeof item.input === "object" && !Array.isArray(item.input)
            ? (item.input as Record<string, unknown>)
            : {};
        const resumeId =
          item.tool === "task" && args.mode === "resume" && typeof args.agent_id === "string"
            ? args.agent_id.trim()
            : "";
        const agent =
          item.tool === "task"
            ? (subagentsByCallId?.[item.callId] ?? (resumeId ? subagentsById?.[resumeId] : undefined))
            : undefined;
        return agent && onOpenSubagent ? (
          <TaskToolRow key={item.key} item={item} agent={agent} onOpen={onOpenSubagent} />
        ) : (
          <ToolRow key={item.key} item={item} onOpenFile={openFile} />
        );
      })()
    ) : item.kind === "notice" ? (
      <div key={item.key} className="mc-noticeitem" role="status">
        <LuInfo size={15} className="mc-noticeitem__icon" />
        <span className="mc-noticeitem__text">{item.message}</span>
        {item.action ? (
          <button type="button" className="mc-noticeitem__action" onClick={item.action.run}>
            {item.action.label}
          </button>
        ) : null}
      </div>
    ) : item.kind === "error" ? (
      <div key={item.key} className="mc-erritem" role="alert">
        <LuCircleAlert size={15} className="mc-erritem__icon" />
        <span className="mc-erritem__text">{item.message}</span>
      </div>
    ) : item.kind === "turn-info" ? null : item.role === "user" ? (
      <UserBubble
        key={item.key}
        content={item.content}
        images={item.images}
        navKey={item.key}
        messageIndex={item.messageIndex}
        checkpointId={item.checkpointId}
        checkpointHasSnapshot={item.checkpointHasSnapshot}
        onRewind={
          onRewindCheckpoint
            ? (checkpointId) => {
                // 自动点挂在消息上：有快照走预览（both），否则直接仅对话回滚
                void onRewindCheckpoint(checkpointId, "both");
              }
            : undefined
        }
        onEdit={onEditUserMessage}
      />
    ) : (
      <Fragment key={item.key}>
        {/* 思考行与工具行同级：共用 turn-body 的工具行间距规则 */}
        {item.thinking ? (
          <ThinkingRow
            key={`${item.key}:thinking`}
            thinking={item.thinking}
            thinkingMs={item.thinkingMs}
            streaming={item.streaming}
            messageIndex={item.messageIndex}
          />
        ) : null}
        {item.content || !item.thinking ? (
          <AssistantMessage
            key={item.key}
            content={item.content}
            messageIndex={item.messageIndex}
            streaming={item.streaming}
            onOpenFile={openFile}
          />
        ) : null}
      </Fragment>
    );

  return (
    <div className="mc-streamwrap">
      <div className="mc-stream" ref={scrollRef} onScroll={handleScroll}>
        {/* 壁纸副本容器：必须住在滚动容器内部。合成滚动会把滚动子树变成玻璃的
            「背板根」，副本留在外层（streamwrap）玻璃就会糊到空背板——这也是
            壁纸模式此前滚动卡顿的根源：为了保玻璃只能放弃合成滚动，每帧主线程
            重栅格化。副本搬进来之后滚动容器可以常驻合成层，滚动回到合成器线程。
            细节见 MessageList.css 蒙版块的架构注释 */}
        <div className="mc-stream__bg" aria-hidden="true">
          {/* 视频壁纸副本：玻璃要糊的「背景」，与 AppBackground 的真视频同源播放（强制静音，
              声音归真视频）。图片壁纸没有这层 —— 由 MessageList.css 的 ::before 位图副本承担 */}
          {wallpaperVideo ? (
            <WallpaperVideoReplica fileName={wallpaperVideo.fileName} />
          ) : null}
        </div>
        <div className="mc-stream__inner">
          <PluginSlot
            name="message.list.before"
            props={{ count: items.length, loading: Boolean(loading) }}
          />
          {!items.length ? (
            loading ? (
              // 切换会话期间：清空时间线但还没加载完，给个加载态而不是空白
              <div className="mc-stream__switching">
                <Spinner size={22} />
              </div>
            ) : (
              <PluginSlotSingle
                name="chat.empty"
                props={{ canUse }}
                fallback={<EmptyState canUse={canUse} />}
              />
            )
          ) : (
            <div className="mc-stream__list">
              {turns.map((turn, turnIndex) => {
                const isLast = turnIndex === turns.length - 1;
                const info = turn.find((item) => item.kind === "turn-info");
                const markdown = turn
                  .map((item) =>
                    item.kind === "message" && item.role === "assistant" ? item.content : "",
                  )
                  .filter(Boolean)
                  .join("\n\n");
                // 纯工具回合没有 assistant 正文：复制按钮退化为复制本轮改动文件清单
                const fileSummary = turn
                  .flatMap((item) => (item.kind === "turn-changes" ? item.files : []))
                  .map((file) => `- ${file.path} (+${file.added} / -${file.removed})`)
                  .join("\n");
                const copyMarkdown = markdown || fileSummary;
                // 本回合写出的计划文档：只认已完成的写盘工具，历史回放同样可识别
                let turnPlanDoc: string | null = null;
                for (let i = turn.length - 1; i >= 0; i -= 1) {
                  const item = turn[i];
                  if (item.kind !== "tool") continue;
                  const path = planDocPathOf(item.tool, item.input);
                  if (path && (item.replayed === true || item.ok === true)) {
                    turnPlanDoc = path;
                    break;
                  }
                }
                return (
                  <div className="mc-turn" key={turn[0]?.key ?? `turn-${turnIndex}`}>
                    <div className="mc-turn__body">
                      {(() => {
                        // 只有模型输出正文才算「一轮」：正文之前的思考/工具行归入同一组，
                        // 组头显示「执行工具 N 次，其中 X 次失败」，运行中展开、本轮结束后折叠。
                        const nodes: ReactNode[] = [];
                        let buffer: TimelineItem[] = [];
                        const flush = () => {
                          if (!buffer.length) return;
                          nodes.push(
                            <ToolGroup
                              key={`group:${buffer[0].key}`}
                              items={buffer}
                              renderItem={renderItem}
                              turnRunning={isLast && turnStartedAt != null}
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
                            // 正文消息自带的思考行属于本轮工作，并入组内展示；
                            // 正文本身作为轮边界单独渲染（分两个副本，避免重复 key 冲突）
                            if (item.thinking) {
                              buffer.push({ ...item, content: "" } as TimelineItem);
                            }
                            flush();
                            nodes.push(
                              renderItem(
                                item.thinking
                                  ? ({ ...item, thinking: undefined } as TimelineItem)
                                  : item,
                              ),
                            );
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
                        // 参数还在流式生成：把「写入中 / 修改中」占位行放回当前组，
                        // 否则它会掉到组外，等 tool_started 再跳回组里
                        if (isLast && preparingTool) {
                          const target = preparingTool.path ?? preparingTool.fallbackPath;
                          buffer.push({
                            kind: "tool",
                            key: "__preparing_file__",
                            callId: "__preparing_file__",
                            tool: preparingTool.tool,
                            input: target ? { path: target } : {},
                          } as TimelineItem);
                        }
                        flush();
                        return nodes;
                      })()}
                    </div>
                    {turnPlanDoc && !(isLast && turnStartedAt != null) ? (
                      <PlanDocCard
                        path={turnPlanDoc}
                        version={
                          samePlanDocPath(planRevision?.path, turnPlanDoc)
                            ? planRevision?.version
                            : undefined
                        }
                        onOpen={onOpenPlan}
                      />
                    ) : null}
                    {info?.kind === "turn-info" ? (
                      <TurnInfoBar
                        durationMs={info.durationMs}
                        endedAt={info.endedAt}
                        usage={info.usage}
                        markdown={copyMarkdown}
                        onBranch={onBranchSession}
                      />
                    ) : null}
                    <PluginSlot
                      name="timeline.turn.tail"
                      props={{
                        turnIndex,
                        markdown,
                        ...(info?.kind === "turn-info"
                          ? {
                              durationMs: info.durationMs,
                              endedAt: info.endedAt,
                              usage: info.usage,
                            }
                          : {}),
                      }}
                    />
                  </div>
                );
              })}
              {statusLine.visible ? (
                <AssistantStatusLine status={statusLine.status} startedAt={turnStartedAt} />
              ) : null}
              {!statusLine.visible && !compactingNow && suggestion ? (
                <PromptSuggestion
                  text={suggestion}
                  onUse={(text) => onSuggestionUse?.(text)}
                  onDismiss={() => onSuggestionDismiss?.()}
                />
              ) : null}
              {trailingCompactions.map((item) => (
                <CompactionBanner
                  key={`tail:${item.key}`}
                  compacting={Boolean(item.running)}
                  interrupted={Boolean(item.interrupted)}
                  failed={Boolean(item.failed)}
                  note={item.summary ?? null}
                />
              ))}
            </div>
          )}
          <PluginSlot
            name="message.list.after"
            props={{ count: items.length, loading: Boolean(loading) }}
          />
        </div>
      </div>
      {userNavItems.length >= 2 ? (
        <MessageNavigator scrollRef={scrollRef} messages={userNavItems} />
      ) : null}
    </div>
  );
}

/** 蒙版根里的全屏视频副本：挂载后一直跟随 AppBackground 的主视频，避免两边各播各的。 */
function WallpaperVideoReplica({ fileName }: { fileName: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const thumbUrl = wallpaperUrl(`${fileName}.thumb.jpg`);
  const [firstFrame, setFirstFrame] = useState<string | null>(thumbUrl);
  /** 首帧抓完、可以开始跟随主视频播放 */
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setFirstFrame(thumbUrl);
    setReady(false);
    const video = ref.current;
    if (!video) return;
    video.pause();
    let cancelled = false;
    let captured = false;
    /** 先抓首帧再让副本起播：淡化时垫在下面的必须是 0 秒画面 */
    const start = () => {
      if (cancelled) return;
      if (!captured) {
        captured = true;
        const frame = captureVideoFirstFrame(video);
        if (frame) setFirstFrame(frame);
      }
      setReady(true);
    };
    if (video.readyState >= 2) start();
    else video.addEventListener("loadeddata", start, { once: true });
    return () => {
      cancelled = true;
      video.removeEventListener("loadeddata", start);
    };
  }, [fileName, thumbUrl]);

  useEffect(() => {
    if (!ready) return;
    const video = ref.current;
    if (!video) return;
    return bindWallpaperVideoReplica(video);
  }, [fileName, ready]);

  useEffect(() => {
    if (!ready || !firstFrame) return;
    const video = ref.current;
    if (!video) return;
    return attachWallpaperLoopFade(video);
  }, [fileName, ready, firstFrame]);

  return (
    <div className="mc-stream__bgvideo">
      {firstFrame ? (
        <img
          className="mc-stream__bgstill"
          src={firstFrame}
          alt=""
          draggable={false}
          onError={() => setFirstFrame((current) => (current === thumbUrl ? null : current))}
        />
      ) : null}
      <video
        ref={ref}
        className="mc-stream__bgclip"
        src={wallpaperUrl(fileName)}
        poster={thumbUrl}
        crossOrigin="anonymous"
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
      />
      <span className="mc-stream__bgdim" aria-hidden="true" />
    </div>
  );
}
