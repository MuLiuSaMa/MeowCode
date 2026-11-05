import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import type { Mermaid } from "mermaid";
import { api } from "../../api";
import { renderMarkdownDocument } from "../../markdown-document";
import { useTheme } from "../../theme/theme";
import "katex/dist/katex.min.css";
import "./MarkdownDocument.css";

let mermaidPromise: Promise<Mermaid> | null = null;
let mermaidTheme: "dark" | "default" | null = null;
let mermaidSeq = 0;
const MERMAID_CACHE_LIMIT = 120;
const svgCache = new Map<string, string>();
const errorCache = new Map<string, string>();

function cachePut(cache: Map<string, string>, key: string, value: string): void {
  if (cache.size >= MERMAID_CACHE_LIMIT) cache.clear();
  cache.set(key, value);
}

async function getMermaid(dark: boolean): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((module) => module.default);
  }
  const mermaid = await mermaidPromise;
  const theme = dark ? "dark" : "default";
  if (mermaidTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      layout: "dagre",
      theme,
      fontFamily: "'MiSans', 'PingFang SC', 'Microsoft YaHei', sans-serif",
      flowchart: {
        curve: "basis",
        nodeSpacing: 260,
        rankSpacing: 160,
        padding: 20,
        diagramPadding: 18,
        wrappingWidth: 300,
        minNodeWidth: 220,
      },
    });
    mermaidTheme = theme;
  }
  return mermaid;
}

function claimMermaidBlocks(root: HTMLElement): HTMLElement[] {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(".mc-md-mermaid[data-src]"));
  for (const code of Array.from(root.querySelectorAll("pre > code.language-mermaid"))) {
    const pre = code.parentElement;
    if (!pre) continue;
    const box = document.createElement("div");
    box.className = "mc-md-mermaid";
    box.setAttribute("data-src", code.textContent ?? "");
    pre.replaceWith(box);
    blocks.push(box);
  }
  return blocks;
}

async function renderMermaid(root: HTMLElement, dark: boolean): Promise<void> {
  const blocks = claimMermaidBlocks(root);
  if (!blocks.length) return;
  const mermaid = await getMermaid(dark).catch(() => null);
  for (const box of blocks) {
    const source = box.getAttribute("data-src") ?? "";
    const key = `${dark ? "d" : "l"}:${source}`;
    let svg = svgCache.get(key);
    let error = svg === undefined ? errorCache.get(key) : undefined;
    if (svg === undefined && error === undefined) {
      if (!mermaid) {
        error = "Failed to load Mermaid.";
      } else {
        try {
          const id = `meow-mermaid-${mermaidSeq++}`;
          svg = (await mermaid.render(id, source)).svg;
          cachePut(svgCache, key, svg);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
          cachePut(errorCache, key, error);
        }
      }
    }
    if (!box.isConnected) continue;
    box.textContent = "";
    if (error !== undefined) {
      box.classList.add("mc-md-mermaid-error");
      const label = document.createElement("div");
      label.className = "mc-md-mermaid-error-label";
      label.textContent = "Mermaid";
      const detail = document.createElement("pre");
      detail.textContent = error;
      box.append(label, detail);
      continue;
    }
    box.classList.remove("mc-md-mermaid-error");
    box.innerHTML = svg ?? "";
    const svgElement = box.querySelector<SVGSVGElement>("svg");
    if (svgElement) {
      svgElement.style.maxWidth = "100%";
      svgElement.style.height = "auto";
    }
  }
}

function resolveDocRelative(docPath: string, src: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURI(src.split("#")[0].split("?")[0]);
  } catch {
    decoded = src.split("#")[0].split("?")[0];
  }
  if (!decoded || /^(?:[a-z]+:|\/\/)/i.test(decoded)) return null;
  const base = decoded.startsWith("/")
    ? []
    : docPath.replace(/\\/g, "/").split("/").slice(0, -1);
  const parts = [...base, ...decoded.replace(/^\/+/, "").split("/")];
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function joinWorkspacePath(workspace: string, relative: string): string {
  const base = workspace.replace(/[\\/]+$/, "");
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base}${separator}${relative.replace(/[\\/]+/g, separator)}`;
}

function base64ToBlobUrl(contentBase64: string, mime: string): string {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/** 文档预览：完整 Markdown + KaTeX + 原始 HTML，Mermaid 与相对图片异步补全。 */
export function MarkdownDocument({
  content,
  docPath,
  workspace,
  className,
}: {
  content: string;
  /** 文档在工作区内的相对路径，用于解析相对图片 */
  docPath?: string;
  workspace?: string;
  className?: string;
}) {
  const { resolved } = useTheme();
  const dark = resolved === "dark";
  const { html } = useMemo(() => renderMarkdownDocument(content ?? ""), [content]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    void renderMermaid(root, dark).catch(() => undefined);
  }, [html, dark]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !docPath) return;
    let disposed = false;
    const objectUrls: string[] = [];

    const hydrateMedia = async () => {
      for (const element of Array.from(root.querySelectorAll<HTMLElement>("img, video, audio"))) {
        const src = element.getAttribute("src") ?? "";
        if (!src || /^(?:https?:|data:|blob:|file:)/i.test(src)) continue;
        const relative = resolveDocRelative(docPath, src);
        if (!relative) continue;
        try {
          const raw = await api<{ mime: string; contentBase64: string }>(
            `/workspace/raw?path=${encodeURIComponent(relative)}`,
          );
          if (disposed) return;
          const url = base64ToBlobUrl(raw.contentBase64, raw.mime);
          objectUrls.push(url);
          element.removeAttribute("srcset");
          element.setAttribute("src", url);
        } catch {
          // 单张图片失败不影响正文；保留原相对路径，便于用户打开源码排查
        }
      }
    };
    void hydrateMedia();

    return () => {
      disposed = true;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [html, docPath]);

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchorElement = (event.target as HTMLElement).closest?.("a");
    if (!anchorElement) return;
    const href = anchorElement.getAttribute("href") ?? "";
    if (!href) return;
    if (href.startsWith("#")) {
      event.preventDefault();
      const target = rootRef.current?.querySelector<HTMLElement>(
        `#${CSS.escape(href.slice(1))}`,
      );
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    if (/^(?:https?:|mailto:)/i.test(href)) {
      event.preventDefault();
      void window.meow.openExternal(href);
      return;
    }
    if (workspace && docPath && !/^(?:[a-z]+:|\/\/)/i.test(href)) {
      const relative = resolveDocRelative(docPath, href);
      if (!relative) return;
      event.preventDefault();
      void window.meow.openPath(joinWorkspacePath(workspace, relative));
    }
  };

  return (
    <div
      ref={rootRef}
      className={["mc-markdown", "mc-md-doc", className ?? ""].filter(Boolean).join(" ")}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
