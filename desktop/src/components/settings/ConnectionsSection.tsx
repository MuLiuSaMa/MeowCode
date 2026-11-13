import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuFolderOpen, LuServer } from "react-icons/lu";
import type { SshAuthType, SshConnection } from "../../api";
import { Button } from "../ui/Button";
import { CustomSelect } from "../ui/CustomSelect";
import { Dialog } from "../ui/Dialog";
import { FieldRow, Section } from "../ui/Section";
import { IconButton } from "../ui/IconButton";
import { TextField } from "../ui/TextField";
import "./ConnectionsSection.css";

type Draft = {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  authType: SshAuthType;
  privateKeyPath: string;
};

const EMPTY_DRAFT: Draft = {
  id: "",
  name: "",
  host: "",
  port: "22",
  username: "",
  authType: "agent",
  privateKeyPath: "",
};

/**
 * 设置 → 连接：SSH 连接列表。
 * 只保存主机/端口/用户名/认证方式；密码不落盘，连接时在终端里由 ssh 自己提示输入。
 */
export function ConnectionsSection({
  connections,
  onChange,
  onConnect,
  onToast,
}: {
  connections: SshConnection[];
  onChange: (list: SshConnection[]) => void;
  onConnect: (connection: SshConnection) => void;
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const authOptions = useMemo(
    () => [
      { value: "agent", label: t("connections.auth.agent") },
      { value: "key", label: t("connections.auth.key") },
      { value: "password", label: t("connections.auth.password") },
    ],
    [t],
  );

  const authLabel = (connection: SshConnection) =>
    t(`connections.auth.${connection.authType}`);

  const openCreate = () => {
    setDraft({ ...EMPTY_DRAFT, id: `ssh-${Date.now().toString(36)}` });
  };

  const openEdit = (connection: SshConnection) => {
    setDraft({
      id: connection.id,
      name: connection.name,
      host: connection.host,
      port: String(connection.port),
      username: connection.username,
      authType: connection.authType,
      privateKeyPath: connection.privateKeyPath ?? "",
    });
  };

  const portNumber = draft ? Number(draft.port) : 0;
  const draftValid = Boolean(
    draft &&
      draft.host.trim() &&
      draft.username.trim() &&
      Number.isInteger(portNumber) &&
      portNumber > 0 &&
      portNumber <= 65535 &&
      (draft.authType !== "key" || draft.privateKeyPath.trim()),
  );

  const saveDraft = () => {
    if (!draft || !draftValid) {
      onToast(t(draft?.authType === "key" && !draft.privateKeyPath.trim() ? "connections.form.keyRequired" : "connections.form.invalid"));
      return;
    }
    const connection: SshConnection = {
      id: draft.id,
      name: draft.name.trim(),
      host: draft.host.trim(),
      port: portNumber,
      username: draft.username.trim(),
      authType: draft.authType,
      ...(draft.authType === "key"
        ? { privateKeyPath: draft.privateKeyPath.trim() }
        : {}),
    };
    const exists = connections.some((item) => item.id === connection.id);
    onChange(
      exists
        ? connections.map((item) => (item.id === connection.id ? connection : item))
        : [...connections, connection],
    );
    setDraft(null);
  };

  const pickKey = () => {
    void window.meow.pickPrivateKey().then((filePath) => {
      if (!filePath) return;
      setDraft((current) => (current ? { ...current, privateKeyPath: filePath } : current));
    });
  };

  const testConnection = (connection: SshConnection) => {
    if (testing) return;
    setTesting(connection.id);
    void window.meow
      .sshTest(connection)
      .then((result) => {
        if (result.ok) {
          onToast(t("connections.testSuccess"));
          return;
        }
        onToast(
          result.error === "password-interactive"
            ? t("connections.testPassword")
            : result.error ?? t("connections.testFailed"),
        );
      })
      .catch((error) => onToast(error instanceof Error ? error.message : String(error)))
      .finally(() => setTesting(null));
  };

  const removeConnection = (connection: SshConnection) => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirming === connection.id) {
      setConfirming(null);
      onChange(connections.filter((item) => item.id !== connection.id));
      return;
    }
    setConfirming(connection.id);
    confirmTimer.current = setTimeout(() => setConfirming(null), 4000);
  };

  return (
    <div className="mc-settings__inner">
      <Section
        title={t("connections.section")}
        description={t("connections.desc")}
        action={
          <Button size="sm" onClick={openCreate}>
            {t("connections.create")}
          </Button>
        }
      >
        {connections.length === 0 ? (
          <p className="mc-conn__empty">{t("connections.empty")}</p>
        ) : (
          connections.map((connection) => (
            <FieldRow
              key={connection.id}
              label={connection.name || `${connection.username}@${connection.host}`}
              hint={`${connection.username}@${connection.host}:${connection.port} · ${authLabel(connection)}`}
            >
              <div className="mc-conn__actions">
                <Button size="sm" onClick={() => onConnect(connection)}>
                  {t("connections.connect")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={testing === connection.id}
                  onClick={() => testConnection(connection)}
                >
                  {testing === connection.id ? t("connections.testing") : t("connections.test")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openEdit(connection)}>
                  {t("actions.edit")}
                </Button>
                <Button
                  size="sm"
                  variant={confirming === connection.id ? "danger" : "ghost"}
                  onClick={() => removeConnection(connection)}
                >
                  {confirming === connection.id ? t("actions.confirmDelete") : t("actions.delete")}
                </Button>
              </div>
            </FieldRow>
          ))
        )}
      </Section>

      <Dialog open={draft !== null} onClose={() => setDraft(null)} labelledBy="mc-conn-title">
        <span className="mc-dialog__title" id="mc-conn-title">
          {connections.some((item) => item.id === draft?.id)
            ? t("connections.form.titleEdit")
            : t("connections.form.titleNew")}
        </span>
        {draft ? (
          <div className="mc-conn__form">
            <TextField
              label={t("connections.form.name")}
              value={draft.name}
              placeholder={t("connections.form.namePlaceholder")}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <div className="mc-conn__grid">
              <TextField
                label={t("connections.form.host")}
                value={draft.host}
                placeholder={t("connections.form.hostPlaceholder")}
                spellCheck={false}
                onChange={(event) => setDraft({ ...draft, host: event.target.value })}
              />
              <TextField
                label={t("connections.form.port")}
                value={draft.port}
                inputMode="numeric"
                onChange={(event) =>
                  setDraft({ ...draft, port: event.target.value.replace(/[^\d]/g, "").slice(0, 5) })
                }
              />
            </div>
            <TextField
              label={t("connections.form.username")}
              value={draft.username}
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, username: event.target.value })}
            />
            <label className="mc-field">
              <span className="mc-field__label">{t("connections.form.auth")}</span>
              <CustomSelect
                value={draft.authType}
                options={authOptions}
                onChange={(value) => setDraft({ ...draft, authType: value as SshAuthType })}
                ariaLabel={t("connections.form.auth")}
              />
            </label>
            {draft.authType === "key" ? (
              <div className="mc-conn__keyrow">
                <TextField
                  label={t("connections.form.privateKey")}
                  value={draft.privateKeyPath}
                  spellCheck={false}
                  onChange={(event) => setDraft({ ...draft, privateKeyPath: event.target.value })}
                />
                <IconButton size="sm" label={t("connections.form.chooseKey")} onClick={pickKey}>
                  <LuFolderOpen size={14} />
                </IconButton>
              </div>
            ) : null}
            <p className="mc-conn__note">
              <LuServer size={13} />
              {t("connections.form.note")}
            </p>
          </div>
        ) : null}
        <div className="mc-dialog__footer">
          <Button variant="ghost" onClick={() => setDraft(null)}>
            {t("actions.cancel")}
          </Button>
          <Button variant="primary" disabled={!draftValid} onClick={saveDraft}>
            {t("actions.save")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
