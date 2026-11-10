import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MailAccount, MailAccountInput, MailAccountTestResult } from "../../mail/types";
import { MAIL_PRESETS, presetByKey, presetForEmail } from "../../mail/provider-presets";
import * as api from "../../api";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { TextField } from "../ui/TextField";
import { Toggle } from "../ui/Toggle";
import { useMail } from "./MailProvider";
import "./mail.css";

const STEP_KEYS = ["stepProvider", "stepCredentials", "stepServers", "stepVerify"];
const ROLE_KEYS = ["inbox", "sent", "drafts", "trash", "junk"];

export function AddAccountWizard({
  account,
  allowCancel,
  onComplete,
  onCancel,
}: {
  account: MailAccount | null;
  allowCancel: boolean;
  onComplete: (accountId?: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("mail");
  const { errorText, notify } = useMail();
  const initialPreset = presetByKey(account?.provider) ?? presetByKey("custom")!;

  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState(account?.provider ?? "qq");
  const [email, setEmail] = useState(account?.email ?? "");
  const [displayName, setDisplayName] = useState(account?.displayName ?? "");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState(account?.imap.host ?? initialPreset.imapHost);
  const [imapPort, setImapPort] = useState(String(account?.imap.port ?? initialPreset.imapPort));
  const [imapSecure, setImapSecure] = useState(account?.imap.secure ?? initialPreset.imapSecure);
  const [smtpHost, setSmtpHost] = useState(account?.smtp.host ?? initialPreset.smtpHost);
  const [smtpPort, setSmtpPort] = useState(String(account?.smtp.port ?? initialPreset.smtpPort));
  const [smtpSecure, setSmtpSecure] = useState(account?.smtp.secure ?? initialPreset.smtpSecure);
  const [smtpRequireTLS, setSmtpRequireTLS] = useState(
    account?.smtp.requireTLS ?? initialPreset.smtpRequireTLS,
  );
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [testResult, setTestResult] = useState<MailAccountTestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPreset = (key: string) => {
    const preset = presetByKey(key);
    setProvider(key);
    setTested(false);
    setTestResult(null);
    if (!preset) return;
    setImapHost(preset.imapHost);
    setImapPort(String(preset.imapPort));
    setImapSecure(preset.imapSecure);
    setSmtpHost(preset.smtpHost);
    setSmtpPort(String(preset.smtpPort));
    setSmtpSecure(preset.smtpSecure);
    setSmtpRequireTLS(preset.smtpRequireTLS);
  };

  const touchServers = () => {
    setTested(false);
    setTestResult(null);
  };

  const buildAccount = (): MailAccountInput => ({
    id: account?.id,
    provider,
    email: email.trim().toLowerCase(),
    displayName: displayName.trim() || email.trim(),
    imap: {
      host: imapHost.trim(),
      port: Number(imapPort) || 993,
      secure: imapSecure,
    },
    smtp: {
      host: smtpHost.trim(),
      port: Number(smtpPort) || 465,
      secure: smtpSecure,
      requireTLS: smtpSecure ? false : smtpRequireTLS,
    },
    folderRoles: testResult?.imap?.roles,
    sync: { intervalMinutes: account?.sync.intervalMinutes ?? 5 },
  });

  const nextFromCredentials = () => {
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError(t("wizard.invalidEmail"));
      return;
    }
    if (!account?.hasPassword && !password.trim()) {
      setError(t("wizard.required"));
      return;
    }
    setError(null);
    const match = presetForEmail(value);
    if (match && provider !== "custom" && match.key !== provider) applyPreset(match.key);
    setStep(2);
  };

  const nextFromServers = () => {
    if (!imapHost.trim() || !smtpHost.trim()) {
      setError(t("wizard.required"));
      return;
    }
    setError(null);
    setStep(3);
    void runTest();
  };

  const runTest = async () => {
    setTesting(true);
    setTested(false);
    setTestResult(null);
    setError(null);
    try {
      const result = await api.mailTestAccount({
        accountId: account?.id,
        account: buildAccount(),
        password: password.trim() || undefined,
      });
      setTestResult(result);
      setTested(true);
      if (!result.ok) setError(errorText(result.code, result.detail));
    } catch {
      setError(t("error.internal_error"));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!testResult?.imap?.ok || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.mailSaveAccount({
        account: { ...buildAccount(), folderRoles: testResult.imap.roles },
        password: password.trim() || undefined,
      });
      if (!result.ok || !result.account) {
        setError(t("wizard.saveFailed", { error: errorText(result.code, result.detail) }));
        return;
      }
      notify(t(account ? "wizard.savedEdit" : "wizard.saved"));
      onComplete(result.account.id);
    } catch {
      setError(t("error.internal_error"));
    } finally {
      setSaving(false);
    }
  };

  const providerLabel = (key: string) =>
    t(`wizard.provider.${key}`, { defaultValue: t("wizard.provider.custom") });
  const detectedFolders = (testResult?.imap?.folders ?? []).filter((folder) => folder.role);

  return (
    <div className="mc-mail__wizard">
      <div className="mc-mail__wizardinner">
        <header className="mc-mail__wizardhead">
          <h1>{account ? t("wizard.titleEdit") : t("wizard.titleAdd")}</h1>
          <p>{t("wizard.subtitle")}</p>
        </header>

        <ol className="mc-mail__steps">
          {STEP_KEYS.map((key, index) => (
            <li key={key} data-active={index === step} data-done={index < step}>
              <span>{index + 1}</span>
              {t(`wizard.${key}`)}
            </li>
          ))}
        </ol>

        <div className="mc-mail__wizardbody">
          {step === 0 ? (
            <div className="mc-mail__providers">
              {MAIL_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className="mc-mail__provider"
                  data-active={provider === preset.key}
                  onClick={() => applyPreset(preset.key)}
                >
                  <span className="mc-mail__providername">{providerLabel(preset.key)}</span>
                  <span className="mc-mail__providerhint">{t(`wizard.hint.${preset.key}`)}</span>
                </button>
              ))}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="mc-mail__form">
              <TextField
                label={t("wizard.email")}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t("wizard.emailPlaceholder")}
                autoFocus
              />
              <TextField
                label={t("wizard.displayName")}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t("wizard.displayNamePlaceholder")}
              />
              <TextField
                label={t("wizard.password")}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t("wizard.passwordPlaceholder")}
                hint={
                  account?.hasPassword ? t("wizard.passwordEditHint") : t(`wizard.hint.${provider}`, {
                    defaultValue: "",
                  })
                }
              />
            </div>
          ) : null}

          {step === 2 ? (
            <div className="mc-mail__form">
              <div className="mc-mail__composerow">
                <TextField
                  label={t("wizard.imapHost")}
                  value={imapHost}
                  onChange={(event) => {
                    setImapHost(event.target.value);
                    touchServers();
                  }}
                />
                <TextField
                  label={t("wizard.imapPort")}
                  type="number"
                  value={imapPort}
                  onChange={(event) => {
                    setImapPort(event.target.value);
                    touchServers();
                  }}
                />
              </div>
              <div className="mc-mail__togglefield">
                <span>{t("wizard.imapSecure")}</span>
                <Toggle
                  checked={imapSecure}
                  onChange={(next) => {
                    setImapSecure(next);
                    touchServers();
                  }}
                  label={t("wizard.imapSecure")}
                />
              </div>
              <div className="mc-mail__composerow">
                <TextField
                  label={t("wizard.smtpHost")}
                  value={smtpHost}
                  onChange={(event) => {
                    setSmtpHost(event.target.value);
                    touchServers();
                  }}
                />
                <TextField
                  label={t("wizard.smtpPort")}
                  type="number"
                  value={smtpPort}
                  onChange={(event) => {
                    setSmtpPort(event.target.value);
                    touchServers();
                  }}
                />
              </div>
              <div className="mc-mail__togglefield">
                <span>{t("wizard.smtpSecure")}</span>
                <Toggle
                  checked={smtpSecure}
                  onChange={(next) => {
                    setSmtpSecure(next);
                    touchServers();
                  }}
                  label={t("wizard.smtpSecure")}
                />
              </div>
              {!smtpSecure ? (
                <div className="mc-mail__togglefield">
                  <span>{t("wizard.smtpStartTls")}</span>
                  <Toggle
                    checked={smtpRequireTLS}
                    onChange={(next) => {
                      setSmtpRequireTLS(next);
                      touchServers();
                    }}
                    label={t("wizard.smtpStartTls")}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="mc-mail__verify">
              {testing ? (
                <div className="mc-mail__verifyrow">
                  <Spinner size={16} />
                  <span>{t("wizard.testing")}</span>
                </div>
              ) : null}
              {!testing && testResult?.imap ? (
                <div className="mc-mail__verifyblock" data-ok={testResult.imap.ok}>
                  <strong>
                    {testResult.imap.ok
                      ? t("wizard.imapOk")
                      : t("wizard.imapFail", {
                          error: errorText(testResult.imap.code, testResult.imap.detail),
                        })}
                  </strong>
                  {testResult.imap.ok ? (
                    detectedFolders.length ? (
                      <div className="mc-mail__folders">
                        <span className="mc-mail__folderslabel">{t("wizard.foldersDetected")}</span>
                        {detectedFolders.map((folder) => (
                          <span key={`${folder.role}:${folder.path}`} className="mc-mail__folder">
                            {t(`wizard.roles.${folder.role}`)}
                            <em>{folder.path}</em>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mc-mail__hint">{t("wizard.noFolders")}</p>
                    )
                  ) : null}
                </div>
              ) : null}
              {!testing && testResult?.smtp ? (
                <div className="mc-mail__verifyblock" data-ok={testResult.smtp.ok}>
                  <strong>
                    {testResult.smtp.ok
                      ? t("wizard.smtpOk")
                      : t("wizard.smtpFail", {
                          error: errorText(testResult.smtp.code, testResult.smtp.detail),
                        })}
                  </strong>
                </div>
              ) : null}
              {!testing && tested && testResult && !testResult.imap?.ok ? (
                <p className="mc-mail__hint">{t("wizard.noFolders")}</p>
              ) : null}
            </div>
          ) : null}

          {error ? <p className="mc-mail__error">{error}</p> : null}
        </div>

        <footer className="mc-mail__wizardfoot">
          {allowCancel ? (
            <Button variant="ghost" onClick={onCancel}>
              {t("wizard.cancel")}
            </Button>
          ) : (
            <span />
          )}
          <span className="mc-mail__spacer" />
          {step > 0 ? (
            <Button variant="ghost" onClick={() => setStep((current) => current - 1)}>
              {t("wizard.back")}
            </Button>
          ) : null}
          {step === 0 ? (
            <Button variant="primary" onClick={() => setStep(1)}>
              {t("wizard.next")}
            </Button>
          ) : null}
          {step === 1 ? (
            <Button variant="primary" onClick={nextFromCredentials}>
              {t("wizard.next")}
            </Button>
          ) : null}
          {step === 2 ? (
            <Button variant="primary" onClick={nextFromServers}>
              {t("wizard.next")}
            </Button>
          ) : null}
          {step === 3 ? (
            <>
              <Button variant="ghost" onClick={() => void runTest()} disabled={testing || saving}>
                {tested ? t("wizard.testRetry") : t("wizard.testConnection")}
              </Button>
              <Button
                variant="primary"
                onClick={() => void save()}
                disabled={testing || saving || !testResult?.imap?.ok}
              >
                {saving ? t("wizard.saving") : t("wizard.save")}
              </Button>
            </>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
