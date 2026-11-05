import { useTranslation } from "react-i18next";
import type { TimelineTool } from "../../api";
import type { ToolStatus } from "./types";
import { resolveToolView } from "./registry";
import { ToolOutputNotes } from "./parts";
import "./ToolViews.css";

/** 工具行展开体：按工具名分流到专属视图，不再统一摊 input/output */
export function ToolBody({
  item,
  status,
  onOpenFile,
}: {
  item: TimelineTool;
  status: ToolStatus;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useTranslation("chat");
  const View = resolveToolView(item.tool);
  return (
    <>
      <View item={item} status={status} t={t} {...(onOpenFile ? { onOpenFile } : {})} />
      <ToolOutputNotes item={item} t={t} />
    </>
  );
}
