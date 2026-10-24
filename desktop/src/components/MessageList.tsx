import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LuCircleAlert, LuInfo } from "react-icons/lu";
import type { SubagentRun, TimelineItem } from "../api";
import logo from "../assets/icon.png";
import { AssistantMessage } from "./AssistantMessage";
import { CompactionBanner } from "./CompactionBanner";
import { TaskToolRow } from "./TaskToolRow";
import { ToolRow } from "./ToolRow";
import { UserBubble } from "./UserBubble";
import "./MessageList.css";

const EMPTY_PHRASES = [
  "创造一些了不起的东西",
  "帮助你修复一些BUG",
  "帮助你实现梦想",
  "把想法变成现实",
  "让重复工作自动化",
  "一起解决棘手的问题",
  "写一个趁手的小工具",
  "搭建你的下一个项目",
  "整理混乱的代码",
  "做一个有趣的小产品",
  "把复杂的逻辑理清",
  "帮你节省一点时间",
  "探索一个新的方向",
  "让灵感落地成代码",
  "修好那个恼人的问题",
  "为项目加一个新功能",
  "写一段优雅的实现",
  "把 PR 改到能合并",
  "陪你写完这段代码",
  "让产品更好用一点",
] as const;

const EMPTY_EFFECTS = ["wipe", "glow", "slide"] as const;

function EmptyState({ canUse }: { canUse: boolean }) {
  const [phraseIndex, setPhraseIndex] = useState(() =>
    Math.floor(Math.random() * EMPTY_PHRASES.length),
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPhraseIndex((index) => {
        const next = Math.floor(Math.random() * (EMPTY_PHRASES.length - 1));
        return next >= index ? next + 1 : next;
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="mc-empty" aria-label={EMPTY_PHRASES[phraseIndex]}>
      <img src={logo} alt="" className="mc-empty__logo" />
      {canUse ? (
        <p className="mc-empty__text">
          <span className="mc-empty__words">
            {EMPTY_PHRASES.map((phrase, index) => {
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
        <p className="mc-empty__text">配置模型服务商并选择工作区后即可开始。</p>
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
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [items, waiting, preparing]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div className="mc-stream" ref={scrollRef} onScroll={handleScroll}>
      <div className="mc-stream__inner">
        {!items.length ? (
          loading ? null : <EmptyState canUse={canUse} />
        ) : (
          <div className="mc-stream__list">
            {items.map((item, itemIndex) =>
              item.kind === "compaction" ? (
                <CompactionBanner
                  key={item.key}
                  compacting={Boolean(item.running)}
                  interrupted={Boolean(item.interrupted)}
                  failed={Boolean(item.failed)}
                  note={item.summary ?? null}
                />
              ) : item.kind === "tool" ? (
                (() => {
                  const agent =
                    item.tool === "task" ? subagentsByCallId?.[item.callId] : undefined;
                  return agent && onOpenSubagent ? (
                    <TaskToolRow key={item.key} item={item} agent={agent} onOpen={onOpenSubagent} />
                  ) : (
                    <ToolRow key={item.key} item={item} />
                  );
                })()
              ) : item.kind === "notice" ? (
                <div key={item.key} className="mc-noticeitem" role="status">
                  <LuInfo size={15} className="mc-noticeitem__icon" />
                  <span className="mc-noticeitem__text">{item.message}</span>
                </div>
              ) : item.kind === "error" ? (
                <div key={item.key} className="mc-erritem" role="alert">
                  <LuCircleAlert size={15} className="mc-erritem__icon" />
                  <span className="mc-erritem__text">{item.message}</span>
                </div>
              ) : item.role === "user" ? (
                <UserBubble key={item.key} content={item.content} images={item.images} />
              ) : (
                <AssistantMessage
                  key={item.key}
                  content={item.content}
                  thinking={item.thinking}
                  streaming={item.streaming}
                  // 工具参数生成中：末条助手消息不再显示空白正文的闪动光标
                  preparing={Boolean(
                    (preparing || preparingTool) && itemIndex === items.length - 1,
                  )}
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
            {preparingTool ? null : preparing || waiting ? (
              <div
                className="mc-waiting"
                role="status"
                aria-label={preparing ?? "等待模型响应"}
              >
                <span className="mc-waiting__text">{preparing ?? "等待模型响应"}</span>
                <span className="mc-waiting__dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
