import { useId, useState } from "react";
import { LuChevronRight, LuCircleCheck, LuCircleX, LuLoaderCircle } from "react-icons/lu";
import type { TimelineTool } from "../api";
import { CodeBlock } from "./ui/CodeBlock";
import "./ToolRow.css";

type ToolStatus = "running" | "ok" | "failed";

type ToolPresentation = {
  label: string;
  chip?: string;
  chipTitle?: string;
  note?: string;
  detail?: string;
};

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function textArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function presentTool(item: TimelineTool, status: ToolStatus): ToolPresentation {
  const args = asRecord(item.input);
  const target = textArg(args, "path");
  const pattern = textArg(args, "pattern");
  const failedNote = status === "failed" ? "失败" : undefined;

  switch (item.tool) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "multi_edit": {
      const labels: Record<string, string> = {
        read_file: "读取文件",
        write_file: "写入文件",
        edit_file: "修改文件",
        multi_edit: "批量修改",
      };
      const editCount = Array.isArray(args.edits) ? args.edits.length : 0;
      // 跨文件 multi_edit 没有顶层 path：条目上显示涉及几个文件，而不是空标签
      const crossFileCount = Array.isArray(args.edits)
        ? new Set(
            (args.edits as Array<Record<string, unknown> | null>)
              .map((edit) => (typeof edit?.path === "string" ? edit.path : undefined))
              .filter(Boolean),
          ).size
        : 0;
      // 单文件 multi_edit 也把文件名显示出来（多文件时只在 note 里报数量）
      const singleEditPath =
        !target && crossFileCount === 1 && Array.isArray(args.edits)
          ? (args.edits as Array<Record<string, unknown> | null>).find(
              (edit) => typeof edit?.path === "string",
            )?.path
          : undefined;
      const chipPath = target || (typeof singleEditPath === "string" ? singleEditPath : "");
      // 每个写/改文件的调用都要有明确的进行中文案（不是只靠转圈图标）
      const runningNote =
        status === "running"
          ? item.tool === "write_file"
            ? "写入中"
            : "修改中"
          : undefined;
      return {
        label: labels[item.tool],
        chip: chipPath ? baseName(chipPath) : undefined,
        chipTitle: chipPath || undefined,
        note:
          failedNote ??
          runningNote ??
          (item.tool === "multi_edit" && editCount
            ? crossFileCount > 1
              ? `${editCount} 处 / ${crossFileCount} 个文件`
              : `${editCount} 处`
            : undefined),
      };
    }
    case "list_dir":
      return {
        label: "查看目录",
        chip: target && target !== "." ? target : undefined,
        chipTitle: target || undefined,
        note: failedNote,
      };
    case "glob":
      return {
        label: "查找文件",
        chip: pattern || undefined,
        chipTitle: pattern || undefined,
        note: failedNote,
        detail: target && target !== "." ? target : undefined,
      };
    case "grep":
      return {
        label: "搜索内容",
        chip: pattern || undefined,
        chipTitle: pattern || undefined,
        note: failedNote,
        detail: target && target !== "." ? target : undefined,
      };
    case "run_command": {
      const command = textArg(args, "command");
      return {
        label: "终端命令",
        note: status === "running" ? "运行中" : status === "ok" ? "已运行" : "失败",
        detail: command || undefined,
      };
    }
    case "update_plan": {
      const steps = Array.isArray(args.steps) ? args.steps.length : 0;
      return {
        label: "更新计划",
        note: status === "failed" ? "失败" : steps ? `${steps} 步` : "计划更新",
      };
    }
    default:
      return {
        label: "工具调用",
        chip: item.tool || "未知工具",
        chipTitle: item.tool || undefined,
        note: failedNote,
      };
  }
}

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {}, null, 2) ?? "{}";
  } catch {
    return String(input);
  }
}

export function ToolRow({ item }: { item: TimelineTool }) {
  const status: ToolStatus =
    item.ok === undefined ? (item.replayed ? "ok" : "running") : item.ok ? "ok" : "failed";
  const view = presentTool(item, status);
  const [open, setOpen] = useState(false);
  const [bodyMounted, setBodyMounted] = useState(false);
  const detailId = useId();
  /** 写入中 / 修改中的行没有可看的内容（参数可能还没写完、输出也没有）：不展开 */
  const staticRow =
    status === "running" &&
    (item.tool === "write_file" || item.tool === "edit_file" || item.tool === "multi_edit");

  const toggle = () => {
    // 首次展开才挂载详情：历史里大量工具行不必预先序列化 JSON
    if (!open) setBodyMounted(true);
    setOpen((value) => !value);
  };

  const head = (
    <>
      <span className="mc-toolrow__icon" aria-hidden="true">
        {status === "running" ? (
          <LuLoaderCircle size={16} className="mc-toolrow__spin" />
        ) : status === "failed" ? (
          <LuCircleX size={16} />
        ) : (
          <LuCircleCheck size={16} />
        )}
      </span>
      <span className="mc-toolrow__label">{view.label}</span>
      {view.chip ? (
        <span className="mc-toolrow__chip" title={view.chipTitle ?? view.chip}>
          {view.chip}
        </span>
      ) : null}
      {view.note || view.detail ? (
        <span className="mc-toolrow__meta">
          {view.note ? <span className="mc-toolrow__note">{view.note}</span> : null}
          {view.note && view.detail ? (
            <span className="mc-toolrow__dot" aria-hidden="true">
              ·
            </span>
          ) : null}
          {view.detail ? (
            <span className="mc-toolrow__detail" title={view.detail}>
              {view.detail}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );

  if (staticRow) {
    return (
      <div className="mc-toolrow" data-status={status} data-static="true">
        <div className="mc-toolrow__head" role="status">
          {head}
        </div>
      </div>
    );
  }

  return (
    <div className="mc-toolrow" data-status={status}>
      <button
        type="button"
        className="mc-toolrow__head"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={toggle}
      >
        {head}
        <LuChevronRight size={14} className="mc-toolrow__chev" data-open={open} aria-hidden="true" />
      </button>

      <div className="mc-toolrow__collapse" id={detailId} data-open={open}>
        <div className="mc-toolrow__collapse-inner">
          {bodyMounted ? (
            <div className="mc-toolrow__body">
              <CodeBlock label="输入" text={formatInput(item.input)} />
              {item.output !== undefined ? (
                <CodeBlock
                  label={item.truncated ? "输出 · 已截断" : "输出"}
                  text={item.output || "（无输出）"}
                />
              ) : (
                <p className="mc-toolrow__hint">
                  {status === "running"
                    ? "等待输出…"
                    : item.replayed
                      ? "历史记录未保存输出"
                      : "（无输出）"}
                </p>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
