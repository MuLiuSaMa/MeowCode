/**
 * 每工具契约：并发安全、只读、副作用范围、宿主可中断超时。
 *
 * 契约是「声明」，不接管输出裁剪（内置工具的输出上限仍由 tools.ts / tool-output.ts
 * 各自负责）。并行判定以本表为准：只有 readOnly && parallelSafe 的工具才会被
 * agent-loop 放进并发批；未知工具/动态工具缺省一律串行。
 */
export type ToolSideEffects = "none" | "workspace" | "network" | "system";

export type ToolContract = {
  readOnly: boolean;
  /** 仅在与 readOnly 同时为 true 时才允许并发（见 isParallelSafeTool） */
  parallelSafe: boolean;
  sideEffects: ToolSideEffects;
  /**
   * 宿主级超时：只有接收 AbortSignal 的工具（动态工具/MCP/插件）才生效；
   * 内置工具的边界由实现自管（命令 120s、web_fetch 10s、code-mode 30s 等），
   * 不在循环层包超时，避免写操作被「假失败真写入」。
   */
  timeoutMs?: number;
};

const READ_ONLY: ToolContract = {
  readOnly: true,
  parallelSafe: true,
  sideEffects: "none",
};

const READ_ONLY_NETWORK: ToolContract = {
  readOnly: true,
  parallelSafe: true,
  sideEffects: "network",
};

const MUTATING_WORKSPACE: ToolContract = {
  readOnly: false,
  parallelSafe: false,
  sideEffects: "workspace",
};

const MUTATING_SYSTEM: ToolContract = {
  readOnly: false,
  parallelSafe: false,
  sideEffects: "system",
};

/** 只影响会话状态/等待用户，不触碰文件与网络 */
const SESSION_ONLY: ToolContract = {
  readOnly: false,
  parallelSafe: false,
  sideEffects: "none",
};

export const BUILTIN_TOOL_CONTRACTS: Record<string, ToolContract> = {
  list_dir: READ_ONLY,
  read_file: READ_ONLY,
  read_many: READ_ONLY,
  read_video: READ_ONLY,
  glob: READ_ONLY,
  grep: READ_ONLY,
  tool_search: READ_ONLY,
  context_status: READ_ONLY,
  diagnostics: READ_ONLY,
  memory_read: READ_ONLY,
  session_search: READ_ONLY,
  web_search: READ_ONLY_NETWORK,
  web_fetch: READ_ONLY_NETWORK,
  // run_code 不是只读：vm 里的 meow 桥可以 write/edit/multiEdit/run。
  // 历史上它在只读并行集合里，两个 run_code 同批执行会交错写文件；契约收紧为串行。
  run_code: MUTATING_WORKSPACE,
  write_file: MUTATING_WORKSPACE,
  edit_file: MUTATING_WORKSPACE,
  multi_edit: MUTATING_WORKSPACE,
  delete_file: MUTATING_WORKSPACE,
  move_file: MUTATING_WORKSPACE,
  apply_patch: MUTATING_WORKSPACE,
  task: MUTATING_WORKSPACE,
  run_command: MUTATING_SYSTEM,
  job: MUTATING_SYSTEM,
  git: MUTATING_WORKSPACE,
  memory_write: MUTATING_SYSTEM,
  memory_delete: MUTATING_SYSTEM,
  update_plan: SESSION_ONLY,
  ask_user: SESSION_ONLY,
  admit: SESSION_ONLY,
  // 浏览器工具操作的是同一个页面状态，必须串行
  browser_navigate: MUTATING_SYSTEM,
  browser_snapshot: MUTATING_SYSTEM,
  browser_click: MUTATING_SYSTEM,
  browser_type: MUTATING_SYSTEM,
  browser_screenshot: MUTATING_SYSTEM,
  browser_back: MUTATING_SYSTEM,
  browser_reload: MUTATING_SYSTEM,
};

export function builtinToolContract(name: string): ToolContract | undefined {
  return BUILTIN_TOOL_CONTRACTS[name];
}

/** 并行资格：必须同时声明只读与并发安全，缺一不可。 */
export function isParallelSafeContract(contract: ToolContract | undefined): boolean {
  return contract?.readOnly === true && contract.parallelSafe === true;
}
