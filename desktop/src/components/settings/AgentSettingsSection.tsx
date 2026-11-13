import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchAgentDefinitions,
  fetchHarness,
  saveHarness,
  type AgentDefinitionInfo,
  type AgentProfileInfo,
  type HarnessDocument,
} from "../../api";
import { Button } from "../ui/Button";
import { CustomSelect } from "../ui/CustomSelect";
import { Dialog } from "../ui/Dialog";
import { FieldRow, Section } from "../ui/Section";
import { TextField } from "../ui/TextField";
import "./AgentSettingsSection.css";

const PROFILE_IDS = ["standard", "minimal", "complex"] as const;
type ProfileId = (typeof PROFILE_IDS)[number];
const LIMIT_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10];
/** 架构图里主 Agent 节点的 id（内置种子固定为 main） */
const DEFAULT_MAIN_ID = "main";

type RoleNode = {
  id: string;
  name: string;
  role: string;
  systemPrompt?: string;
};

type AddDraft = {
  profile: ProfileId;
  name: string;
  role: string;
  prompt: string;
};

type EditDraft = {
  profile: ProfileId;
  nodeId: string;
  role: string;
  prompt: string;
};

function roleNodesOf(doc: HarnessDocument | null | undefined): RoleNode[] {
  if (!doc) return [];
  const nodes: RoleNode[] = [];
  for (const node of doc.nodes) {
    if (node.type !== "role") continue;
    const data = node.data as Record<string, unknown>;
    nodes.push({
      id: node.id,
      name: typeof data.name === "string" ? data.name : node.id,
      role: typeof data.role === "string" ? data.role : node.id,
      ...(typeof data.systemPrompt === "string" ? { systemPrompt: data.systemPrompt } : {}),
    });
  }
  return nodes;
}

/**
 * 设置 → 子 Agent（参考架构图的 role 节点）：
 * 每个主 Agent 档位列出自个子 Agent、可调并行上限、编辑提示词、手动添加；
 * 新增的子 Agent 会写进该档位的架构图（role 节点 + 主 Agent → 子 Agent 的边）。
 */
export function AgentSettingsSection({
  workspace,
  limits,
  onLimitsChange,
  onToast,
}: {
  workspace?: string;
  limits: Partial<Record<ProfileId, number>>;
  onLimitsChange: (limits: Partial<Record<ProfileId, number>>) => void;
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [definitions, setDefinitions] = useState<AgentDefinitionInfo[]>([]);
  const [profiles, setProfiles] = useState<AgentProfileInfo[]>([]);
  const [docs, setDocs] = useState<Partial<Record<ProfileId, HarnessDocument | null>>>({});
  const [loading, setLoading] = useState(true);
  const [add, setAdd] = useState<AddDraft | null>(null);
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [activeProfile, setActiveProfile] = useState<ProfileId>("standard");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchAgentDefinitions()
      .then((result) => {
        if (cancelled) return;
        setDefinitions(result.definitions);
        setProfiles(result.profiles ?? []);
      })
      .catch(() => undefined);
    void Promise.all(
      PROFILE_IDS.map(async (id) => {
        const doc = await fetchHarness(workspace, id).catch(() => null);
        return [id, doc] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) setDocs(Object.fromEntries(entries));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const definitionFor = (role: string): AgentDefinitionInfo | undefined =>
    definitions.find((item) => item.name === role);
  const defaultPrompt = (role: string): string => definitionFor(role)?.systemPrompt ?? "";

  const orderedProfiles = useMemo(() => {
    const byId = new Map(profiles.map((item) => [item.id, item]));
    return PROFILE_IDS.map((id) => byId.get(id)).filter(
      (item): item is AgentProfileInfo => Boolean(item),
    );
  }, [profiles]);

  const roleOptions = (profile: ProfileId) => {
    const info = profiles.find((item) => item.id === profile);
    const allowed = info?.roles ?? [];
    return definitions
      .filter((item) => allowed.includes(item.name))
      .map((item) => ({ value: item.name, label: item.name }));
  };

  const limitOptions = LIMIT_OPTIONS.map((value) => ({
    value: String(value),
    label: String(value),
  }));

  const openAdd = (profile: ProfileId) => {
    const role = roleOptions(profile)[0]?.value ?? "general";
    setAdd({ profile, name: "", role, prompt: defaultPrompt(role) });
  };

  const openEdit = (profile: ProfileId, node: RoleNode) => {
    setEdit({
      profile,
      nodeId: node.id,
      role: node.role,
      prompt: node.systemPrompt ?? defaultPrompt(node.role),
    });
  };

  const ensureDoc = async (profile: ProfileId): Promise<HarnessDocument> =>
    docs[profile] ?? (await fetchHarness(workspace, profile));

  const saveAdd = () => {
    if (!add || !add.name.trim()) return;
    const draft = add;
    void (async () => {
      try {
        const doc = await ensureDoc(draft.profile);
        const mainId = doc.nodes.find((node) => node.type === "agent")?.id ?? DEFAULT_MAIN_ID;
        const nodeId = `role-${draft.role}-${Date.now().toString(36)}`;
        const prompt = draft.prompt.trim();
        // 画布按 position 画连线：新建节点必须带上坐标，否则架构图里会成孤立卡片
        const positionedRoles = doc.nodes.filter(
          (node) => node.type === "role" && node.position,
        );
        const mainPosition = doc.nodes.find(
          (node) => node.type === "agent" && node.position,
        )?.position;
        const roleYs = positionedRoles.map((node) => node.position?.y ?? 0);
        const position = {
          x: positionedRoles[0]?.position?.x ?? (mainPosition ? mainPosition.x + 320 : 360),
          y: roleYs.length
            ? Math.max(...roleYs) + 140
            : mainPosition
              ? mainPosition.y - 220
              : 300,
        };
        const next: HarnessDocument = {
          ...doc,
          nodes: [
            ...doc.nodes,
            {
              id: nodeId,
              type: "role",
              position,
              data: {
                id: nodeId,
                name: draft.name.trim(),
                description: "",
                role: draft.role,
                ...(prompt && prompt !== defaultPrompt(draft.role)
                  ? { systemPrompt: prompt }
                  : {}),
              },
            },
          ],
          edges: [
            ...doc.edges,
            { id: `${mainId}-${nodeId}`, source: mainId, target: nodeId, type: "agent-role" },
          ],
        };
        await saveHarness(workspace, draft.profile, next);
        setDocs((prev) => ({ ...prev, [draft.profile]: next }));
        setAdd(null);
        onToast(t("agents.added"));
      } catch (error) {
        onToast(error instanceof Error ? error.message : String(error));
      }
    })();
  };

  const saveEdit = () => {
    if (!edit) return;
    const draft = edit;
    void (async () => {
      try {
        const doc = await ensureDoc(draft.profile);
        const value = draft.prompt.trim();
        const next: HarnessDocument = {
          ...doc,
          nodes: doc.nodes.map((node) =>
            node.id !== draft.nodeId
              ? node
              : ({
                  ...node,
                  data: {
                    ...(node.data as Record<string, unknown>),
                    systemPrompt: value || undefined,
                  },
                } as (typeof doc.nodes)[number]),
          ),
        };
        await saveHarness(workspace, draft.profile, next);
        setDocs((prev) => ({ ...prev, [draft.profile]: next }));
        setEdit(null);
        onToast(t("agents.saved"));
      } catch (error) {
        onToast(error instanceof Error ? error.message : String(error));
      }
    })();
  };

  const currentProfile =
    orderedProfiles.find((profile) => profile.id === activeProfile) ?? orderedProfiles[0] ?? null;
  const activeRoleNodes = currentProfile
    ? roleNodesOf(docs[currentProfile.id as ProfileId])
    : [];
  const activeLimit = currentProfile
    ? (limits[currentProfile.id as ProfileId] ?? currentProfile.maxSubagents)
    : 1;

  return (
    <div className="mc-settings__inner">
      <header className="mc-agents__head">
        <h2 className="mc-section__title">{t("agents.section")}</h2>
        <p className="mc-section__desc">{t("agents.desc")}</p>
      </header>

      <div className="mc-agents__tabs" role="tablist" aria-label={t("agents.section")}>
        {orderedProfiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            role="tab"
            aria-selected={activeProfile === profile.id}
            data-active={activeProfile === profile.id}
            className="mc-agents__tab"
            onClick={() => setActiveProfile(profile.id as ProfileId)}
          >
            {profile.name}
          </button>
        ))}
      </div>

      {currentProfile ? (
        <Section
          title={currentProfile.name}
          description={currentProfile.tagline}
          action={
            <div className="mc-agents__actions">
              <span className="mc-agents__actionlabel">{t("agents.limit.label")}</span>
              <CustomSelect
                value={String(activeLimit)}
                options={limitOptions}
                onChange={(value) =>
                  onLimitsChange({ ...limits, [currentProfile.id]: Number(value) })
                }
                ariaLabel={t("agents.limit.label")}
              />
              <Button
                size="sm"
                variant="primary"
                onClick={() => openAdd(currentProfile.id as ProfileId)}
              >
                {t("agents.add")}
              </Button>
            </div>
          }
        >
          {activeRoleNodes.length ? (
            activeRoleNodes.map((node) => (
              <FieldRow
                key={node.id}
                label={node.name}
                hint={`${node.role}${node.systemPrompt ? ` · ${t("agents.customPrompt")}` : ""}`}
              >
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openEdit(currentProfile.id as ProfileId, node)}
                >
                  {t("agents.editPrompt")}
                </Button>
              </FieldRow>
            ))
          ) : (
            <p className="mc-agents__empty">
              {loading ? t("agents.loading") : t("agents.empty")}
            </p>
          )}
        </Section>
      ) : null}

      <Dialog
        open={add !== null}
        onClose={() => setAdd(null)}
        labelledBy="mc-agent-add-title"
        className="mc-agents__dialog"
      >
        <span className="mc-dialog__title" id="mc-agent-add-title">
          {t("agents.addTitle")}
        </span>
        {add ? (
          <div className="mc-agents__form">
            <TextField
              label={t("agents.name")}
              value={add.name}
              placeholder={t("agents.namePlaceholder")}
              onChange={(event) => setAdd({ ...add, name: event.target.value })}
            />
            <label className="mc-field">
              <span className="mc-field__label">{t("agents.roleLabel")}</span>
              <CustomSelect
                value={add.role}
                options={roleOptions(add.profile)}
                onChange={(value) =>
                  setAdd({ ...add, role: value, prompt: defaultPrompt(value) })
                }
                ariaLabel={t("agents.roleLabel")}
              />
            </label>
            <label className="mc-field">
              <span className="mc-field__label">{t("agents.promptLabel")}</span>
              <textarea
                className="mc-agents__prompt"
                rows={10}
                value={add.prompt}
                onChange={(event) => setAdd({ ...add, prompt: event.target.value })}
              />
              <span className="mc-field__hint">{t("agents.promptHint")}</span>
            </label>
          </div>
        ) : null}
        <div className="mc-dialog__footer">
          <Button variant="ghost" onClick={() => setAdd(null)}>
            {t("actions.cancel")}
          </Button>
          <Button variant="primary" disabled={!add?.name.trim()} onClick={saveAdd}>
            {t("actions.save")}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={edit !== null}
        onClose={() => setEdit(null)}
        labelledBy="mc-agent-edit-title"
        className="mc-agents__dialog"
      >
        <span className="mc-dialog__title" id="mc-agent-edit-title">
          {t("agents.editTitle")}
        </span>
        {edit ? (
          <div className="mc-agents__form">
            <label className="mc-field">
              <span className="mc-field__label">{t("agents.promptLabel")}</span>
              <textarea
                className="mc-agents__prompt"
                rows={12}
                value={edit.prompt}
                onChange={(event) => setEdit({ ...edit, prompt: event.target.value })}
              />
              <span className="mc-field__hint">{t("agents.promptHint")}</span>
            </label>
          </div>
        ) : null}
        <div className="mc-dialog__footer">
          <Button variant="ghost" onClick={() => setEdit(null)}>
            {t("actions.cancel")}
          </Button>
          <Button variant="primary" onClick={saveEdit}>
            {t("actions.save")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
