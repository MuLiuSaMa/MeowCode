import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuListChecks, LuPlus, LuRotateCw, LuTrash2 } from "react-icons/lu";
import {
  deleteRule,
  listRules,
  readRule,
  writeRule,
  type RuleSummary,
} from "../../api";
import { formatDate } from "../../i18n/format";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Spinner } from "../ui/Spinner";
import { TextField } from "../ui/TextField";
import { FieldRow, Section } from "../ui/Section";
import { Toggle } from "../ui/Toggle";
import "./RulesSection.css";

/** 与服务端 rules.ts 同规约：小写 kebab-case，1-64 字符 */
const RULE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

type Editor = {
  name: string;
  nameLocked: boolean;
  content: string;
};

function ruleDate(rule: RuleSummary): string {
  if (!rule.mtime) return "";
  const date = new Date(rule.mtime);
  return Number.isNaN(date.getTime()) ? "" : formatDate(date);
}

export function RulesSection({
  workspace,
  includeAgentsMd,
  onIncludeAgentsMdChange,
  includeClaudeMd,
  onIncludeClaudeMdChange,
  onToast,
}: {
  workspace: string | null;
  includeAgentsMd: boolean;
  onIncludeAgentsMdChange: (value: boolean) => void;
  includeClaudeMd: boolean;
  onIncludeClaudeMdChange: (value: boolean) => void;
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!workspace) {
      setRules([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setRules(await listRules(workspace));
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("rules.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [workspace, onToast, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const openCreate = () => {
    setNameError(null);
    setEditor({ name: "", nameLocked: false, content: "" });
  };

  const openEdit = async (name: string) => {
    if (!workspace) return;
    setNameError(null);
    try {
      const record = await readRule(workspace, name);
      setEditor({ name: record.name, nameLocked: true, content: record.content });
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("rules.readFailed"));
    }
  };

  const save = async () => {
    if (!editor || !workspace) return;
    const name = editor.name.trim();
    if (!RULE_NAME_PATTERN.test(name)) {
      setNameError(t("rules.nameRule"));
      return;
    }
    setSaving(true);
    try {
      await writeRule(workspace, name, editor.content);
      setEditor(null);
      onToast(t("rules.saved", { name }));
      await refresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("rules.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string) => {
    if (!workspace) return;
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirming !== name) {
      setConfirming(name);
      confirmTimer.current = setTimeout(() => setConfirming(null), 4000);
      return;
    }
    setConfirming(null);
    try {
      await deleteRule(workspace, name);
      onToast(t("rules.deleted", { name }));
      await refresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("rules.deleteFailed"));
    }
  };

  return (
    <div className="mc-settings__inner">
      <Section title={t("rules.importSection")}>
        <FieldRow label={t("rules.agents.label")} hint={t("rules.agents.hint")}>
          <Toggle
            checked={includeAgentsMd}
            onChange={onIncludeAgentsMdChange}
            label={t("rules.agents.label")}
          />
        </FieldRow>
        <FieldRow label={t("rules.claude.label")} hint={t("rules.claude.hint")}>
          <Toggle
            checked={includeClaudeMd}
            onChange={onIncludeClaudeMdChange}
            label={t("rules.claude.label")}
          />
        </FieldRow>
      </Section>

      <section className="mc-section">
        <header className="mc-section__head mc-rules__head">
          <h2 className="mc-section__title">{t("rules.title")}</h2>
          <button
            type="button"
            className="mc-rules__refresh"
            aria-label={t("rules.refresh")}
            title={t("rules.refresh")}
            onClick={() => void refresh()}
          >
            <LuRotateCw size={14} />
          </button>
        </header>
        <div className="mc-section__body">
          <div className="mc-rules__toolbar">
            <div className="mc-rules__intro">
              <span className="mc-rules__label">{t("rules.title")}</span>
              <span className="mc-rules__hint">{t("rules.hint")}</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              icon={<LuPlus size={14} />}
              disabled={!workspace}
              onClick={openCreate}
            >
              {t("rules.create")}
            </Button>
          </div>
          {loading ? (
            <div className="mc-rules__loading">
              <Spinner size={16} />
            </div>
          ) : rules.length === 0 ? (
            <div className="mc-rules__empty">
              <LuListChecks size={22} />
              <p>{workspace ? t("rules.empty") : t("rules.noWorkspace")}</p>
              <span>{workspace ? t("rules.emptyHint") : t("rules.noWorkspaceHint")}</span>
            </div>
          ) : (
            <ul className="mc-rules__list">
              {rules.map((rule) => {
                const isConfirming = confirming === rule.name;
                return (
                  <li key={rule.name} className="mc-rules__row">
                    <button
                      type="button"
                      className="mc-rules__item"
                      title={t("rules.clickToEdit")}
                      onClick={() => void openEdit(rule.name)}
                    >
                      <span className="mc-rules__name">{rule.title}</span>
                      <span className="mc-rules__desc">{rule.name}</span>
                      <span className="mc-rules__date">{ruleDate(rule)}</span>
                    </button>
                    <Button
                      size="sm"
                      variant={isConfirming ? "danger" : "ghost"}
                      className="mc-rules__delete"
                      aria-label={
                        isConfirming
                          ? t("rules.confirmDeleteAria", { name: rule.name })
                          : t("rules.deleteAria", { name: rule.name })
                      }
                      onClick={() => void remove(rule.name)}
                    >
                      {isConfirming ? t("actions.confirmDelete") : <LuTrash2 size={14} />}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <Dialog
        open={editor !== null}
        onClose={() => setEditor(null)}
        labelledBy="mc-rule-editor-title"
        className="mc-dialog--wide"
      >
        {editor ? (
          <>
            <span className="mc-dialog__title" id="mc-rule-editor-title">
              {editor.nameLocked
                ? t("rules.editTitle", { name: editor.name })
                : t("rules.createTitle")}
            </span>
            <p className="mc-dialog__desc">{t("rules.editorDesc")}</p>
            <div className="mc-dialog__body mc-rules__editor">
              {editor.nameLocked ? null : (
                <TextField
                  label={t("rules.name")}
                  placeholder={t("rules.namePlaceholder")}
                  value={editor.name}
                  onChange={(event) => {
                    setEditor({ ...editor, name: event.target.value });
                    setNameError(null);
                  }}
                  hint={nameError ?? t("rules.nameHint")}
                />
              )}
              <textarea
                className="mc-rules__textarea"
                value={editor.content}
                spellCheck={false}
                aria-label={t("rules.content")}
                placeholder={t("rules.contentPlaceholder")}
                onChange={(event) => setEditor({ ...editor, content: event.target.value })}
              />
              {nameError ? <p className="mc-rules__error">{nameError}</p> : null}
            </div>
            <div className="mc-dialog__footer">
              <Button onClick={() => setEditor(null)}>{t("actions.cancel")}</Button>
              <Button variant="primary" disabled={saving} onClick={() => void save()}>
                {saving ? t("actions.saving") : t("actions.save")}
              </Button>
            </div>
          </>
        ) : null}
      </Dialog>
    </div>
  );
}
