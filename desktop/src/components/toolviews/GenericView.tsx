import type { ReactNode } from "react";
import type { ToolViewProps } from "./types";
import { asRecord } from "./parse";
import { OutputText, ToolNote } from "./parts";

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function ParamValue({ value }: { value: unknown }): ReactNode {
  if (typeof value === "string") {
    if (!value) return <span className="mc-tv__paramvalue">""</span>;
    if (value.length <= 100 && !value.includes("\n")) {
      return <span className="mc-tv__paramvalue">{value}</span>;
    }
    return <pre className="mc-tv__paramcode">{value}</pre>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="mc-tv__paramvalue">{String(value)}</span>;
  }
  if (Array.isArray(value) && value.length && value.every(isScalar)) {
    const joined = value.join(", ");
    if (joined.length <= 160) {
      return <span className="mc-tv__paramvalue">{joined}</span>;
    }
  }
  if (value && typeof value === "object") {
    try {
      return <pre className="mc-tv__paramcode">{JSON.stringify(value, null, 2)}</pre>;
    } catch {
      return <span className="mc-tv__paramvalue">{String(value)}</span>;
    }
  }
  return <span className="mc-tv__paramvalue">{String(value)}</span>;
}

/** 动态工具（MCP/插件）与浏览器/电脑控制的兜底：可读参数 + 结果，不再摊整段 JSON */
export function GenericActionView({ item, status, t }: ToolViewProps) {
  const args = asRecord(item.input);
  const params = Object.entries(args).filter(([, value]) => {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
  const output = item.output ?? "";

  return (
    <div className="mc-tv">
      {params.length ? (
        <div className="mc-tv__params">
          <p className="mc-tv__difflabel">{t("tool.view.params")}</p>
          {params.map(([key, value]) => (
            <div className="mc-tv__param" key={key}>
              <span className="mc-tv__paramkey">{key}</span>
              <ParamValue value={value} />
            </div>
          ))}
        </div>
      ) : null}
      {output ? (
        <OutputText text={output} error={status === "failed"} />
      ) : status === "running" ? (
        <ToolNote>{t("tool.waitingOutput")}</ToolNote>
      ) : (
        <ToolNote>{t("tool.emptyOutput")}</ToolNote>
      )}
    </div>
  );
}
