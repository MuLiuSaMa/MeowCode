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
  if (!compacting && !interrupted && !failed && !note) return null;
  return (
    <div
      className="mc-compaction"
      role="status"
      data-active={compacting}
      data-interrupted={interrupted}
      title={!compacting && note ? note : undefined}
    >
      <span className="mc-compaction__rule" aria-hidden="true" />
      <span className="mc-compaction__text">
        {compacting
          ? "正在压缩对话历史…"
          : interrupted
            ? "上次压缩被应用退出中断"
            : failed
              ? "上次压缩失败，历史未压缩"
              : "已压缩对话历史，早期消息以摘要形式保留"}
      </span>
      <span className="mc-compaction__rule" aria-hidden="true" />
    </div>
  );
}
