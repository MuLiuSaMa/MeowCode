import type { CSSProperties } from "react";
import {
  LuCircle,
  LuCircleAlert,
  LuCircleCheck,
  LuCircleX,
  LuClock,
  LuHourglass,
  LuLoaderCircle,
} from "react-icons/lu";
import { stageKey, type Stage } from "../../../../src/agent/stage";
import "./StageBadge.css";

/**
 * 阶段图标：`Stage → 图标` 的唯一映射。
 *
 * 之前 TaskToolRow 与 SubagentsTab 各写了一遍同样的 running/failed/aborted 分支，
 * 加一个状态就得改两处。这里收成一处，两处 UI 都只渲染这个组件。
 */
export function StageBadge({
  stage,
  size = 16,
  style,
}: {
  stage: Stage;
  size?: number;
  style?: CSSProperties;
}) {
  const key = stageKey(stage);
  const icon = (() => {
    switch (stage.stage) {
      case "person":
        // 等人：审批 / 回答 / 确认，统一用表
        return <LuClock size={size} />;
      case "working":
        return <LuLoaderCircle size={size} className="mc-stage__spin" />;
      case "machine":
        return <LuHourglass size={size} />;
      case "idle":
        return <LuCircle size={size} />;
      case "ended":
        if (stage.outcome === "completed") return <LuCircleCheck size={size} />;
        if (stage.outcome === "failed") return <LuCircleX size={size} />;
        if (stage.outcome === "interrupted") return <LuCircleAlert size={size} />;
        return <LuCircleX size={size} />;
    }
  })();

  return (
    <span className="mc-stage" data-stage={key} style={style} aria-hidden="true">
      {icon}
    </span>
  );
}
