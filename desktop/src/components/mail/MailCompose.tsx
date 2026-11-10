import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronDown, LuPaperclip, LuSend, LuX } from "react-icons/lu";
import * as api from "../../api";
import { formatDateTime } from "../../i18n/format";
import type { MailDraftAttachment } from "../../mail/types";
import { Button } from "../ui/Button";
import { CustomSelect } from "../ui/CustomSelect";
import { Dialog } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { TextField } from "../ui/TextField";
import { useMail } from "./MailProvider";
import { formatBytes } from "./mail-meta";
import "./mail.css";

function splitAddresses(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter((item) => item.includes("@"));
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

export function MailCompose() {
  const { t } = useTranslation("mail");
  const { compose, accounts, closeCompose, saveDraft, send, aiProviderId } = useMail();
  const intent = compose;
  const draft = intent?.draft;
  const body = intent?.body;

  const initial = useMemo(() => {
    if (!intent) {
      return {
        accountId: "",
        to: "",
        cc: "",
        bcc: "",
        subject: "",
        text: "",
        attachments: [] as MailDraftAttachment[],
      };
    }
    const replyQuote =
      intent.mode === "reply" && body
        ? `\n\n${t("compose.replyHeader", {
            date: formatDateTime(new Date(body.date)),
            from: body.from.name || body.from.address,
          })}\n${quoteText(body.text || stripHtml(body.html ?? ""))}`
        : "";
    const forwardMeta =
      intent.mode === "forward" && body
        ? `${t("compose.forwardHeader")}\n${t("reader.from")}: ${
            body.from.name ? `${body.from.name} <${body.from.address}>` : body.from.address
          }\n${t("reader.date")}: ${formatDateTime(new Date(body.date))}\n${t("compose.subject")}: ${
            body.subject || t("reader.noSubject")
          }\n\n`
        : "";
    const forwardText =
      intent.mode === "forward" && body
        ? forwardMeta + (body.text || stripHtml(body.html ?? ""))
        : "";
    const subject = body?.subject ?? "";
    const prefixedSubject =
      intent.mode === "reply"
        ? /^re:/i.test(subject)
          ? subject
          : `Re: ${subject}`
        : intent.mode === "forward"
          ? /^fwd:/i.test(subject)
            ? subject
            : `Fwd: ${subject}`
          : "";
    return {
      accountId: intent.accountId,
      to: draft?.to?.join(", ") ?? (intent.mode === "reply" && body ? body.from.address : ""),
      cc: draft?.cc?.join(", ") ?? "",
      bcc: draft?.bcc?.join(", ") ?? "",
      subject: draft?.subject ?? prefixedSubject,
      text: draft?.text ?? (replyQuote ? `${replyQuote}` : forwardText),
      attachments: draft?.attachments ?? [],
    };
  }, [intent, draft, body, t]);

  const [accountId, setAccountId] = useState(initial.accountId || accounts[0]?.id || "");
  const [to, setTo] = useState(initial.to);
  const [cc, setCc] = useState(initial.cc);
  const [bcc, setBcc] = useState(initial.bcc);
  const [subject, setSubject] = useState(initial.subject);
  const [text, setText] = useState(initial.text);
  const [attachments, setAttachments] = useState<MailDraftAttachment[]>(initial.attachments);
  const [showCcBcc, setShowCcBcc] = useState(Boolean(initial.cc || initial.bcc));
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [aiOpen, setAiOpen] = useState(Boolean(intent?.ai));
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiUndo, setAiUndo] = useState<string | null>(null);
  // 生成代号：取消/关闭后自增，晚到的 IPC 结果据此丢弃，避免覆盖用户已编辑的正文
  const aiGeneration = useRef(0);
  const initialSnapshot = useRef(
    JSON.stringify([
      initial.accountId,
      initial.to,
      initial.cc,
      initial.bcc,
      initial.subject,
      initial.text,
      initial.attachments.map((item) => item.path),
    ]),
  );

  const snapshot = JSON.stringify([
    accountId,
    to,
    cc,
    bcc,
    subject,
    text,
    attachments.map((item) => item.path),
  ]);
  const dirty = snapshot !== initialSnapshot.current;

  if (!intent) return null;

  const title =
    intent.mode === "reply"
      ? t("compose.titleReply")
      : intent.mode === "forward"
        ? t("compose.titleForward")
        : intent.mode === "draft"
          ? t("compose.titleDraft")
          : t("compose.titleNew");

  const addAttachments = async () => {
    const picked = await api.mailPickAttachments();
    if (!picked.ok || !picked.files.length) return;
    setAttachments((previous) => {
      const paths = new Set(previous.map((item) => item.path));
      return [...previous, ...picked.files.filter((item) => !paths.has(item.path))];
    });
  };

  const payload = () => ({
    accountId,
    to: splitAddresses(to),
    cc: splitAddresses(cc),
    bcc: splitAddresses(bcc),
    subject: subject.trim(),
    text,
    attachments,
    inReplyTo: draft?.inReplyTo ?? (intent.mode === "reply" ? body?.messageId ?? null : null),
    references:
      draft?.references ??
      (intent.mode === "reply" && body
        ? [body.references, body.messageId].filter(Boolean).join(" ")
        : null),
    draftId: draft?.id,
  });

  const handleSend = async () => {
    if (sending) return;
    if (!accountId) {
      setError(t("compose.noAccount"));
      return;
    }
    if (!splitAddresses(to).length) {
      setError(t("compose.noRecipient"));
      return;
    }
    setError(null);
    setSending(true);
    const result = await send(payload());
    setSending(false);
    if (!result.ok) setError(result.error ?? t("compose.sendFailed", { error: "" }));
  };

  const handleAiWrite = async () => {
    if (aiBusy) return;
    const generation = ++aiGeneration.current;
    setAiBusy(true);
    setAiError(null);
    const original = body ? body.text || stripHtml(body.html ?? "") : "";
    const account = accounts.find((item) => item.id === accountId);
    // 回复引用块 / 转发内容块由客户端保留：只把标记之前的部分交给模型改写，
    // 生成后再拼回尾块，避免新提示词「不复述原邮件」导致整段替换删掉引用。
    let draftTop = text;
    let tail = "";
    if (body && (intent?.mode === "reply" || intent?.mode === "forward")) {
      const marker =
        intent?.mode === "reply"
          ? t("compose.replyHeader", {
              date: formatDateTime(new Date(body.date)),
              from: body.from.name || body.from.address,
            })
          : t("compose.forwardHeader");
      const at = text.indexOf(marker);
      if (at >= 0) {
        draftTop = text.slice(0, at).trim();
        tail = text.slice(at);
      }
    }
    try {
      const generated = await api.composeMailWithAi({
        mode: intent?.mode === "reply" ? "reply" : intent?.mode === "forward" ? "forward" : "new",
        instruction: aiInstruction.trim(),
        to,
        subject: subject.trim(),
        original,
        draft: draftTop,
        from: { name: account?.displayName || "", email: account?.email || "" },
        ...(aiProviderId ? { providerId: aiProviderId } : {}),
      });
      if (generation !== aiGeneration.current) return;
      setAiUndo(text);
      setText(tail ? `${generated}\n\n${tail}` : generated);
      setAiInstruction("");
    } catch (caught) {
      if (generation !== aiGeneration.current) return;
      setAiError(
        t("compose.aiFailed", {
          error: caught instanceof Error ? caught.message : String(caught),
        }),
      );
    } finally {
      if (generation === aiGeneration.current) setAiBusy(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!accountId || saving) return;
    setSaving(true);
    await saveDraft(payload());
    setSaving(false);
  };

  const requestClose = () => {
    if (dirty) setConfirmClose(true);
    else closeCompose();
  };

  return (
    <div className="mc-mail__compose">
      <header className="mc-mail__composebar">
        <IconButton label={t("compose.cancel")} onClick={requestClose}>
          <LuX size={16} />
        </IconButton>
        <h2>{title}</h2>
        <span className="mc-mail__spacer" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleSaveDraft()}
          disabled={saving || sending || aiBusy}
        >
          {t("compose.saveDraft")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<LuSend size={14} />}
          onClick={() => void handleSend()}
          disabled={sending || saving || aiBusy}
        >
          {sending ? t("compose.sending") : t("compose.send")}
        </Button>
      </header>

      <div className="mc-mail__composebody">
        <div className="mc-mail__composefrom">
          <span>{t("compose.from")}</span>
          <CustomSelect
            value={accountId}
            options={accounts.map((account) => ({
              value: account.id,
              label: `${account.displayName || account.email} <${account.email}>`,
            }))}
            onChange={setAccountId}
            ariaLabel={t("compose.from")}
          />
        </div>
        <TextField
          label={t("compose.to")}
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder={t("compose.toPlaceholder")}
        />
        <button
          type="button"
          className="mc-mail__ccbcc"
          data-open={showCcBcc}
          aria-expanded={showCcBcc}
          onClick={() => setShowCcBcc((value) => !value)}
        >
          <LuChevronDown size={14} />
          {t("compose.cc")} / {t("compose.bcc")}
        </button>
        {showCcBcc ? (
          <div className="mc-mail__composerow">
            <TextField
              label={t("compose.cc")}
              value={cc}
              onChange={(event) => setCc(event.target.value)}
            />
            <TextField
              label={t("compose.bcc")}
              value={bcc}
              onChange={(event) => setBcc(event.target.value)}
            />
          </div>
        ) : null}
        <TextField
          label={t("compose.subject")}
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder={t("compose.subjectPlaceholder")}
        />

        <div className="mc-mail__textfield">
          <div className="mc-mail__texthead">
            <span>{t("compose.body")}</span>
            <button
              type="button"
              className="mc-mail__aibtn"
              data-active={aiOpen}
              aria-expanded={aiOpen}
              onClick={() => {
                if (aiOpen) {
                  aiGeneration.current += 1;
                  setAiBusy(false);
                  setAiError(null);
                }
                setAiOpen(!aiOpen);
              }}
            >
              {t("compose.aiWrite")}
            </button>
          </div>
          {aiOpen ? (
            <div className="mc-mail__aibar">
              <input
                className="mc-mail__aiinput"
                value={aiInstruction}
                onChange={(event) => setAiInstruction(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void handleAiWrite();
                  }
                }}
                placeholder={t("compose.aiPlaceholder")}
                disabled={aiBusy}
                autoFocus
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleAiWrite()}
                disabled={aiBusy}
              >
                {aiBusy ? t("compose.aiGenerating") : t("compose.aiGenerate")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  aiGeneration.current += 1;
                  setAiBusy(false);
                  setAiError(null);
                  setAiOpen(false);
                }}
              >
                {t("compose.cancel")}
              </Button>
              {aiUndo !== null && !aiBusy ? (
                <button
                  type="button"
                  className="mc-mail__aiundo"
                  onClick={() => {
                    setText(aiUndo);
                    setAiUndo(null);
                  }}
                >
                  {t("compose.aiUndo")}
                </button>
              ) : null}
            </div>
          ) : null}
          {aiOpen && aiError ? <p className="mc-mail__error">{aiError}</p> : null}
          <textarea
            className="mc-mail__composetext"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("compose.bodyPlaceholder")}
            spellCheck={false}
          />
        </div>

        <div className="mc-mail__composeattachments">
          <Button variant="outline" size="sm" icon={<LuPaperclip size={14} />} onClick={() => void addAttachments()}>
            {t("compose.addAttachment")}
          </Button>
          {attachments.map((attachment) => (
            <span key={attachment.path} className="mc-mail__composefile">
              <span>{attachment.name}</span>
              <span className="mc-mail__attachmentsize">{formatBytes(attachment.size)}</span>
              <IconButton
                label={t("compose.removeAttachment")}
                size="sm"
                onClick={() =>
                  setAttachments((previous) => previous.filter((item) => item.path !== attachment.path))
                }
              >
                <LuX size={13} />
              </IconButton>
            </span>
          ))}
        </div>

        {error ? <p className="mc-mail__error">{error}</p> : null}
      </div>

      <Dialog open={confirmClose} onClose={() => setConfirmClose(false)}>
        <div className="mc-mail__dialog">
          <h2>{t("compose.dirtyTitle")}</h2>
          <p>{t("compose.dirtyBody")}</p>
          <div className="mc-mail__dialogactions">
            <Button variant="ghost" onClick={() => setConfirmClose(false)}>
              {t("compose.keepEditing")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmClose(false);
                closeCompose();
              }}
            >
              {t("compose.discard")}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
