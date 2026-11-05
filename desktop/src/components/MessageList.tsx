import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCircleAlert, LuInfo } from "react-icons/lu";
import type { SubagentRun, TimelineItem, TimelineMessage } from "../api";
import logo from "../assets/icon.png";
import { AssistantMessage } from "./AssistantMessage";
import { AssistantStatusLine, type AssistantStatus } from "./AssistantStatusLine";
import { CheckpointMarker } from "./CheckpointMarker";
import { CompactionBanner } from "./CompactionBanner";
import { MessageNavigator } from "./MessageNavigator";
import { TaskToolRow } from "./TaskToolRow";
import { ToolRow } from "./ToolRow";
import { UserBubble } from "./UserBubble";
import "./MessageList.css";

/** 表里只存 key：译文在组件里查，切语言才会跟着刷新。 */
const EMPTY_PHRASE_KEYS = [
  "empty.phrase.createSomething",
  "empty.phrase.fixBugs",
  "empty.phrase.dreams",
  "empty.phrase.ideas",
  "empty.phrase.automate",
  "empty.phrase.hardProblems",
  "empty.phrase.handyTool",
  "empty.phrase.nextProject",
  "empty.phrase.tidyCode",
  "empty.phrase.funProduct",
  "empty.phrase.clearLogic",
  "empty.phrase.saveTime",
  "empty.phrase.newDirection",
  "empty.phrase.inspiration",
  "empty.phrase.annoyance",
  "empty.phrase.newFeature",
  "empty.phrase.elegantCode",
  "empty.phrase.mergePr",
  "empty.phrase.together",
  "empty.phrase.usable",
] as const;

const EMPTY_EFFECTS = ["wipe", "glow", "slide"] as const;

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
  const phrases = useMemo(() => EMPTY_PHRASE_KEYS.map((key) => t(key)), [t]);
  const [phraseIndex, setPhraseIndex] = useState(() =>
    Math.floor(Math.random() * EMPTY_PHRASE_KEYS.length),
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPhraseIndex((index) => {
        const next = Math.floor(Math.random() * (EMPTY_PHRASE_KEYS.length - 1));
        return next >= index ? next + 1 : next;
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="mc-empty" aria-label={phrases[phraseIndex]}>
      <img src={logo} alt="" className="mc-empty__logo" />
      {canUse ? (
        <p className="mc-empty__text">
          <span className="mc-empty__words">
            {phrases.map((phrase, index) => {
              const active = index === phraseIndex;
              return (
                <span
                  key={phrase}
                  className="mc-empty__word"
                  data-effect={EMPTY_EFFECTS[index % EMPTY_EFFECTS.length]}
                  data-active={active}
                  aria-hidden={!active}
                >
                  {phrase}
                </span>
              );
            })}
          </span>
        </p>
      ) : (
        <p className="mc-empty__text">{t("empty.setup")}</p>
      )}
    </div>
  );
}

export function MessageList({
  items,
  canUse,
  waiting,
  preparing,
  preparingTool,
  loading,
  subagentsByCallId,
  onOpenSubagent,
  onOpenFile,
  onRestoreCheckpoint,
  onRewindCheckpoint,
  focus,
}: {
  items: TimelineItem[];
  canUse: boolean;
  /** 等待模型响应：发送后首字未到 / 工具执行间隙 */
  waiting?: boolean;
  /** 模型正在生成工具调用参数：显示具体进度文案 */
  preparing?: string | null;
  /** 正在生成写/改文件的参数：先渲染一条「写入中 / 修改中」的工具行占位 */
  preparingTool?: {
    tool: "write_file" | "edit_file";
    path?: string;
    /** 参数里还没读到 path 时的兜底文件名（计划模式下的计划文档） */
    fallbackPath?: string | null;
  } | null;
  /** 正在加载会话：时间线暂时为空时不渲染欢迎页，避免切换时闪烁 */
  loading?: boolean;
  /** 主对话 task 工具行 → 子 Agent 状态（按 callId） */
  subagentsByCallId?: Record<string, SubagentRun>;
  onOpenSubagent?: (agentId: string) => void;
  /** read_file 工具行点击 → 右侧「文件」页签打开（不传则回落为展开输入/输出） */
  onOpenFile?: (path: string) => void;
  /** 检查点「恢复」：从该检查点截断分支出新会话 */
  onRestoreCheckpoint?: (checkpointId: string) => void;
  /** 预览式回滚（对话与代码 / 仅代码）：先出预览对话框再执行 */
  onRewindCheckpoint?: (checkpointId: string, mode: "both" | "code") => void;
  /** 会话全文检索跳转意图：滚动到指定消息并短暂高亮（token 变化触发重播） */
  focus?: { messageIndex: number; token: number } | null;
}) {
  const { t } = useTranslation("chat");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  /** 回合进行中才显示：具体进度 > 压缩 > 等你回答 > 思考中 > 等待模型响应 > 随机文案；回合结束隐藏。 */
  const statusLine = useMemo<{ visible: boolean; status: AssistantStatus | null }>(() => {
    if (preparing) return { visible: true, status: { text: preparing, busy: true } };

    const anchor = lastStatusAnchor(items);

    if (anchor?.kind === "compaction" && anchor.running) {
      return { visible: true, status: { text: t("status.compacting"), busy: true } };
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

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [items, waiting, preparing]);

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
      anchor.scrollIntoView({ block: "center" });
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
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div className="mc-streamwrap">
      <div className="mc-stream" ref={scrollRef} onScroll={handleScroll}>
        <div className="mc-stream__inner">
          {!items.length ? (
            loading ? null : <EmptyState canUse={canUse} />
          ) : (
            <div className="mc-stream__list">
              {items.map((item, _itemIndex) =>
                item.kind === "compaction" ? (
                  <CompactionBanner
                    key={item.key}
                    compacting={Boolean(item.running)}
                    interrupted={Boolean(item.interrupted)}
                    failed={Boolean(item.failed)}
                    note={item.summary ?? null}
                  />
                ) : item.kind === "checkpoint" ? (
                  <CheckpointMarker
                    key={item.key}
                    item={item}
                    onRestore={onRestoreCheckpoint}
                    onRewind={onRewindCheckpoint}
                  />
                ) : item.kind === "tool" ? (
                  (() => {
                    const agent =
                      item.tool === "task" ? subagentsByCallId?.[item.callId] : undefined;
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
                      <button
                        type="button"
                        className="mc-noticeitem__action"
                        onClick={item.action.run}
                      >
                        {item.action.label}
                      </button>
                    ) : null}
                  </div>
                ) : item.kind === "error" ? (
                  <div key={item.key} className="mc-erritem" role="alert">
                    <LuCircleAlert size={15} className="mc-erritem__icon" />
                    <span className="mc-erritem__text">{item.message}</span>
                  </div>
                ) : item.role === "user" ? (
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
                  <AssistantMessage
                    key={item.key}
                    content={item.content}
                    thinking={item.thinking}
                    messageIndex={item.messageIndex}
                  />
                ),
              )}
              {preparingTool ? (
                // 参数还在流式生成：先占一条工具行，明确告诉用户正在写入/修改文件
                <ToolRow
                  key="__preparing_file__"
                  item={{
                    kind: "tool",
                    key: "__preparing_file__",
                    callId: "__preparing_file__",
                    tool: preparingTool.tool,
                    input: (() => {
                      const target = preparingTool.path ?? preparingTool.fallbackPath;
                      return target ? { path: target } : {};
                    })(),
                  }}
                />
              ) : null}
              {statusLine.visible ? <AssistantStatusLine status={statusLine.status} /> : null}
            </div>
          )}
        </div>
      </div>
      {userNavItems.length >= 2 ? (
        <MessageNavigator scrollRef={scrollRef} messages={userNavItems} />
      ) : null}
    </div>
  );
}
