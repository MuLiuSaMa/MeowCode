import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronRight } from "react-icons/lu";
import type { TimelineItem } from "../api";
import "./ToolGroup.css";

/**
 * 一轮里的思考 / 工具行分组。
 *
 * - 只有模型输出正文才结束一轮；正文之前的思考、工具行归入同一组；
 * - 回合运行期间默认展开，但随时可手动收起（流式更新不会把收起的组拽开）；
 * - 整个回合结束后回到默认折叠，可手动展开查看明细。
 */
export function ToolGroup({
  items,
  renderItem,
  turnRunning,
}: {
  items: TimelineItem[];
  renderItem: (item: TimelineItem) => ReactNode;
  /** 整个回合是否仍在运行：true 时默认展开，转为 false 时清除手动状态回到默认折叠 */
  turnRunning: boolean;
}) {
  const { t } = useTranslation("chat");
  const id = useId();
  const tools = items.filter(
    (item): item is Extract<TimelineItem, { kind: "tool" }> => item.kind === "tool",
  );
  const failed = tools.filter((item) => item.ok === false).length;
  // 思考行单独计数：算进组里，但不计入「执行工具」次数
  const thinkings = items.filter(
    (item): item is Extract<TimelineItem, { kind: "message" }> =>
      item.kind === "message" && Boolean(item.thinking),
  ).length;
  // null = 跟随默认（运行中展开 / 结束折叠）；布尔 = 用户手动选择，回合内不被流式更新覆盖
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  useEffect(() => {
    // 回合结束 → 清掉手动状态，回到默认折叠
    if (!turnRunning) setUserOpen(null);
  }, [turnRunning]);
  const open = userOpen ?? turnRunning;
  const summary =
    tools.length > 0
      ? `${t("tool.groupRan", { n: tools.length })}${
          failed > 0 ? t("tool.groupFailed", { n: failed }) : ""
        }${thinkings > 0 ? ` · ${t("tool.groupThinking", { n: thinkings })}` : ""}`
      : t("tool.groupThinking", { n: thinkings });

  return (
    <div className="mc-toolgroup">
      <button
        type="button"
        className="mc-toolgroup__head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setUserOpen(!open)}
      >
        <span className="mc-toolgroup__chevcard" aria-hidden="true">
          <LuChevronRight size={12} className="mc-toolgroup__chev" data-open={open} />
        </span>
        <span className="mc-toolgroup__label">{summary}</span>
      </button>
      <div className="mc-toolgroup__collapse" id={id} data-open={open}>
        <div className="mc-toolgroup__inner">{items.map((item) => renderItem(item))}</div>
      </div>
    </div>
  );
}
