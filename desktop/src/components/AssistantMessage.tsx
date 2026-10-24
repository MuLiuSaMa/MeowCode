import { useState } from "react";
import { LuBrain, LuChevronDown } from "react-icons/lu";
import appIcon from "../assets/icon.png";
import { Markdown } from "./ui/Markdown";
import "./AssistantMessage.css";

/** 思考过程：默认收起，用户随时可以手动展开 / 收起。 */
export function AssistantMessage({
  content,
  thinking,
  streaming,
  preparing,
}: {
  content: string;
  thinking?: string;
  streaming?: boolean;
  /** 正在生成工具调用参数：此时没有正文，不要留一个孤立的光标 */
  preparing?: boolean;
}) {
  const hasThinking = Boolean(thinking);
  const [open, setOpen] = useState(false);

  return (
    <article className="mc-assistant">
      <div className="mc-assistant__label">
        <img src={appIcon} alt="" draggable={false} className="mc-assistant__logo" />
        <span>MeowCode</span>
      </div>
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
              <span>{streaming && !content ? "思考中…" : "思考过程"}</span>
              <LuChevronDown size={12} className="mc-thinking__chevron" data-open={open} />
            </summary>
            <div className="mc-thinking__body">{thinking}</div>
          </details>
        ) : null}
        <Markdown content={content} />
        {streaming && !preparing ? <span className="mc-assistant__caret" aria-hidden="true" /> : null}
      </div>
    </article>
  );
}
