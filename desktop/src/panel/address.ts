/** 地址栏输入 → 可导航 URL：有协议/像域名/本地地址按网址，否则走搜索 */
export function normalizeAddress(input: string): string {
  const value = input.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return value;
  if (/^localhost(:\d+)?(\/|$)/.test(value)) return `http://${value}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(value)) return `https://${value}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
}
