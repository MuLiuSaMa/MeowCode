import type { IconType } from "react-icons";
import { LuCpu, LuFeather, LuLayers } from "react-icons/lu";
import type { AgentProfileId, SubagentType } from "./api";

/**
 * 与 src/agent/agent-profiles.ts 同步的展示信息（同 agentRoles.ts 的做法）：
 * 服务端决定运行时行为（提示词 / 工具白名单 / 并发上限），这里只管中文名、图标与文案。
 */
export type AgentProfileDisplay = {
  id: AgentProfileId;
  /** 菜单/胶囊上的短名 */
  label: string;
  /** 一行说明（弹层副标题） */
  tagline: string;
  /** 详细说明（架构页） */
  description: string;
  /** 该档位包含的子 Agent 角色（顺序即展示顺序） */
  roles: SubagentType[];
  icon: IconType;
};

export const AGENT_PROFILE_ORDER: AgentProfileId[] = ["standard", "minimal", "complex"];

export const AGENT_PROFILES: Record<AgentProfileId, AgentProfileDisplay> = {
  standard: {
    id: "standard",
    label: "标准 Agent",
    tagline: "完整能力：全量工具 + 全部子 Agent",
    description: "默认主 Agent：全量工具，按需派发全部子 Agent 角色。",
    roles: ["general", "explore", "planner", "implementer", "reviewer", "verifier", "custom"],
    icon: LuCpu,
  },
  minimal: {
    id: "minimal",
    label: "极简 Agent",
    tagline: "只有 read_file + run_command，自己动手",
    description:
      "只保留 read_file 与 run_command（命令行读写文件），子 Agent 仅通用 / Explore，架构图里也没有门禁。",
    roles: ["general", "explore"],
    icon: LuFeather,
  },
  complex: {
    id: "complex",
    label: "复杂 Agent",
    tagline: "十道门禁：规划→范围→深挖→实现→评审→复验→终审→清扫→目标核对",
    description:
      "全量工具 + 13 个角色（含范围 / 深挖 / 独立复验 / 终审 / 收敛清扫 / 目标核对），架构图跑 G0→G1→G2→G3.5→G4→G5→G6→G7→sweep→goal-check。",
    roles: [
      "general",
      "explore",
      "planner",
      "scoper",
      "depth-prober",
      "implementer",
      "reviewer",
      "verifier",
      "fresh-verifier",
      "juror",
      "sweeper",
      "goal-checker",
      "custom",
    ],
    icon: LuLayers,
  },
};

export function agentProfileDisplay(id: AgentProfileId): AgentProfileDisplay {
  return AGENT_PROFILES[id] ?? AGENT_PROFILES.standard;
}
