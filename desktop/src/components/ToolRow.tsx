import { useId, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { LuChevronRight, LuCircleCheck, LuCircleX, LuExternalLink, LuLoaderCircle } from "react-icons/lu";
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

/** 盘符 / POSIX 根 / UNC 开头 = 绝对路径（面板预览只收工作区相对路径） */
function isAbsolutePath(path: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
}

/** 工具行的人话标签映射（悬浮岛顶栏的「当前状态」也复用它） */
export function presentTool(item: TimelineTool, status: ToolStatus, t: TFunction): ToolPresentation {
  const args = asRecord(item.input);
  const target = textArg(args, "path");
  const pattern = textArg(args, "pattern");
  const failedNote = status === "failed" ? t("tool.state.failed") : undefined;

  switch (item.tool) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "multi_edit": {
      const labelKeys: Record<string, string> = {
        read_file: "tool.readFile",
        write_file: "tool.writeFile",
        edit_file: "tool.editFile",
        multi_edit: "tool.multiEdit",
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
          ? t(item.tool === "write_file" ? "tool.state.writing" : "tool.state.editing")
          : undefined;
      return {
        label: t(labelKeys[item.tool]),
        chip: chipPath ? baseName(chipPath) : undefined,
        chipTitle: chipPath || undefined,
        note:
          failedNote ??
          runningNote ??
          (item.tool === "multi_edit" && editCount
            ? crossFileCount > 1
              ? `${t("tool.editCount", { count: editCount })} / ${t("tool.fileCount", { count: crossFileCount })}`
              : t("tool.editCount", { count: editCount })
            : undefined),
      };
    }
    case "list_dir":
      return {
        label: t("tool.listDir"),
        chip: target && target !== "." ? target : undefined,
        chipTitle: target || undefined,
        note: failedNote,
      };
    case "glob":
      return {
        label: t("tool.findFiles"),
        chip: pattern || undefined,
        chipTitle: pattern || undefined,
        note: failedNote,
        detail: target && target !== "." ? target : undefined,
      };
    case "grep":
      return {
        label: t("tool.searchContent"),
        chip: pattern || undefined,
        chipTitle: pattern || undefined,
        note: failedNote,
        detail: target && target !== "." ? target : undefined,
      };
    case "run_command": {
      const command = textArg(args, "command");
      return {
        label: t("tool.runCommand"),
        note:
          status === "running"
            ? t("tool.state.running")
            : status === "ok"
              ? t("tool.state.done")
              : t("tool.state.failed"),
        detail: command || undefined,
      };
    }
    case "diagnostics":
      return {
        label: t("tool.diagnostics"),
        chip: target && target !== "." ? baseName(target) : undefined,
        chipTitle: target || undefined,
        note: failedNote,
      };
    case "update_plan": {
      const steps = Array.isArray(args.steps) ? args.steps.length : 0;
      return {
        label: t("tool.updatePlan"),
        note: status === "failed"
          ? t("tool.state.failed")
          : steps
            ? t("tool.stepCount", { count: steps })
            : t("tool.planUpdated"),
      };
    }
    case "read_many":
    case "read_video":
    case "run_code":
    case "task":
    case "context_status":
    case "ask_user":
    case "memory_read":
    case "memory_write":
    case "memory_delete":
    case "admit":
    case "tool_search": {
      const labelKeys: Record<string, string> = {
        read_many: "tool.readMany",
        read_video: "tool.readVideo",
        run_code: "tool.runCode",
        task: "tool.task",
        context_status: "tool.contextStatus",
        ask_user: "tool.askUser",
        memory_read: "tool.memoryRead",
        memory_write: "tool.memoryWrite",
        memory_delete: "tool.memoryDelete",
        admit: "tool.admit",
        tool_search: "tool.toolSearch",
      };
      return { label: t(labelKeys[item.tool]), note: failedNote };
    }
    case "browser_navigate":
    case "browser_snapshot":
    case "browser_click":
    case "browser_type":
    case "browser_screenshot":
    case "browser_back":
    case "browser_reload": {
      const labelKeys: Record<string, string> = {
        browser_navigate: "tool.browserNavigate",
        browser_snapshot: "tool.browserSnapshot",
        browser_click: "tool.browserClick",
        browser_type: "tool.browserType",
        browser_screenshot: "tool.browserScreenshot",
        browser_back: "tool.browserBack",
        browser_reload: "tool.browserReload",
      };
      return { label: t(labelKeys[item.tool]), note: failedNote };
    }
    case "computer_screenshot":
    case "computer_click":
    case "computer_type":
    case "computer_key":
    case "computer_scroll":
    case "computer_drag":
    case "computer_window_list":
    case "computer_window_activate":
    case "computer_clipboard":
    case "computer_wait": {
      const input = (item.input ?? {}) as Record<string, unknown>;
      const labelKeys: Record<string, string> = {
        computer_screenshot: "tool.computerScreenshot",
        computer_click: "tool.computerClick",
        computer_type: "tool.computerType",
        computer_key: "tool.computerKey",
        computer_scroll: "tool.computerScroll",
        computer_drag: "tool.computerDrag",
        computer_window_list: "tool.computerWindowList",
        computer_window_activate: "tool.computerWindowActivate",
        computer_clipboard: "tool.computerClipboard",
        computer_wait: "tool.computerWait",
      };
      let chip: string | undefined;
      if (item.tool === "computer_click") {
        chip = `${input.x ?? "?"},${input.y ?? "?"}${input.clicks && input.clicks !== 1 ? ` ×${input.clicks}` : ""}${input.button && input.button !== "left" ? ` ${input.button}` : ""}`;
      } else if (item.tool === "computer_key") {
        chip = typeof input.key === "string" ? input.key : undefined;
      } else if (item.tool === "computer_type") {
        const text = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim() : "";
        chip = text ? text.slice(0, 32) : undefined;
      } else if (item.tool === "computer_scroll") {
        chip = `${input.direction ?? "?"}${input.amount ? ` ×${input.amount}` : ""}`;
      } else if (item.tool === "computer_drag") {
        chip = `${input.fromX ?? "?"},${input.fromY ?? "?"} → ${input.toX ?? "?"},${input.toY ?? "?"}`;
      } else if (item.tool === "computer_window_activate") {
        chip = input.hwnd !== undefined ? `#${input.hwnd}` : undefined;
      } else if (item.tool === "computer_clipboard") {
        chip = typeof input.action === "string" ? input.action : undefined;
      } else if (item.tool === "computer_wait") {
        chip = input.ms !== undefined ? `${input.ms}ms` : undefined;
      } else if (item.tool === "computer_screenshot") {
        chip = input.display !== undefined ? `#${input.display}` : undefined;
      }
      return {
        label: t(labelKeys[item.tool]),
        ...(chip ? { chip, chipTitle: chip } : {}),
        note: failedNote,
      };
    }
    default: {
      // 动态工具（MCP / 插件）与未知工具：前缀规则给一个可读标签，原始名放 chip
      if (item.tool.startsWith("mcp__")) {
        return {
          label: t("tool.mcpTool"),
          chip: item.tool.slice("mcp__".length) || undefined,
          chipTitle: item.tool,
          note: failedNote,
        };
      }
      if (item.tool.startsWith("browser_")) {
        return {
          label: t("tool.browserAction"),
          chip: item.tool,
          chipTitle: item.tool,
          note: failedNote,
        };
      }
      if (item.tool.startsWith("computer_")) {
        return {
          label: t("tool.computerAction"),
          chip: item.tool,
          chipTitle: item.tool,
          note: failedNote,
        };
      }
      return {
        label: t("tool.call"),
        chip: item.tool || t("tool.unknownTool"),
        chipTitle: item.tool || undefined,
        note: failedNote,
      };
    }
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

export function ToolRow({
  item,
  onOpenFile,
}: {
  item: TimelineTool;
  /** 提供时：read_file 成功行点击 = 右侧面板打开文件，不再展开输入/输出 */
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useTranslation("chat");
  const status: ToolStatus =
    item.ok === undefined ? (item.replayed ? "ok" : "running") : item.ok ? "ok" : "failed";
  const view = presentTool(item, status, t);
  const [open, setOpen] = useState(false);
  const [bodyMounted, setBodyMounted] = useState(false);
  const detailId = useId();
  /** 写入中 / 修改中的行没有可看的内容（参数可能还没写完、输出也没有）：不展开 */
  const staticRow =
    status === "running" &&
    (item.tool === "write_file" || item.tool === "edit_file" || item.tool === "multi_edit");

  // 读取文件 → 右侧弹出：仅限成功态 + 工作区内相对路径（面板预览端点 /workspace/file
  // 只收工作区内相对路径，绝对/工作区外的回落为原展开行为）
  const rawPath = textArg(asRecord(item.input), "path");
  const openablePath =
    item.tool === "read_file" && onOpenFile && status === "ok" && rawPath && !isAbsolutePath(rawPath)
      ? rawPath.replace(/\\/g, "/")
      : "";

  const toggle = () => {
    // 首次展开才挂载详情：历史里大量工具行不必预先序列化 JSON
    if (!open) setBodyMounted(true);
    setOpen((value) => !value);
  };

  const headCore = (
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

  if (openablePath) {
    return (
      <div className="mc-toolrow" data-status={status} data-static="true">
        <button
          type="button"
          className="mc-toolrow__head"
          title={t("tool.openInPanel")}
          onClick={() => onOpenFile?.(openablePath)}
        >
          {headCore}
          <LuExternalLink size={14} className="mc-toolrow__chev" aria-hidden="true" />
        </button>
      </div>
    );
  }

  if (staticRow) {
    return (
      <div className="mc-toolrow" data-status={status} data-static="true">
        <div className="mc-toolrow__head" role="status">
          {headCore}
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
        {headCore}
        <LuChevronRight size={14} className="mc-toolrow__chev" data-open={open} aria-hidden="true" />
      </button>

      <div className="mc-toolrow__collapse" id={detailId} data-open={open}>
        <div className="mc-toolrow__collapse-inner">
          {bodyMounted ? (
            <div className="mc-toolrow__body">
              <CodeBlock label={t("tool.section.input")} text={formatInput(item.input)} language="json" />
              {item.output !== undefined ? (
                <CodeBlock
                  label={
                    item.spilled
                      ? t("tool.section.outputSpilled")
                      : item.truncated
                        ? t("tool.section.outputTruncated")
                        : t("tool.section.output")
                  }
                  text={item.output || t("tool.emptyOutput")}
                />
              ) : (
                <p className="mc-toolrow__hint">
                  {status === "running"
                    ? t("tool.waitingOutput")
                    : item.replayed
                      ? t("tool.outputNotSaved")
                      : t("tool.emptyOutput")}
                </p>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
