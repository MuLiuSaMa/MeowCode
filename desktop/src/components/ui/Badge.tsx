import type { ReactNode } from "react";
import "./Badge.css";

export type BadgeTone = "neutral" | "success" | "danger" | "running";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`mc-badge mc-badge--${tone}`}>{children}</span>;
}
