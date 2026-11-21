import logoCat from "../../assets/logo-cat.webp";

/**
 * Agent 统一头像：主 Agent 档位与子 Agent 角色共用猫头 Logo，
 * 不再按档位/角色区分 CPU、羽毛、机器人等图标。
 */
export function AgentCat({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <img
      src={logoCat}
      alt=""
      draggable={false}
      className={className ? `mc-agentcat ${className}` : "mc-agentcat"}
      style={{ width: size, height: size, objectFit: "contain", flex: "none" }}
    />
  );
}
