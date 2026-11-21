/**
 * 文件语法类型识别（纯逻辑，无 React 依赖，便于单测）。
 *
 * 编辑 / 查看 / 附件三处展示的是同一份文件名，图标必须按**语法**区分而不是一律给
 * 通用文件图标：`.css` 用 CSS 标记、`.tsx` 用 React 标记、`.json` 用 JSON 标记……
 * 扩展名优先，其次少数没有扩展名的约定文件名（Dockerfile、Makefile、.gitignore…），
 * 认不出的回落到通用文件。
 */

export type FileTypeKey =
  | "react"
  | "typescript"
  | "javascript"
  | "css"
  | "scss"
  | "less"
  | "html"
  | "vue"
  | "svelte"
  | "astro"
  | "json"
  | "markdown"
  | "yaml"
  | "toml"
  | "xml"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "kotlin"
  | "c"
  | "cpp"
  | "csharp"
  | "php"
  | "ruby"
  | "swift"
  | "lua"
  | "dart"
  | "shell"
  | "powershell"
  | "batch"
  | "sql"
  | "notebook"
  | "graphql"
  | "protobuf"
  | "wasm"
  | "docker"
  | "make"
  | "cmake"
  | "gradle"
  | "git"
  | "npm"
  | "env"
  | "image"
  | "svg"
  | "video"
  | "audio"
  | "font"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "archive"
  | "text"
  | "binary"
  | "file";

export type FileType = {
  key: FileTypeKey;
  /** 品牌色 / 分类色：由 FileIcon 注入成 --file-tint，深浅主题各自微调明度 */
  tint: string;
};

/**
 * 品牌色取官方色，但**亮度收进一条能同时看清的区间**：深色画布（#0d0d0d）上
 * 对比度不低于 3.5，浅色画布上靠 FileIcon.css 再压暗一档。官方色偏暗的
 * （CSS 紫、C# 紫、Lua 靛、XML 蓝…）按色相提亮，保留辨识度而不牺牲可读性。
 */
const TINTS: Record<FileTypeKey, string> = {
  react: "#61dafb",
  typescript: "#3178c6",
  javascript: "#f7df1e",
  css: "#874bc3",
  scss: "#cc6699",
  less: "#3868b3",
  html: "#e34f26",
  vue: "#4fc08d",
  svelte: "#ff3e00",
  astro: "#bc52ee",
  json: "#cbcb41",
  markdown: "#519aba",
  yaml: "#d0181f",
  toml: "#b14a25",
  xml: "#006ac1",
  python: "#3776ab",
  rust: "#dea584",
  go: "#00add8",
  java: "#e76f00",
  kotlin: "#7f52ff",
  c: "#a8b9cc",
  cpp: "#006dc0",
  csharp: "#7051dc",
  php: "#777bb4",
  ruby: "#cc342d",
  swift: "#f05138",
  lua: "#5d5ec0",
  dart: "#0175c2",
  shell: "#4eaa25",
  powershell: "#5391fe",
  batch: "#7f9cb8",
  sql: "#e0a458",
  notebook: "#f37626",
  graphql: "#e10098",
  protobuf: "#4285f4",
  wasm: "#654ff0",
  docker: "#2496ed",
  make: "#a06bd6",
  cmake: "#0f7cbf",
  gradle: "#3aa8a0",
  git: "#f05032",
  npm: "#cb3837",
  env: "#e5c07b",
  image: "var(--danger)",
  svg: "#ffb13b",
  video: "var(--accent-violet)",
  audio: "var(--accent-violet)",
  font: "#a855f7",
  pdf: "#e5484d",
  document: "#3469ba",
  spreadsheet: "#227748",
  presentation: "#d24726",
  archive: "#b08c4f",
  text: "var(--fg-subtle)",
  binary: "var(--fg-subtle)",
  file: "var(--fg-subtle)",
};

const EXTENSION_TYPES: Record<string, FileTypeKey> = {
  // 前端框架 / 语言
  tsx: "react",
  jsx: "react",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  html: "html",
  htm: "html",
  // 样式
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  // 数据 / 配置
  json: "json",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  ndjson: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  xsl: "xml",
  xslt: "xml",
  xsd: "xml",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  sql: "sql",
  // 文档
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  mdown: "markdown",
  mkd: "markdown",
  txt: "text",
  text: "text",
  log: "text",
  // 后端语言
  py: "python",
  pyi: "python",
  pyw: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "csharp",
  csx: "csharp",
  php: "php",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  erb: "ruby",
  swift: "swift",
  lua: "lua",
  dart: "dart",
  // 脚本 / 构建
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ksh: "shell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "batch",
  cmd: "batch",
  ipynb: "notebook",
  wasm: "wasm",
  wat: "wasm",
  gradle: "gradle",
  // 媒体
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  avif: "image",
  tif: "image",
  tiff: "image",
  svg: "svg",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  mkv: "video",
  ogv: "video",
  avi: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  flac: "audio",
  aac: "audio",
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  eot: "font",
  // 文档 / 办公
  pdf: "pdf",
  doc: "document",
  docx: "document",
  rtf: "document",
  odt: "document",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  ods: "spreadsheet",
  csv: "spreadsheet",
  tsv: "spreadsheet",
  ppt: "presentation",
  pptx: "presentation",
  odp: "presentation",
  key: "presentation",
  // 压缩包 / 二进制
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  exe: "binary",
  dll: "binary",
  so: "binary",
  dylib: "binary",
  bin: "binary",
  obj: "binary",
  lib: "binary",
  pdb: "binary",
};

/** 没有扩展名、靠文件名约定的类型（全部小写） */
const NAME_TYPES: Record<string, FileTypeKey> = {
  dockerfile: "docker",
  ".dockerignore": "docker",
  makefile: "make",
  "gnumakefile": "make",
  "cmakelists.txt": "cmake",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".gitconfig": "git",
  ".npmrc": "npm",
  ".yarnrc": "npm",
  ".npmignore": "npm",
  ".editorconfig": "text",
  license: "text",
  "license.txt": "text",
  "license.md": "markdown",
};

/** 文件名（去掉目录）；同时接受 / 与 \ 两种分隔符 */
export function fileNameOf(pathOrName: string): string {
  const parts = pathOrName.split(/[\\/]/);
  return parts[parts.length - 1] || pathOrName;
}

/** 扩展名（小写，不含点）；`.gitignore` 这类点开头的文件没有扩展名 */
export function extensionOf(pathOrName: string): string {
  const name = fileNameOf(pathOrName).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

export function fileTypeOf(pathOrName: string): FileType {
  const name = fileNameOf(pathOrName).toLowerCase();
  const named = NAME_TYPES[name];
  if (named) return { key: named, tint: TINTS[named] };
  // .env / .env.local / .env.production：点开头没有扩展名，按前缀识别
  if (name === ".env" || name.startsWith(".env.")) {
    return { key: "env", tint: TINTS.env };
  }
  // Dockerfile.dev / Dockerfile.prod 这类变体同样按文件名识别
  if (name.startsWith("dockerfile.")) {
    return { key: "docker", tint: TINTS.docker };
  }
  const key = EXTENSION_TYPES[extensionOf(name)] ?? "file";
  return { key, tint: TINTS[key] };
}
