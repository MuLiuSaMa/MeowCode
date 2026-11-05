/** 语言服务诊断的统一形态：行/列均为 1-based，file 为绝对路径。 */
export type LspDiagnostic = {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  code?: string;
  message: string;
  source?: string;
};

export type LspDiagnosticsResult = {
  serverNames: string[];
  diagnostics: LspDiagnostic[];
  /** 没有可用语言服务时的原因；与 diagnostics 可同时存在（部分语言不可用） */
  unavailable?: string;
};

export class LspUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspUnavailableError";
  }
}
