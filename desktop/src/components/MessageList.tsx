import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
  type WheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { LuCircleAlert, LuInfo } from "react-icons/lu";
import type { SubagentRun, TimelineCompaction, TimelineItem, TimelineMessage } from "../api";
import logo from "../assets/icon.png";
import { planDocPathOf } from "../plan-doc";
import { PlanDocCard } from "./PlanDocCard";
import { PluginSlot, PluginSlotSingle } from "../plugins/PluginSlot";
import { AssistantMessage, ThinkingRow } from "./AssistantMessage";
import { AssistantStatusLine, type AssistantStatus } from "./AssistantStatusLine";
import { CheckpointMarker } from "./CheckpointMarker";
import { CompactionBanner } from "./CompactionBanner";
import { MessageNavigator } from "./MessageNavigator";
import { PromptSuggestion } from "./PromptSuggestion";
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
      <img src={logo} alt="" className="mc-empty__logo" />
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
  onOpenReview,
  onBranchSession,
  focus,
  suggestion,
  onSuggestionUse,
  onSuggestionDismiss,
  onScrolledAwayChange,
  scrollApiRef,
  onOpenPlan,
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
}) {
  const { t } = useTranslation("chat");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  /** 上次上报的「是否滚离底部」，只在状态变化时通知宿主 */
  const scrolledAwayRef = useRef(false);
  const reportScrolledAway = (el: HTMLDivElement | null) => {
    if (!el) return;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight > 200;
    if (away === scrolledAwayRef.current) return;
    scrolledAwayRef.current = away;
    onScrolledAwayChange?.(away);
  };

  /** 回合进行中才显示：具体进度 > 压缩 > 等你回答 > 思考中 > 等待模型响应 > 随机文案；回合结束隐藏。 */
  const statusLine = useMemo<{ visible: boolean; status: AssistantStatus | null }>(() => {
    if (preparing) return { visible: true, status: { text: preparing, busy: true } };

    const anchor = lastStatusAnchor(items);

    // 压缩进行中：末尾的压缩分隔线本身就是指示（它已经后置到底部），
    // 再叠一条状态行会出现两句「正在压缩对话历史」
    if (anchor?.kind === "compaction" && anchor.running) {
      return { visible: false, status: null };
    }

    if (anchor?.kind === "tool" && !anchor.replayed && anchor.ok === undefined) {
      return anchor.tool === "ask_user"
        ? { visible: true, status: { text: t("status.waitingAnswer"), busy: false } }
        : { visible: true, status: null };
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
  }, [items, waiting, preparing, t]);

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
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [items, waiting, preparing, suggestion]);

  // 检索跳转：滚到命中消息并触发描边。deps 只放 focus——
  // 放 items 会在流式输出期间每帧重滚，和用户抢滚动条。
  useEffect(() => {
    if (!focus) return;
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = false;
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
      el.scrollTo({ top: top - Math.max(0, (el.clientHeight - anchor.offsetHeight) / 2) });
      const token = String(focus.token);
      anchor.dataset.flash = token;
      window.setTimeout(() => {
        // 只清除自己这一轮的标记，避免覆盖同 index 的下一次跳转
        if (anchor.dataset.flash === token) delete anchor.dataset.flash;
      }, 1800);
    };
    raf = requestAnimationFrame(() => locate(true));
    return () => cancelAnimationFrame(raf);
  }, [focus]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 只有真正贴底才重新吸底：中间区间保持用户上一次的选择，
    // 否则向上滚一点（仍在 80px 内）会被下一次流式更新直接拽回底部
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance > 80) stickRef.current = false;
    else if (distance < 1) stickRef.current = true;
    reportScrolledAway(el);
  };

  /**
   * 流式输出时内容更新可能抢在 scroll 事件之前：滚轮一向上就同步解除吸底，
   * 否则下一次 delta 到达时 stick 还是 true，会把用户刚滚上去的视图拽回底部。
   */
  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) stickRef.current = false;
  };

  // 滚到底 / 切换会话后重新上报一次（内容变化导致滚动位置被重置时同步按钮显隐）
  useLayoutEffect(() => {
    reportScrolledAway(scrollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // 展开/折叠工具组会改变内容高度但不产生 scroll 事件：用 ResizeObserver 同步「是否离开底部」
  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    if (!el || !(inner instanceof HTMLElement)) return;
    const observer = new ResizeObserver(() => reportScrolledAway(el));
    observer.observe(inner);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!scrollApiRef) return;
    scrollApiRef.current = {
      scrollToBottom: () => {
        const el = scrollRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      },
    };
    return () => {
      scrollApiRef.current = null;
    };
  }, [scrollApiRef]);

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
          <ToolRow key={item.key} item={item} onOpenFile={onOpenFile} />
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
          />
        ) : null}
      </Fragment>
    );

  return (
    <div className="mc-streamwrap">
      <div className="mc-stream" ref={scrollRef} onScroll={handleScroll} onWheel={handleWheel}>
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
                      <PlanDocCard path={turnPlanDoc} onOpen={onOpenPlan} />
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
