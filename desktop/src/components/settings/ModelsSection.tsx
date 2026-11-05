import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuPencil, LuPlus, LuTrash2 } from "react-icons/lu";
import { findTemplate } from "../../data/providerCatalog";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { ProviderIcon } from "../ui/ProviderIcon";
import { Section } from "../ui/Section";
import { Table, Td, Th } from "../ui/Table";
import { Toggle } from "../ui/Toggle";
import { ModelFormDialog } from "./ModelFormDialog";
import { providerLabel } from "./modelForm";
import { ProviderPickerDialog } from "./ProviderPickerDialog";
import type { ProviderSettings } from "../../api";
import "./ModelsSection.css";

export function ModelsSection({
  providers,
  activeProviderId,
  effort: _effort,
  turnRunning,
  onChange,
  onChangeEffort: _onChangeEffort,
}: {
  providers: ProviderSettings[];
  activeProviderId: string;
  effort: string;
  /** 任意会话有回合在跑：保存模型会重启 agent 服务并中断它，需要先确认 */
  turnRunning: boolean;
  onChange: (providers: ProviderSettings[], activeId?: string) => void;
  onChangeEffort: (providerId: string, value: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderSettings | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** 回合进行中被拦下的改动：确认后再真正提交 */
  const [pendingCommit, setPendingCommit] = useState<{
    next: ProviderSettings[];
    activeId?: string;
  } | null>(null);

  const commit = (next: ProviderSettings[], activeId?: string) => {
    if (turnRunning) {
      setPendingCommit({ next, ...(activeId ? { activeId } : {}) });
      return;
    }
    onChange(next, activeId);
  };

  /** 同一服务商 = 同名 + 同端点（引擎层仍是一条记录一个模型，界面上按组编辑）。 */
  const groupKeyOf = (item: ProviderSettings) =>
    `${item.templateId ?? "custom"}\u0000${item.name.trim().toLowerCase()}\u0000${item.baseUrl.trim().toLowerCase()}`;
  const editingGroup = editing
    ? providers.filter((item) => groupKeyOf(item) === groupKeyOf(editing))
    : [];
  const groupIds = new Set(editingGroup.map((item) => item.id));

  const handleSave = (entries: ProviderSettings[]) => {
    if (!editing) return;
    let next: ProviderSettings[];
    if (editingGroup.length) {
      const index = providers.findIndex((item) => item.id === editing.id);
      const rest = providers.filter((item) => !groupIds.has(item.id));
      const before = providers
        .slice(0, index)
        .filter((item) => !groupIds.has(item.id)).length;
      next = [...rest.slice(0, before), ...entries, ...rest.slice(before)];
    } else {
      next = [...providers, ...entries];
    }
    // 激活模型必须仍然启用：停用/删除后回退到第一个可用的
    const fallbackId = next.find((item) => item.enabled !== false)?.id ?? next[0]?.id;
    const activeId = next.some(
      (item) => item.id === activeProviderId && item.enabled !== false,
    )
      ? activeProviderId
      : fallbackId;
    commit(next, activeId);
    setEditing(null);
  };

  const handleDelete = (id: string) => {
    const next = providers.filter((item) => item.id !== id);
    const activeId =
      activeProviderId === id
        ? (next.find((item) => item.enabled !== false)?.id ?? next[0]?.id)
        : activeProviderId;
    commit(next, activeId);
    setPendingDelete(null);
  };

  const deleteTarget = pendingDelete ? providers.find((item) => item.id === pendingDelete) : null;

  return (
    <div className="mc-settings__inner">
      <Section title={t("models.section")} description={t("models.desc")}>
        <div className="mc-models">
          <div className="mc-models__toolbar">
            <span className="mc-models__count">
              <strong>{t("models.count", { count: providers.length })}</strong>
            </span>
            <Button variant="primary" size="sm" icon={<LuPlus size={14} />} onClick={() => setPickerOpen(true)}>
              {t("models.add")}
            </Button>
          </div>

          {providers.length === 0 ? (
            <p className="mc-models__empty">{t("models.empty")}</p>
          ) : (
            <Table className="mc-models__table">
              <thead>
                <tr>
                  <Th style={{ width: "42%" }}>{t("models.colModel")}</Th>
                  <Th style={{ width: "26%" }}>{t("models.colProvider")}</Th>
                  <Th style={{ width: "32%", textAlign: "right" }}>{t("models.colActions")}</Th>
                </tr>
              </thead>
              <tbody>
                {providers.map((provider) => {
                  const template = findTemplate(provider.templateId);
                  const isActive = provider.id === activeProviderId;
                  return (
                    <tr key={provider.id}>
                      <Td>
                        <span className="mc-models__name">
                          <span className="mc-truncate">{provider.displayName || provider.model}</span>
                          {isActive ? <Badge tone="running">{t("models.active")}</Badge> : null}
                        </span>
                      </Td>
                      <Td>
                        <span className="mc-models__provider">
                          <ProviderIcon template={template} size={18} />
                          <span className="mc-truncate">{provider.name}</span>
                        </span>
                      </Td>
                      <Td>
                        <span className="mc-table__actions">
                          <Toggle
                            checked={provider.enabled !== false}
                            label={t("models.enableAria", { name: provider.displayName || provider.model })}
                            onChange={(checked) =>
                              commit(providers.map((item) => (item.id === provider.id ? { ...item, enabled: checked } : item)))
                            }
                          />
                          <IconButton label={t("actions.edit")} size="sm" onClick={() => setEditing(provider)}>
                            <LuPencil size={14} />
                          </IconButton>
                          <IconButton
                            label={t("actions.delete")}
                            size="sm"
                            onClick={() => setPendingDelete(provider.id)}
                          >
                            <LuTrash2 size={14} />
                          </IconButton>
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </div>
      </Section>

      <Dialog open={deleteTarget !== null} onClose={() => setPendingDelete(null)}>
        <h2 className="mc-dialog__title">{t("models.deleteTitle")}</h2>
        <p className="mc-dialog__desc">
          {t("models.deleteMessage", { name: deleteTarget?.displayName || deleteTarget?.model || "" })}
        </p>
        <div className="mc-dialog__footer">
          <Button onClick={() => setPendingDelete(null)}>{t("actions.cancel")}</Button>
          <Button variant="danger" onClick={() => deleteTarget && handleDelete(deleteTarget.id)}>
            {t("actions.confirmDelete")}
          </Button>
        </div>
      </Dialog>

      <Dialog open={pendingCommit !== null} onClose={() => setPendingCommit(null)}>
        <h2 className="mc-dialog__title">{t("models.restartTitle")}</h2>
        <p className="mc-dialog__desc">{t("models.restartMessage")}</p>
        <div className="mc-dialog__footer">
          <Button onClick={() => setPendingCommit(null)}>{t("actions.cancel")}</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!pendingCommit) return;
              onChange(pendingCommit.next, pendingCommit.activeId);
              setPendingCommit(null);
            }}
          >
            {t("models.restartConfirm")}
          </Button>
        </div>
      </Dialog>

      {pickerOpen ? (
        <ProviderPickerDialog
          onClose={() => setPickerOpen(false)}
          onPick={(template) => {
            setPickerOpen(false);
            setEditing({
              id: `provider-${Date.now()}`,
              name: template.name,
              baseUrl: template.baseUrl,
              model: "",
              protocol: template.protocol,
              templateId: template.id,
              inputModalities: ["text"],
              enabled: true,
            });
          }}
        />
      ) : null}

      {editing ? (
        <ModelFormDialog
          draft={editing}
          entries={editingGroup}
          existingLabels={providers
            .filter((item) => !groupIds.has(item.id))
            .map(providerLabel)}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      ) : null}
    </div>
  );
}
