import { useState } from "react";
import { LuPencil, LuPlus, LuTrash2 } from "react-icons/lu";
import { findTemplate } from "../../data/providerCatalog";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { ProviderIcon } from "../ui/ProviderIcon";
import { FieldRow, Section } from "../ui/Section";
import { Table, Td, Th } from "../ui/Table";
import { Toggle } from "../ui/Toggle";
import { ModelFormDialog } from "./ModelFormDialog";
import { ProviderPickerDialog } from "./ProviderPickerDialog";
import type { ProviderSettings } from "../../api";
import "./ModelsSection.css";

export function ModelsSection({
  providers,
  activeProviderId,
  effort,
  onChange,
  onChangeEffort,
}: {
  providers: ProviderSettings[];
  activeProviderId: string;
  effort: string;
  onChange: (providers: ProviderSettings[], activeId?: string) => void;
  onChangeEffort: (providerId: string, value: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderSettings | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const commit = (next: ProviderSettings[], activeId?: string) => onChange(next, activeId);

  const handleSave = (draft: ProviderSettings) => {
    const exists = providers.some((item) => item.id === draft.id);
    const next = exists ? providers.map((item) => (item.id === draft.id ? draft : item)) : [...providers, draft];
    // 新增的第一条自动成为当前模型
    const activeId = providers.length === 0 && !activeProviderId ? draft.id : activeProviderId;
    commit(next, activeId);
    setEditing(null);
  };

  const handleDelete = (id: string) => {
    const next = providers.filter((item) => item.id !== id);
    const activeId = activeProviderId === id ? next[0]?.id : activeProviderId;
    commit(next, activeId);
    setPendingDelete(null);
  };

  return (
    <div className="mc-settings__inner">
      <Section title="模型" description="在这里添加模型服务商，并填写你要使用的模型名称。">
        <div className="mc-models">
          <div className="mc-models__toolbar">
            <span className="mc-models__count">
              已配置 <strong>{providers.length}</strong> 个模型
            </span>
            <Button variant="primary" size="sm" icon={<LuPlus size={14} />} onClick={() => setPickerOpen(true)}>
              添加模型
            </Button>
          </div>

          {providers.length === 0 ? (
            <p className="mc-models__empty">还没有配置任何模型。点击「添加模型」开始。</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th style={{ width: "42%" }}>模型</Th>
                  <Th style={{ width: "26%" }}>服务商</Th>
                  <Th style={{ width: "32%", textAlign: "right" }}>操作</Th>
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
                          {isActive ? <Badge tone="running">当前</Badge> : null}
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
                            label={`启用 ${provider.displayName || provider.model}`}
                            onChange={(checked) =>
                              commit(providers.map((item) => (item.id === provider.id ? { ...item, enabled: checked } : item)))
                            }
                          />
                          <IconButton label="编辑" size="sm" onClick={() => setEditing(provider)}>
                            <LuPencil size={14} />
                          </IconButton>
                          {pendingDelete === provider.id ? (
                            <>
                              <Button variant="danger" size="sm" onClick={() => handleDelete(provider.id)}>
                                确认删除
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>
                                取消
                              </Button>
                            </>
                          ) : (
                            <IconButton
                              label="删除"
                              size="sm"
                              onClick={() => setPendingDelete(provider.id)}
                            >
                              <LuTrash2 size={14} />
                            </IconButton>
                          )}
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
          existingIds={providers.filter((item) => item.id !== editing.id).map((item) => item.model)}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      ) : null}
    </div>
  );
}
