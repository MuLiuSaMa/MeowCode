/** 盘符 / POSIX 根 / UNC 开头 = 绝对路径（面板预览只收工作区相对路径） */
export function isAbsolutePath(path: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
}

/** 右侧面板按 posix 路径处理 */
export function panelPath(path: string): string {
  return path.replace(/\\/g, "/");
}
