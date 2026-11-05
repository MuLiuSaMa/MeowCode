import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuBrain, LuChevronDown } from "react-icons/lu";
import { Markdown } from "./ui/Markdown";
import "./AssistantMessage.css";

/** 思考过程：默认收起，用户随时可以手动展开 / 收起。 */
export function AssistantMessage({
  content,
  thinking,
  messageIndex,
}: {
  content: string;
  thinking?: string;
  /** 历史回放时的消息下标；会话全文检索跳转锚点（data-message-index）用 */
  messageIndex?: number;
}) {
  const { t } = useTranslation("chat");
  const hasThinking = Boolean(thinking);
  const [open, setOpen] = useState(false);

  return (
    <article
      className="mc-assistant"
      {...(messageIndex !== undefined ? { "data-message-index": String(messageIndex) } : {})}
    >
      <div className="mc-assistant__body">
        {hasThinking ? (
          <details className="mc-thinking" open={open}>
            <summary
              className="mc-thinking__summary"
              onClick={(event) => {
                event.preventDefault(); // 自己接管 open 状态，避免浏览器原生 toggle 与状态打架
                setOpen((value) => !value);
              }}
            >
              <LuBrain size={12} className="mc-thinking__icon" />
              <span>{t("assistant.thinking")}</span>
              <LuChevronDown size={12} className="mc-thinking__chevron" data-open={open} />
            </summary>
            <div className="mc-thinking__body">{thinking}</div>
          </details>
        ) : null}
        <Markdown content={content} />
      </div>
    </article>
  );
}
