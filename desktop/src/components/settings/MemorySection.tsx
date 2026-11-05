import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuBrain, LuPlus, LuTrash2 } from "react-icons/lu";
import {
  clearAllMemories,
  deleteMemoryFile,
  getMemoryEnabled,
  listMemories,
  readMemoryFile,
  setMemoryEnabled,
  writeMemoryFile,
  type MemoryListItem,
  type MemoryScopeId,
} from "../../api";
import { formatDate } from "../../i18n/format";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Spinner } from "../ui/Spinner";
import { TextField } from "../ui/TextField";
import { FieldRow, Section } from "../ui/Section";
import { Toggle } from "../ui/Toggle";
import "./MemorySection.css";

/** 与服务端 memory.ts 同规约：小写 kebab-case，1-64 字符，memory 是保留名 */
const MEMORY_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

type Editor = {
  scope: MemoryScopeId;
  /** 新建时可编辑；编辑已有条目时锁定（文件名即条目身份） */
  name: string;
  nameLocked: boolean;
  content: string;
};

function frontmatterTemplate(): string {
  return `---\ndescription: \ntype: \ncreated: ${new Date().toISOString().slice(0, 10)}\n---\n`;
}

function memoryDate(item: MemoryListItem): string {
  if (item.created) return item.created;
  if (item.mtime) {
    const date = new Date(item.mtime);
    if (!Number.isNaN(date.getTime())) return formatDate(date);
  }
  return "";
}

/**
 * 记忆分区：管理跨会话长期记忆（user = ~/.meowcode/memory，project = 工作区
 * .meowcode/memory）。记忆由对话中的 AI 自动写入（memory_* 工具），这里手动
 * 查看/编辑/新建/删除；编辑的是 Markdown 原文，frontmatter 的 description
 * 会进 MEMORY.md 索引并由服务端保持同步。
 */
export function MemorySection({
  workspace,
  onToast,
}: {
  /** 当前工作区（会话 cwd 或设置里的工作区）；项目记忆跟随它 */
  workspace: string | null;
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [userItems, setUserItems] = useState<MemoryListItem[]>([]);
  const [projectItems, setProjectItems] = useState<MemoryListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ scope: MemoryScopeId; name: string } | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 全部删除：每个 scope 独立二次确认，4 秒后自动复位 */
  const [confirmingClear, setConfirmingClear] = useState<MemoryScopeId | null>(null);
  const [clearingScope, setClearingScope] = useState<MemoryScopeId | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 记忆总开关：null = 还没从服务端拿到当前值 */
  const [memoryOn, setMemoryOn] = useState<boolean | null>(null);

  const scopeLabel = useCallback((scope: MemoryScopeId) => t(`memory.scope.${scope}`), [t]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listMemories(workspace ?? undefined);
      setUserItems(result.user);
      setProjectItems(result.project);
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("memory.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [workspace, onToast, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    getMemoryEnabled()
      .then((result) => {
        if (!cancelled) setMemoryOn(result.enabled);
      })
      .catch(() => {
        // 查询失败按默认值（开）展示，避免开关卡在加载态
        if (!cancelled) setMemoryOn(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleMemory = async (value: boolean) => {
    const previous = memoryOn;
    setMemoryOn(value); // 乐观更新：失败回滚
    try {
      await setMemoryEnabled(value); // 运行中的 server 立即生效（蒸馏 / 注入 / 工具三处同时切换）
      // 落盘供下次启动传 env；走 saveProviderPrefs，绝不重启 agent server
      await window.meow.saveProviderPrefs({ memoryEnabled: value });
    } catch (error) {
      setMemoryOn(previous ?? true);
      onToast(error instanceof Error ? error.message : t("memory.toggleFailed"));
    }
  };

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    [],
  );

  const openCreate = (scope: MemoryScopeId) => {
    setNameError(null);
    setEditor({ scope, name: "", nameLocked: false, content: frontmatterTemplate() });
  };

  const openEdit = async (scope: MemoryScopeId, item: MemoryListItem) => {
    setNameError(null);
    setEditor({ scope, name: item.name, nameLocked: true, content: "" });
    try {
      const record = await readMemoryFile(scope, item.name, workspace ?? undefined);
      setEditor({ scope, name: item.name, nameLocked: true, content: record.content });
    } catch (error) {
      setEditor(null);
      onToast(error instanceof Error ? error.message : t("memory.readFailed"));
    }
  };

  const save = async () => {
    if (!editor) return;
    const name = editor.name.trim();
    if (!MEMORY_NAME_PATTERN.test(name) || name === "memory") {
      setNameError(t("memory.nameRule"));
      return;
    }
    setSaving(true);
    try {
      await writeMemoryFile(editor.scope, name, editor.content, workspace ?? undefined);
      setEditor(null);
      onToast(t("memory.saved", { scope: scopeLabel(editor.scope), name }));
      await refresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("memory.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (scope: MemoryScopeId, name: string) => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    setConfirmingClear(null);
    if (!confirming || confirming.scope !== scope || confirming.name !== name) {
      setConfirming({ scope, name });
      confirmTimer.current = setTimeout(() => setConfirming(null), 4000);
      return;
    }
    setConfirming(null);
    try {
      await deleteMemoryFile(scope, name, workspace ?? undefined);
      onToast(t("memory.deleted", { scope: scopeLabel(scope), name }));
      await refresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("memory.deleteFailed"));
    }
  };

  const clearAll = async (scope: MemoryScopeId) => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
    if (confirmingClear !== scope) {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      setConfirming(null);
      setConfirmingClear(scope);
      clearTimer.current = setTimeout(() => setConfirmingClear(null), 4000);
      return;
    }
    setConfirmingClear(null);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirming(null);
    setClearingScope(scope);
    try {
      await clearAllMemories(scope, workspace ?? undefined);
      onToast(t("memory.clearDone"));
      await refresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("memory.clearFailed"));
    } finally {
      setClearingScope(null);
    }
  };

  const renderGroup = (scope: MemoryScopeId, items: MemoryListItem[], description: string) => (
    <Section
      title={scopeLabel(scope)}
      description={description}
      action={
        items.length ? (
          <Button
            size="sm"
            variant={confirmingClear === scope ? "danger" : "outline"}
            icon={<LuTrash2 size={13} />}
            disabled={clearingScope === scope}
            onClick={() => void clearAll(scope)}
          >
            {confirmingClear === scope ? t("memory.clearConfirm") : t("memory.clearAction")}
          </Button>
        ) : undefined
      }
    >
      <div className="mc-memory">
        <div className="mc-memory__toolbar">
          <span className="mc-memory__count">
            {loading ? null : <strong>{t("memory.count", { count: items.length })}</strong>}
          </span>
          <Button size="sm" variant="outline" icon={<LuPlus size={14} />} onClick={() => openCreate(scope)}>
            {t("memory.create")}
          </Button>
        </div>
        {loading ? (
          <div className="mc-memory__loading">
            <Spinner size={16} />
          </div>
        ) : items.length === 0 ? (
          <p className="mc-memory__empty">
            <LuBrain size={15} />
            {t("memory.empty")}
          </p>
        ) : (
          <ul className="mc-memory__list">
            {items.map((item) => {
              const isConfirming =
                confirming?.scope === scope && confirming.name === item.name;
              return (
                <li key={item.name} className="mc-memory__row">
                  <button
                    type="button"
                    className="mc-memory__item"
                    onClick={() => void openEdit(scope, item)}
                    title={t("memory.clickToEdit")}
                  >
                    <span className="mc-memory__name">{item.name}</span>
                    <span className="mc-memory__desc">{item.description || t("memory.noDescription")}</span>
                    <span className="mc-memory__date">{memoryDate(item)}</span>
                  </button>
                  <Button
                    size="sm"
                    variant={isConfirming ? "danger" : "ghost"}
                    className="mc-memory__delete"
                    aria-label={
                      isConfirming
                        ? t("memory.confirmDeleteAria", { name: item.name })
                        : t("memory.deleteAria", { name: item.name })
                    }
                    onClick={() => void remove(scope, item.name)}
                  >
                    {isConfirming ? t("actions.confirmDelete") : <LuTrash2 size={14} />}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );

  /** 工作区目录名：只是补充信息，没有工作区时换一条不带插值的描述 */
  const workspaceName = workspace ? workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || workspace : null;

  return (
    <div className="mc-settings__inner">
      <Section title={t("memory.toggleTitle")} description={t("memory.toggleDesc")}>
        <FieldRow label={t("memory.toggleField")}>
          {memoryOn === null ? (
            <Spinner size={16} />
          ) : (
            <Toggle
              checked={memoryOn}
              onChange={(value) => void toggleMemory(value)}
              label={t("memory.toggleField")}
            />
          )}
        </FieldRow>
      </Section>
      {renderGroup("user", userItems, t("memory.descUser"))}
      {renderGroup(
        "project",
        projectItems,
        workspaceName
          ? t("memory.descProjectNamed", { workspace: workspaceName })
          : t("memory.descProject"),
      )}

      <Dialog
        open={editor !== null}
        onClose={() => setEditor(null)}
        labelledBy="mc-memory-editor-title"
        className="mc-dialog--wide"
      >
        {editor ? (
          <>
            <span className="mc-dialog__title" id="mc-memory-editor-title">
              {editor.nameLocked
                ? t("memory.editTitle", { scope: scopeLabel(editor.scope), name: editor.name })
                : t("memory.createTitle", { scope: scopeLabel(editor.scope) })}
            </span>
            <p className="mc-dialog__desc">{t("memory.editorDesc")}</p>
            <div className="mc-dialog__body mc-memory__editor">
              {editor.nameLocked ? null : (
                <TextField
                  label={t("memory.name")}
                  placeholder={t("memory.namePlaceholder")}
                  value={editor.name}
                  onChange={(event) => {
                    setEditor({ ...editor, name: event.target.value });
                    setNameError(null);
                  }}
                  hint={nameError ?? t("memory.nameHint")}
                />
              )}
              <textarea
                className="mc-memory__textarea"
                value={editor.content}
                spellCheck={false}
                onChange={(event) => setEditor({ ...editor, content: event.target.value })}
              />
              {nameError ? <p className="mc-memory__error">{nameError}</p> : null}
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
