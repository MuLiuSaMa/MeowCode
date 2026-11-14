import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronRight, LuFileText } from "react-icons/lu";
import { api } from "../api";
import { extractPlanPreview, type PlanPreview } from "../plan-preview";
import "./PlanDocCard.css";

/**
 * 计划文档卡片：标题 + 内容摘要，整卡点击打开右侧计划页签。
 * 内容从 plans/ 下的文档读取；历史回合和当前回合共用。
 */
export function PlanDocCard({
  path,
  onOpen,
}: {
  /** 工作区相对路径，如 plans/2026-11-14-xxx.md */
  path: string;
  onOpen?: (path: string) => void;
}) {
  const { t } = useTranslation("composer");
  const [preview, setPreview] = useState<PlanPreview | null>(null);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    void api<{ content: string }>(`/workspace/file?path=${encodeURIComponent(path)}`)
      .then((result) => {
        if (!alive) return;
        const fallbackTitle = path.split("/").pop()?.replace(/\.md$/i, "") || t("plan.docTitle");
        setPreview(extractPlanPreview(result.content, fallbackTitle));
      })
      .catch(() => {
        // 文件暂时不可读：保留可点击的卡片，内容回落到路径
      });
    return () => {
      alive = false;
    };
  }, [path, t]);

  const title = preview?.title || t("plan.docTitle");
  const body = preview?.body || path;
  const open = () => onOpen?.(path);

  return (
    <section
      className="mc-plandoc"
      role="button"
      tabIndex={0}
      aria-label={t("plan.docAria")}
      title={path}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      }}
    >
      <div className="mc-plandoc__head">
        <LuFileText size={14} className="mc-plandoc__icon" aria-hidden="true" />
        <span className="mc-plandoc__title">{title}</span>
        <LuChevronRight size={13} className="mc-plandoc__chev" aria-hidden="true" />
      </div>
      <p className="mc-plandoc__body">{body}</p>
    </section>
  );
}
