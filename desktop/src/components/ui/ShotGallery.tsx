import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { TimelineImage } from "../../api";
import "./ShotGallery.css";

/**
 * 图片画廊：工具返回的截图 / 回合末尾的结果图共用。
 * 每张图点开进遮罩层看大图，点任意处或 Esc 关闭。
 */
export function ShotGallery({
  images,
  label,
  className,
}: {
  images: TimelineImage[];
  /** 无障碍名称与 hover 提示（截图 / 网页截图） */
  label: string;
  /** 额外的定位类（工具行缩进、回合末对齐各不相同） */
  className?: string;
}) {
  const [zoom, setZoom] = useState<TimelineImage | null>(null);
  const shots = images.filter((image) => image.dataUrl || image.src);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoom(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);
  if (!shots.length) return null;
  const srcOf = (image: TimelineImage) => image.dataUrl ?? image.src ?? "";
  return (
    <>
      <div className={className ? `mc-shots ${className}` : "mc-shots"}>
        {shots.map((image, index) => (
          <button
            key={`${image.mimeType}-${index}`}
            type="button"
            className="mc-shot"
            title={label}
            aria-label={label}
            onClick={() => setZoom(image)}
          >
            <img src={srcOf(image)} alt={label} loading="lazy" />
          </button>
        ))}
      </div>
      {zoom
        ? createPortal(
            <div
              className="mc-shotzoom"
              role="dialog"
              aria-modal="true"
              aria-label={label}
              onClick={() => setZoom(null)}
            >
              <img src={srcOf(zoom)} alt={label} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}