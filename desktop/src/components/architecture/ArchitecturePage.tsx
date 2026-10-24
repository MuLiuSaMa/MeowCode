import { useEffect, useState } from "react";
import {
  LuBadgeCheck,
  LuEye,
  LuGavel,
  LuListTree,
  LuMicroscope,
  LuPlus,
  LuPuzzle,
  LuRecycle,
  LuRuler,
  LuSearch,
  LuShieldCheck,
  LuSparkles,
  LuTarget,
  LuTrash2,
  LuWrench,
} from "react-icons/lu";
import { HarnessEditor, type HarnessAgentEntry } from "./HarnessEditor";
import { AGENT_PROFILES, AGENT_PROFILE_ORDER } from "../../agentProfiles";
import {
  fetchHarness,
  type AgentProfileId,
  type HarnessArchitectureSummary,
  type SubagentType,
} from "../../api";
import "./ArchitecturePage.css";

export type { HarnessAgentEntry } from "./HarnessEditor";

/** 内置三档 id（其余都是自定义架构） */
function isBuiltinProfileId(id: string): id is AgentProfileId {
  return id === "standard" || id === "minimal" || id === "complex";
}

const ROLE_ICONS: Record<string, typeof LuSparkles> = {
  general: LuSparkles,
  explore: LuSearch,
  planner: LuListTree,
  scoper: LuRuler,
  "depth-prober": LuMicroscope,
  implementer: LuWrench,
  reviewer: LuEye,
  verifier: LuShieldCheck,
  "fresh-verifier": LuBadgeCheck,
  juror: LuGavel,
  sweeper: LuRecycle,
  "goal-checker": LuTarget,
  custom: LuPuzzle,
};

const READ_ONLY_ROLES = new Set([
  "explore",
  "planner",
  "scoper",
  "depth-prober",
  "reviewer",
  "juror",
  "sweeper",
  "goal-checker",
]);
const ROLE_ORDER = [
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
];

/**
 * Agent 架构页导航 —— 放在 AppShell 的 conversations 槽位（同设置页模式）。
 * 左栏上半 = 主 Agent 列表（内置三档 + 用户自建的自定义架构），右上角「+」新建一张
 * 自定义架构（标准 Agent 的完整副本，可改名/删除）；
 * 左栏下半 = 当前架构图包含的子 Agent 角色；点角色在右侧打开对应节点的设置面板。
 */
export function ArchitectureNav({
  agents,
  architectures,
  selectedId,
  onSelect,
  activeProfile,
  profile,
  onSelectProfile,
  onAddArchitecture,
  onRenameArchitecture,
  onDeleteArchitecture,
  workspace,
}: {
  agents: HarnessAgentEntry[];
  /** 内置三档 + 工作区里的自定义架构（GET /harness/list） */
  architectures: HarnessArchitectureSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 工作区目录：用于读取各架构图的角色数 */
  workspace?: string;
  /** 会话当前生效的档位（显示「当前」徽章） */
  activeProfile: AgentProfileId;
  /** 当前查看的架构 id：内置档位或自定义架构（custom-*） */
  profile: string;
  onSelectProfile: (id: string) => void;
  /** 「主 Agent」右上角 + ：新建一张自定义架构（标准 Agent 副本） */
  onAddArchitecture?: () => void;
  /** 自定义架构改名 */
  onRenameArchitecture?: (id: string, name: string) => void;
  /** 删除自定义架构 */
  onDeleteArchitecture?: (id: string) => void;
}) {
  // 自定义架构是标准 Agent 的副本：角色白名单/门禁语义都按 standard 判定
  const builtinProfile: AgentProfileId = isBuiltinProfileId(profile) ? profile : "standard";
  const profileInfo = AGENT_PROFILES[builtinProfile];
  // 列表接口还没就绪（旧服务端 / 拉取失败）时回退内置三档，保证左栏永远不空
  const items: HarnessArchitectureSummary[] = architectures.length
    ? architectures
    : AGENT_PROFILE_ORDER.map((id) => ({ id, name: null, builtin: true }));
  const currentArchName =
    items.find((item) => item.id === profile)?.name ?? profileInfo.label;
  // 每个架构有自己的图：列表 = 该图里的角色节点。
  // 若图里出现了本档位派不出的角色（运行时会拒绝），标出来而不是藏起来。
  const roleAgents = agents
    .filter((entry) => entry.kind === "role")
    .sort(
      (a, b) =>
        (ROLE_ORDER.indexOf(a.roleType) + 1 || ROLE_ORDER.length + 1) -
          (ROLE_ORDER.indexOf(b.roleType) + 1 || ROLE_ORDER.length + 1) ||
        a.ordinal - b.ordinal,
    );
  /** 各架构图里的角色数（菜单上显示「该图有几个子 Agent」） */
  const [roleCounts, setRoleCounts] = useState<Record<string, number>>({});
  const archSignature = items.map((item) => item.id).join("|");
  useEffect(() => {
    if (!workspace || !archSignature) return;
    let alive = true;
    void Promise.all(
      archSignature.split("|").map(async (id) => {
        try {
          const doc = await fetchHarness(workspace, id);
          return [id, doc.nodes.filter((node) => node.type === "role").length] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (!alive) return;
      setRoleCounts(Object.fromEntries(entries.filter((entry) => entry !== null)) as Record<string, number>);
    });
    return () => {
      alive = false;
    };
  }, [workspace, archSignature]);
  // 当前选中的图已经在画布上：直接用它算，编辑增删角色即时反映
  const countFor = (id: string): number | null =>
    id === profile && agents.length > 0 ? roleAgents.length : (roleCounts[id] ?? null);
  /** 该架构图里的根节点（每张图各有一个 agent 节点，id 通常是 main） */
  const harnessAgentId = (id: string): string | null => {
    const match = agents.find(
      (entry) => entry.kind === "agent" && (entry.id === id || entry.id === "main"),
    );
    return match?.id ?? null;
  };
  /** 自定义架构改名：双击名称进入输入态 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const commitRename = () => {
    if (!editingId) return;
    const next = draftName.trim();
    if (next) onRenameArchitecture?.(editingId, next);
    setEditingId(null);
  };

  return (
    <nav className="mc-panel mc-panel--conversations mc-arch__nav" aria-label="Agent 列表">
      <div className="mc-arch__head">
        <h1 className="mc-arch__heading">Agent 架构</h1>
      </div>
      <div className="mc-arch__grouprow">
        <p className="mc-arch__grouplabel">主 Agent</p>
        {onAddArchitecture ? (
          <button
            type="button"
            className="mc-arch__groupadd"
            title="新建自定义 Agent 架构"
            aria-label="新建自定义 Agent 架构"
            onClick={onAddArchitecture}
          >
            <LuPlus size={12} />
          </button>
        ) : null}
      </div>
      <ul className="mc-arch__roles">
        {items.map((item) => {
          const builtin = item.builtin && isBuiltinProfileId(item.id);
          const info = builtin ? AGENT_PROFILES[item.id as AgentProfileId] : null;
          const Icon = info?.icon ?? LuPuzzle;
          const label = info?.label ?? item.name ?? item.id;
          const tagline = info?.tagline ?? "自定义架构";
          const isActive = builtin && activeProfile === item.id;
          const count = countFor(item.id);
          const editing = editingId === item.id;
          return (
            <li key={item.id} className="mc-arch__roleli">
              <button
                type="button"
                className="mc-arch__roleitem"
                data-active={profile === item.id}
                aria-pressed={profile === item.id}
                title={builtin ? tagline : "双击名称可改名"}
                onClick={() => {
                  onSelectProfile(item.id);
                  const nodeId = harnessAgentId(item.id);
                  if (nodeId) onSelect(nodeId);
                }}
              >
                <span className="mc-arch__roleicon">
                  <Icon size={14} />
                </span>
                <span className="mc-arch__roletext">
                  {editing ? (
                    <input
                      className="mc-arch__renameinput"
                      autoFocus
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      onBlur={commitRename}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitRename();
                        if (event.key === "Escape") setEditingId(null);
                      }}
                    />
                  ) : (
                    <span
                      className="mc-arch__rolelabel"
                      onDoubleClick={(event) => {
                        if (builtin) return;
                        event.stopPropagation();
                        setEditingId(item.id);
                        setDraftName(item.name ?? item.id);
                      }}
                    >
                      {label}
                    </span>
                  )}
                  <span className="mc-arch__roleid">
                    {count === null ? tagline : `子 Agent ${count} 个 · ${tagline}`}
                  </span>
                </span>
                <span className="mc-arch__rolebadges">
                  {isActive ? <span className="mc-arch__badge">当前</span> : null}
                </span>
              </button>
              {builtin || !onDeleteArchitecture ? null : (
                <button
                  type="button"
                  className="mc-arch__roledelete"
                  title={`删除「${label}」`}
                  aria-label={`删除「${label}」`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteArchitecture(item.id);
                  }}
                >
                  <LuTrash2 size={12} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mc-arch__grouplabel">子 Agent · {currentArchName}</p>
      {roleAgents.length ? (
        <ul className="mc-arch__roles">
          {roleAgents.map((entry) => {
            const Icon = ROLE_ICONS[entry.roleType] ?? LuSparkles;
            const numbered = entry.count > 1;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  className="mc-arch__roleitem"
                  data-active={selectedId === entry.id}
                  aria-pressed={selectedId === entry.id}
                  onClick={() => onSelect(entry.id)}
                >
                  <span className="mc-arch__roleicon">
                    <Icon size={14} />
                  </span>
                  <span className="mc-arch__roletext">
                    <span className="mc-arch__rolelabel">
                      {entry.label}
                      {numbered ? ` ${entry.ordinal}` : ""}
                    </span>
                    <span className="mc-arch__roleid">
                      {entry.roleType}
                      {numbered ? ` · ${entry.ordinal}` : ""}
                    </span>
                  </span>
                  <span className="mc-arch__rolebadges">
                    {profileInfo.roles.includes(entry.roleType as SubagentType) ? null : (
                      <span className="mc-arch__badge" data-tone="muted">
                        档位禁用
                      </span>
                    )}
                    {READ_ONLY_ROLES.has(entry.roleType) ? (
                      <span className="mc-arch__badge">只读</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mc-arch__navempty">
          {agents.length === 0 ? "正在加载 Agent…" : "该 Agent 未包含子 Agent"}
        </p>
      )}
    </nav>
  );
}

/** Agent 架构页正文 —— 架构图铺满主内容面板。 */
export function ArchitectureBody({
  selectedAgentId,
  onAgentSelect,
  onAgentsChange,
  workspace,
  profile,
  architectureName,
  onArchitectureRename,
}: {
  selectedAgentId: string | null;
  onAgentSelect: (id: string | null) => void;
  onAgentsChange: (entries: HarnessAgentEntry[]) => void;
  /** 工作区目录（架构图读写目标） */
  workspace?: string;
  /** 当前查看的架构 id：内置档位或自定义架构（custom-*） */
  profile: string;
  /** 左栏列表里的架构名（自定义架构的权威名字） */
  architectureName?: string;
  /** 画布改了主 Agent 名字 → 回传左栏列表 */
  onArchitectureRename?: (name: string) => void;
}) {
  return (
    <div className="mc-arch__body">
      <HarnessEditor
        workspace={workspace}
        profile={profile}
        selectedAgent={selectedAgentId}
        onRoleSelect={onAgentSelect}
        onAgentsChange={onAgentsChange}
        architectureName={architectureName}
        onArchitectureRename={onArchitectureRename}
      />
    </div>
  );
}
