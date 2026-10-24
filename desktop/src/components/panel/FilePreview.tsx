import { useEffect, useMemo, useState } from "react";
import { LuCopy, LuExternalLink } from "react-icons/lu";
import { api } from "../../api";
import "./FilePreview.css";

/** 单次渲染行数上限（1MB 文本可能上万行，只展示前 N 行并提示） */
const MAX_VIEW_LINES = 3_000;

type PreviewKind = "text" | "image" | "video" | "audio" | "pdf";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "m4a", "flac"]);

function previewKind(filePath: string): PreviewKind {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return "text";
}

function joinWorkspacePath(workspace: string, relative: string): string {
  const base = workspace.replace(/[\\/]+$/, "");
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base}${separator}${relative.replace(/[\\/]+/g, separator)}`;
}

/** base64 → Blob URL（图片/视频/音频/PDF 预览） */
function base64ToBlobUrl(contentBase64: string, mime: string): string {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/**
 * 文件预览：文本（行号 + 等宽）、图片 / 视频 / 音频 / PDF（经 /workspace/raw 转 Blob）。
 * 工作区限定由服务端保证；二进制 20MB、文本 1MB 上限。
 */
export function FilePreview({ path: relativePath, workspace }: { path: string; workspace?: string }) {
  const kind = previewKind(relativePath);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; content?: string; message?: string }>({
    status: "loading",
  });
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let createdUrl: string | null = null;
    setState({ status: "loading" });
    setMediaUrl(null);

    const load = async () => {
      try {
        if (kind === "text") {
          const result = await api<{ content: string }>(`/workspace/file?path=${encodeURIComponent(relativePath)}`);
          if (!disposed) setState({ status: "ready", content: result.content });
          return;
        }
        const raw = await api<{ mime: string; contentBase64: string }>(
          `/workspace/raw?path=${encodeURIComponent(relativePath)}`,
        );
        const url = base64ToBlobUrl(raw.contentBase64, raw.mime);
        createdUrl = url;
        if (disposed) {
          URL.revokeObjectURL(url);
          return;
        }
        setMediaUrl(url);
        setState({ status: "ready" });
      } catch (error) {
        if (!disposed) {
          setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    void load();

    return () => {
      disposed = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [relativePath, kind]);

  const lines = useMemo(() => (state.content ?? "").split(/\r?\n/), [state.content]);
  const visible = lines.slice(0, MAX_VIEW_LINES);

  const copyPath = () => {
    void navigator.clipboard?.writeText(relativePath).catch(() => undefined);
  };
  const openExternal = () => {
    if (workspace) void window.meow.openPath(joinWorkspacePath(workspace, relativePath));
  };

  return (
    <div className="mc-preview">
      <div className="mc-preview__head">
        <span className="mc-preview__path mc-truncate" title={relativePath}>
          {relativePath}
        </span>
        <button type="button" className="mc-preview__btn" aria-label="复制路径" title="复制路径" onClick={copyPath}>
          <LuCopy size={13} />
        </button>
        <button
          type="button"
          className="mc-preview__btn"
          aria-label="在编辑器中打开"
          title="在编辑器中打开"
          disabled={!workspace}
          onClick={openExternal}
        >
          <LuExternalLink size={13} />
        </button>
      </div>

      {state.status === "loading" ? (
        <p className="mc-preview__empty">加载中…</p>
      ) : state.status === "error" ? (
        <p className="mc-preview__empty">{state.message}</p>
      ) : kind === "image" && mediaUrl ? (
        <div className="mc-preview__mediawrap">
          <img className="mc-preview__media" src={mediaUrl} alt={relativePath} />
        </div>
      ) : kind === "video" && mediaUrl ? (
        <div className="mc-preview__mediawrap">
          <video className="mc-preview__media" src={mediaUrl} controls />
        </div>
      ) : kind === "audio" && mediaUrl ? (
        <div className="mc-preview__mediawrap">
          <audio className="mc-preview__audio" src={mediaUrl} controls />
        </div>
      ) : kind === "pdf" && mediaUrl ? (
        <iframe className="mc-preview__frame" src={mediaUrl} title={relativePath} />
      ) : (
        <div className="mc-preview__body">
          {visible.map((line, index) => (
            <div className="mc-preview__line" key={index}>
              <span className="mc-preview__no">{index + 1}</span>
              <span className="mc-preview__text">{line || " "}</span>
            </div>
          ))}
          {lines.length > MAX_VIEW_LINES ? (
            <p className="mc-preview__truncated">
              仅显示前 {MAX_VIEW_LINES} 行（共 {lines.length} 行）
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
