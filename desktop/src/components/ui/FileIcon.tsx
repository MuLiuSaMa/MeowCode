import type { ComponentType, CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server.browser";
import {
  SiAstro,
  SiC,
  SiCmake,
  SiCplusplus,
  SiCss,
  SiDart,
  SiDocker,
  SiGit,
  SiGnubash,
  SiGo,
  SiGradle,
  SiGraphql,
  SiHtml5,
  SiJavascript,
  SiKotlin,
  SiLua,
  SiMarkdown,
  SiNpm,
  SiPhp,
  SiProtodotio,
  SiPython,
  SiReact,
  SiRuby,
  SiRust,
  SiSass,
  SiSharp,
  SiSvelte,
  SiSvg,
  SiSwift,
  SiToml,
  SiTypescript,
  SiVuedotjs,
  SiWebassembly,
  SiYaml,
} from "react-icons/si";
import {
  LuBinary,
  LuBraces,
  LuCodeXml,
  LuCoffee,
  LuDatabase,
  LuFile,
  LuFileArchive,
  LuFileSpreadsheet,
  LuFileText,
  LuHammer,
  LuHash,
  LuFilm,
  LuImage,
  LuKeyRound,
  LuMusic,
  LuNotebook,
  LuPresentation,
  LuSquareTerminal,
  LuTerminal,
  LuType,
} from "react-icons/lu";
import { fileTypeOf, type FileTypeKey } from "../../file-types";
import "./FileIcon.css";

/** 只用到两个图标库共同支持的属性，SVG 具体形状由类型表决定 */
type GlyphProps = {
  size?: number;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
};
type Glyph = ComponentType<GlyphProps>;

/**
 * 语法类型 → 图标。品牌图标（simple-icons）优先，通用类型用 lucide 的语义图标；
 * 颜色统一由 file-types.ts 的 tint 提供，这里只管形状。
 */
const GLYPHS: Record<FileTypeKey, Glyph> = {
  react: SiReact,
  typescript: SiTypescript,
  javascript: SiJavascript,
  css: SiCss,
  scss: SiSass,
  less: LuHash,
  html: SiHtml5,
  vue: SiVuedotjs,
  svelte: SiSvelte,
  astro: SiAstro,
  json: LuBraces,
  markdown: SiMarkdown,
  yaml: SiYaml,
  toml: SiToml,
  xml: LuCodeXml,
  python: SiPython,
  rust: SiRust,
  go: SiGo,
  java: LuCoffee,
  kotlin: SiKotlin,
  c: SiC,
  cpp: SiCplusplus,
  csharp: SiSharp,
  php: SiPhp,
  ruby: SiRuby,
  swift: SiSwift,
  lua: SiLua,
  dart: SiDart,
  shell: SiGnubash,
  powershell: LuTerminal,
  batch: LuSquareTerminal,
  sql: LuDatabase,
  notebook: LuNotebook,
  graphql: SiGraphql,
  protobuf: SiProtodotio,
  wasm: SiWebassembly,
  docker: SiDocker,
  make: LuHammer,
  cmake: SiCmake,
  gradle: SiGradle,
  git: SiGit,
  npm: SiNpm,
  env: LuKeyRound,
  image: LuImage,
  svg: SiSvg,
  video: LuFilm,
  audio: LuMusic,
  font: LuType,
  pdf: LuFileText,
  document: LuFileText,
  spreadsheet: LuFileSpreadsheet,
  presentation: LuPresentation,
  archive: LuFileArchive,
  text: LuFileText,
  binary: LuBinary,
  file: LuFile,
};

const MARKUP_CACHE = new Map<string, string>();

/**
 * 同一份图标，给**非 React 的 HTML 管线**用（聊天 Markdown 先渲染成 HTML 字符串）。
 * 按类型 + 尺寸缓存：一次消息里同一个扩展名只序列化一次。
 */
export function fileIconMarkup(path: string, size = 13): string {
  const type = fileTypeOf(path);
  const cacheKey = `${type.key}:${size}`;
  const cached = MARKUP_CACHE.get(cacheKey);
  if (cached) return cached;
  const Glyph = GLYPHS[type.key];
  const markup = renderToStaticMarkup(
    <Glyph
      size={size}
      className="mc-fileicon"
      style={{ "--file-tint": type.tint } as CSSProperties}
      aria-hidden="true"
    />,
  );
  MARKUP_CACHE.set(cacheKey, markup);
  return markup;
}

/**
 * 文件语法图标：编辑 / 查看 / 附件各处共用。
 * 传文件名或任意路径都行（只取最后一段判断扩展名）。
 */
export function FileIcon({
  path,
  size = 13,
  className,
}: {
  path: string;
  size?: number;
  className?: string;
}) {
  const type = fileTypeOf(path);
  const Glyph = GLYPHS[type.key];
  return (
    <Glyph
      size={size}
      className={className ? `mc-fileicon ${className}` : "mc-fileicon"}
      style={{ "--file-tint": type.tint } as CSSProperties}
      aria-hidden="true"
    />
  );
}
