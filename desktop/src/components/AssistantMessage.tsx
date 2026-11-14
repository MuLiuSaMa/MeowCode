import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronRight, LuCircleCheck, LuLoaderCircle } from "react-icons/lu";
import { formatDuration } from "../i18n/format";
import { PluginSlot, PluginWrap } from "../plugins/PluginSlot";
import { Markdown } from "./ui/Markdown";
import "./AssistantMessage.css";
import "./ToolRow.css";

/**
 * 思考过程：外观与工具行完全一致（同一套 mc-toolrow 结构、间距与折叠动画），
 * 默认收起。思考结束后显示「已思考 + 时长 + 内容预览」。
 */
export function ThinkingRow({
  thinking,
  thinkingMs,
  streaming,
  messageIndex,
}: {
  thinking: string;
  /** 思考时长（毫秒）：思考结束后显示在标题右侧 */
  thinkingMs?: number;
  streaming?: boolean;
  /** 历史回放时的消息下标；全文检索跳转锚点用 */
  messageIndex?: number;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [bodyMounted, setBodyMounted] = useState(false);
  const done = thinkingMs !== undefined || !streaming;
  const flat = thinking.replace(/\s+/g, " ").trim();
  // 思考中显示最新一段（尾部），结束后从头展示
  const preview = done ? flat : flat.slice(-160);
  const toggle = () => {
    if (!open) setBodyMounted(true);
    setOpen((value) => !value);
  };

  return (
    <div
      className="mc-toolrow"
      data-status={done ? "ok" : "running"}
      {...(messageIndex !== undefined ? { "data-message-index": String(messageIndex) } : {})}
    >
      <button type="button" className="mc-toolrow__head" aria-expanded={open} onClick={toggle}>
        <span className="mc-toolrow__icon" aria-hidden="true">
          {done ? (
            <LuCircleCheck size={16} />
          ) : (
            <LuLoaderCircle size={16} className="mc-toolrow__spin" />
          )}
        </span>
        <span className="mc-toolrow__label">
          {done ? t("assistant.thinkingDone") : t("assistant.thinkingInProgress")}
        </span>
        {thinkingMs !== undefined ? (
          <span className="mc-toolrow__note">{formatDuration(thinkingMs)}</span>
        ) : null}
        {preview ? (
          <span className="mc-toolrow__preview" title={flat}>
            {preview}
          </span>
        ) : null}
        <LuChevronRight size={14} className="mc-toolrow__chev" data-open={open} aria-hidden="true" />
      </button>
      <div className="mc-toolrow__collapse" data-open={open}>
        <div className="mc-toolrow__collapse-inner">
          {bodyMounted ? (
            <div className="mc-toolrow__body mc-thinking__bodywrap">
              <div className="mc-thinking__text">{thinking}</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 助手正文（思考过程由 ThinkingRow 单独成行，和工具行共用一套间距）。 */
export function AssistantMessage({
  content,
  messageIndex,
  streaming,
}: {
  content: string;
  /** 历史回放时的消息下标；会话全文检索跳转锚点（data-message-index）用 */
  messageIndex?: number;
  /** 正在流式输出：末段内容淡入，看起来像在“写” */
  streaming?: boolean;
}) {
  const slotProps = {
    content,
    streaming: Boolean(streaming),
    messageIndex,
  };
  return (
    <>
      <PluginSlot name="message.assistant.before" props={slotProps} />
      <article
        className="mc-assistant"
        data-streaming={streaming ? "true" : undefined}
        {...(messageIndex !== undefined ? { "data-message-index": String(messageIndex) } : {})}
      >
        <div className="mc-assistant__body">
          <PluginWrap name="message.assistant.body" props={slotProps}>
            <Markdown content={content} />
          </PluginWrap>
        </div>
        <div className="mc-assistant__pluginactions">
          <PluginSlot name="message.assistant.actions" props={slotProps} />
        </div>
      </article>
      <PluginSlot name="message.assistant.after" props={slotProps} />
    </>
  );
}
