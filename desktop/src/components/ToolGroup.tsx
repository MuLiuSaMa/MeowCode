import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type TransitionEvent,
} from "react";
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

  const reducedMotion = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** 大组不做高度动画：几十行一次性展开时，逐帧改高度反而更卡，直接一次布局到位 */
  const instant = items.length > 30;

  /**
   * 折叠时内容不挂载：grid 的 0fr 只是把高度收成 0，DOM 与布局树里仍会保留全部
   * 工具行；长会话里这是滚动卡顿的主要来源。收起后等过渡结束再卸载，展开时
   * 先挂内容、下一帧再置 open，保留原有的高度动画。
   */
  const [mounted, setMounted] = useState(open);
  const openRaf = useRef(0);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    // 大组挂载过一次就留在 DOM 里（收起时 display:none，不参与布局/绘制），
    // 否则每次展开都要重新挂载几十行，实测要卡 100ms 以上。
    if (!instant && reducedMotion()) setMounted(false);
  }, [open, instant]);
  useEffect(
    () => () => {
      if (openRaf.current) cancelAnimationFrame(openRaf.current);
    },
    [],
  );

  const toggle = () => {
    if (open) {
      setUserOpen(false);
      // 大组留在 DOM 里靠 CSS 隐藏；小队列在减弱动效下没有过渡事件，直接卸载
      if (!instant && reducedMotion()) setMounted(false);
      return;
    }
    if (!mounted) {
      setMounted(true);
      if (instant) {
        setUserOpen(true);
        return;
      }
      openRaf.current = requestAnimationFrame(() => {
        openRaf.current = 0;
        setUserOpen(true);
      });
      return;
    }
    setUserOpen(true);
  };

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.propertyName !== "grid-template-rows") return;
    if (!open) setMounted(false);
  };

  /** 大组悬停/聚焦时先挂载（收起状态用 display:none 隐藏），把挂载成本从点击挪走 */
  const preMount = () => {
    if (instant && !open && !mounted) setMounted(true);
  };
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
        onClick={toggle}
        onPointerEnter={preMount}
        onFocus={preMount}
      >
        <span className="mc-toolgroup__chevcard" aria-hidden="true">
          <LuChevronRight size={12} className="mc-toolgroup__chev" data-open={open} />
        </span>
        <span className="mc-toolgroup__label">{summary}</span>
      </button>
      <div
        className="mc-toolgroup__collapse"
        id={id}
        data-open={open}
        data-instant={instant ? "true" : undefined}
        onTransitionEnd={handleTransitionEnd}
      >
        {mounted ? (
          <div className="mc-toolgroup__inner">{items.map((item) => renderItem(item))}</div>
        ) : null}
      </div>
    </div>
  );
}
