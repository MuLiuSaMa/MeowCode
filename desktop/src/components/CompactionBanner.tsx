import { useTranslation } from "react-i18next";
import "./CompactionBanner.css";

/**
 * 上下文压缩分隔线：作为时间线条目显示在压缩发生的位置，后续对话排在它下面。
 * 文案居中；摘要全文放在 title 里，不占版面。
 */
export function CompactionBanner({
  compacting,
  interrupted,
  failed,
  note,
}: {
  compacting: boolean;
  /** 上次进程退出时压缩没有完成 */
  interrupted?: boolean;
  /** 摘要请求失败 */
  failed?: boolean;
  note: string | null;
}) {
  const { t } = useTranslation("shell");
  if (!compacting && !interrupted && !failed && !note) return null;
  const label = compacting
    ? t("compaction.compacting")
    : interrupted
      ? t("compaction.interrupted")
      : failed
        ? t("compaction.failed")
        : t("compaction.done");
  return (
    <div
      className="mc-compaction"
      role="status"
      data-active={compacting}
      data-interrupted={interrupted}
      title={!compacting && note ? note : undefined}
    >
      <span className="mc-compaction__rule" aria-hidden="true" />
      <span className="mc-compaction__text">{label}</span>
      <span className="mc-compaction__rule" aria-hidden="true" />
    </div>
  );
}
