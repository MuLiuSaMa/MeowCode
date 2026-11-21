import { fileNameOf, fileTypeOf } from "./file-types";

/**
 * 模型正文里的行内代码 →「文件元素」的识别规则（纯逻辑，无 React 依赖，便于单测）。
 *
 * 只认**工作区相对路径**：绝对路径右侧面板打不开，`path:42` 这类带行号的会丢信息，
 * 命令片段 / 函数名 / 域名 / 版本号必须原样留在代码样式里，不能误判成文件。
 */

/** 再长就基本是代码片段而不是路径 */
const MAX_PATH_LENGTH = 200;

/**
 * 命中任意一个字符就说明不是单纯的路径：
 * 空白、引号、通配符、查询串、行号冒号、表达式/括号、URL 分隔符…
 * 反斜杠不在此列（Windows 相对路径先归一成 /）。
 */
const NOT_A_PATH = /[\s<>"'`|*?:;,()[\]{}!$&=%^~@#]/;

function normalizeInlinePath(raw: string): string {
  let path = raw.replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/\/{2,}/g, "/");
  return path;
}

/**
 * 行内代码文本 → 面板可打开的工作区相对路径；不是文件则返回 null。
 * 判定依赖 file-types.ts 的类型表：扩展名/约定文件名认识才算文件。
 */
export function inlineFilePathOf(text: string): string | null {
  const raw = text.trim();
  if (!raw || raw.length > MAX_PATH_LENGTH) return null;
  if (NOT_A_PATH.test(raw)) return null;
  // POSIX 绝对路径 / `~` 家目录：面板只读工作区，不转
  if (raw.startsWith("/") || raw.startsWith("~")) return null;
  const path = normalizeInlinePath(raw);
  if (!path || path.endsWith("/")) return null;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  // 目录（没有扩展名）与未知扩展名都不算文件
  if (fileTypeOf(path).key === "file") return null;
  return path;
}

/** 文件元素的显示名：只显示文件名，完整路径放 title */
export function inlineFileLabel(path: string): string {
  return fileNameOf(path);
}