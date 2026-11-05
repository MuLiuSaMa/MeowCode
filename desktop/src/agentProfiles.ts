import i18n from "i18next";
import type { IconType } from "react-icons";
import { LuCpu, LuFeather, LuLayers } from "react-icons/lu";
import type { AgentProfileId, SubagentType } from "./api";

/**
 * 与 src/agent/agent-profiles.ts 同步的展示信息（同 agentRoles.ts 的做法）：
 * 服务端决定运行时行为（提示词 / 工具白名单 / 并发上限），这里只管名称、图标与文案。
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

/** 展示文案只存 key（chat 命名空间）：取值时再查译文，切语言才会跟着刷新。 */
export const AGENT_PROFILE_KEYS: Record<AgentProfileId, { label: string; tagline: string; description: string }> = {
  standard: {
    label: "profile.standard.label",
    tagline: "profile.standard.tagline",
    description: "profile.standard.description",
  },
  minimal: {
    label: "profile.minimal.label",
    tagline: "profile.minimal.tagline",
    description: "profile.minimal.description",
  },
  complex: {
    label: "profile.complex.label",
    tagline: "profile.complex.tagline",
    description: "profile.complex.description",
  },
};

export const AGENT_PROFILE_ORDER: AgentProfileId[] = ["standard", "minimal", "complex"];

/** 档位的非文案部分：角色清单与图标是运行时事实，不进词条。 */
const PROFILE_META: Record<AgentProfileId, { roles: SubagentType[]; icon: IconType }> = {
  standard: {
    roles: ["general", "explore", "planner", "implementer", "reviewer", "verifier", "custom"],
    icon: LuCpu,
  },
  minimal: {
    roles: ["general", "explore"],
    icon: LuFeather,
  },
  complex: {
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

/**
 * 本次批次之外的消费点（Composer / ArchitecturePage / AgentProfilePopover 由并行批次负责）
 * 仍按 `profile.label` 读取，因此 label / tagline / description 做成惰性 getter：
 * 模块加载期不调用 t()，读取时才解析 key。
 */
function defineProfile(id: AgentProfileId): AgentProfileDisplay {
  const profile = { id, ...PROFILE_META[id] } as AgentProfileDisplay;
  const keys = AGENT_PROFILE_KEYS[id];
  for (const field of ["label", "tagline", "description"] as const) {
    Object.defineProperty(profile, field, {
      enumerable: true,
      get: () => i18n.t(`chat:${keys[field]}`),
    });
  }
  return profile;
}

export const AGENT_PROFILES: Record<AgentProfileId, AgentProfileDisplay> = {
  standard: defineProfile("standard"),
  minimal: defineProfile("minimal"),
  complex: defineProfile("complex"),
};

export function agentProfileDisplay(id: AgentProfileId): AgentProfileDisplay {
  return AGENT_PROFILES[id] ?? AGENT_PROFILES.standard;
}
