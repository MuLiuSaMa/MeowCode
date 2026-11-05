import type { TFunction } from "i18next";
import type { TimelineTool } from "../../api";

export type ToolStatus = "running" | "ok" | "failed";

export type ToolViewProps = {
  item: TimelineTool;
  status: ToolStatus;
  t: TFunction;
  /** 提供时：路径头出现「在右侧打开」；只接受工作区内相对路径 */
  onOpenFile?: (path: string) => void;
};
