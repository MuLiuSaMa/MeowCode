/** Win32 调用失败：保留 API 名与精确错误码，runner 的失败契约靠它。 */
export class Win32Error extends Error {
  readonly api: string;
  readonly win32Code: number;

  constructor(api: string, win32Code: number, detail?: string) {
    super(`${api} failed (Win32 ${win32Code})${detail === undefined ? "" : `: ${detail}`}`);
    this.name = "Win32Error";
    this.api = api;
    this.win32Code = win32Code;
  }
}
