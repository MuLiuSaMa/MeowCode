/**
 * 归档列表里那些路径，哪些还能删、哪些早就没文件了。
 *
 * 归档只是 settings.json 里的一串绝对路径。换过数据目录（userData 搬走 / 便携版 /
 * 重装换了 Roaming 目录）之后，老路径会一直留在列表里，但文件已经不在当前
 * sessions 目录下 —— 发给 /sessions/delete 只会被判成非法路径（400），
 * 于是「删除归档」永远失败。
 *
 * 判断依据就是「在不在当前会话索引里」：不在 = 没有文件可删，从列表摘掉即可。
 */

/** Windows 路径大小写不敏感，比较前统一；其它平台保持原样。 */
function normalizePath(value: string): string {
  const trimmed = value.trim();
  return /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")
    ? trimmed.toLowerCase()
    : trimmed;
}

export function partitionArchivedTargets(
  targets: readonly string[],
  knownSessionPaths: Iterable<string>,
): { live: string[]; orphaned: string[] } {
  const known = new Set<string>();
  for (const item of knownSessionPaths) known.add(normalizePath(item));
  const live: string[] = [];
  const orphaned: string[] = [];
  for (const target of targets) {
    if (known.has(normalizePath(target))) live.push(target);
    else orphaned.push(target);
  }
  return { live, orphaned };
}
