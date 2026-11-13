import type { ComponentType } from "react";
import type { ToolViewProps } from "./types";
import type { TimelineTool } from "../../api";
import { asRecord, textArg } from "./parse";
import {
  ApplyPatchView,
  DeleteFileView,
  EditFileView,
  MoveFileView,
  MultiEditView,
  ReadFileView,
  ReadManyView,
  ReadVideoView,
  WriteFileView,
} from "./FileViews";
import { DiagnosticsView, GlobView, GrepView, ListDirView } from "./SearchViews";
import { WebFetchView, WebSearchView } from "./WebViews";
import {
  AdmitView,
  AskUserView,
  ContextStatusView,
  MemoryView,
  PlanView,
  SessionSearchView,
  TaskView,
  ToolSearchView,
} from "./SessionViews";
import { CommandView, GitView, JobView, RunCodeView } from "./TerminalViews";
import { GenericActionView } from "./GenericView";

/** 工具名 → 专属展开体。表里没有的（MCP/插件/未知）走 GenericActionView。 */
export const TOOL_VIEWS: Record<string, ComponentType<ToolViewProps>> = {
  read_file: ReadFileView,
  read_many: ReadManyView,
  read_video: ReadVideoView,
  write_file: WriteFileView,
  edit_file: EditFileView,
  multi_edit: MultiEditView,
  apply_patch: ApplyPatchView,
  delete_file: DeleteFileView,
  move_file: MoveFileView,
  list_dir: ListDirView,
  glob: GlobView,
  grep: GrepView,
  diagnostics: DiagnosticsView,
  run_command: CommandView,
  run_code: RunCodeView,
  job: JobView,
  git: GitView,
  web_search: WebSearchView,
  web_fetch: WebFetchView,
  ask_user: AskUserView,
  update_plan: PlanView,
  task: TaskView,
  memory_read: MemoryView,
  memory_write: MemoryView,
  memory_delete: MemoryView,
  session_search: SessionSearchView,
  tool_search: ToolSearchView,
  context_status: ContextStatusView,
  admit: AdmitView,
};

export function resolveToolView(name: string): ComponentType<ToolViewProps> {
  return TOOL_VIEWS[name] ?? GenericActionView;
}

/** 这些工具只有拿到结果才值得展开：运行中只给路径没有可看的内容 */
const RESULT_ONLY = new Set([
  "read_file",
  "read_many",
  "read_video",
  "list_dir",
  "glob",
  "grep",
  "diagnostics",
  "memory_read",
  "context_status",
  "session_search",
  "tool_search",
]);

/** ToolRow 用：没有可展示内容时不显示 chevron，也不允许展开 */
export function hasToolBody(item: TimelineTool): boolean {
  if (item.ok === false) return true;
  if (item.output !== undefined && item.output !== "") return true;
  if (item.spilled) return true;
  if (RESULT_ONLY.has(item.tool)) return false;

  const args = asRecord(item.input);
  switch (item.tool) {
    case "write_file":
      return textArg(args, "content").length > 0;
    case "edit_file":
      return textArg(args, "oldString").length > 0 || textArg(args, "newString").length > 0;
    case "multi_edit":
      return Array.isArray(args.edits) && args.edits.length > 0;
    case "apply_patch":
      return textArg(args, "patch").trim().length > 0;
    case "ask_user":
      return Array.isArray(args.questions) && args.questions.length > 0;
    case "update_plan":
      return Array.isArray(args.steps) && args.steps.length > 0;
    case "run_command":
      return textArg(args, "command").trim().length > 0;
    case "run_code":
      return textArg(args, "code").length > 0;
    case "git":
    case "job":
      return textArg(args, "action").length > 0;
    case "task":
      return (
        textArg(args, "description").length > 0 ||
        textArg(args, "prompt").length > 0 ||
        textArg(args, "agent_id").length > 0
      );
    case "memory_write":
      return textArg(args, "content").length > 0;
    case "web_search":
      return textArg(args, "query").length > 0;
    case "web_fetch":
      return textArg(args, "url").length > 0;
    default:
      return Object.keys(args).length > 0;
  }
}
