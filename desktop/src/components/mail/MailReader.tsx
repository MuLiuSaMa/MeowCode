import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuArrowLeft,
  LuDownload,
  LuForward,
  LuImage,
  LuMailOpen,
  LuReply,
  LuTrash2,
} from "react-icons/lu";
import { formatDateTime } from "../../i18n/format";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Spinner } from "../ui/Spinner";
import { MailHtml } from "./MailHtml";
import { SenderAvatar } from "./SenderAvatar";
import { useMail } from "./MailProvider";
import { formatBytes, parseAddress } from "./mail-meta";
import { hasRemoteImages } from "./mail-html";
import "./mail.css";

export function MailReader() {
  const { t } = useTranslation("mail");
  const {
    reader,
    readerLoading,
    readerError,
    accounts,
    closeReader,
    reply,
    forward,
    deleteReader,
    markUnread,
    downloadAttachment,
  } = useMail();
  const [showImages, setShowImages] = useState(true);
  const [confirmPermanent, setConfirmPermanent] = useState(false);

  useEffect(() => {
    setShowImages(true);
    setConfirmPermanent(false);
  }, [reader?.uid, reader?.uidValidity]);

  const account = accounts.find((item) => item.id === reader?.accountId);
  const permanent = reader?.role === "trash";
  const hasRemote = Boolean(reader?.html && hasRemoteImages(reader.html));
  const identity =
    reader?.role === "sent"
      ? parseAddress(reader?.to[0] || "")
      : { name: reader?.from.name ?? "", address: reader?.from.address ?? "" };
  const visibleAttachments = (reader?.attachments ?? []).filter((item) => !item.inline);

  const requestDelete = () => {
    if (permanent) setConfirmPermanent(true);
    else void deleteReader();
  };

  return (
    <div className="mc-mail__reader">
      <header className="mc-mail__readerbar">
        <Button variant="ghost" size="sm" icon={<LuArrowLeft size={15} />} onClick={closeReader}>
          {t("reader.back")}
        </Button>
        <span className="mc-mail__spacer" />
        {reader && reader.role !== "drafts" ? (
          <Button variant="ghost" size="sm" icon={<LuReply size={14} />} onClick={reply}>
            {t("reader.reply")}
          </Button>
        ) : null}
        {reader ? (
          <Button variant="ghost" size="sm" icon={<LuForward size={14} />} onClick={forward}>
            {t("reader.forward")}
          </Button>
        ) : null}
        {reader && hasRemote ? (
          <IconButton
            label={showImages ? t("reader.hideImages") : t("reader.showImages")}
            onClick={() => setShowImages((value) => !value)}
          >
            <LuImage size={15} />
          </IconButton>
        ) : null}
        {reader ? (
          <Button variant="ghost" size="sm" icon={<LuMailOpen size={14} />} onClick={() => void markUnread()}>
            {t("reader.markUnread")}
          </Button>
        ) : null}
        {reader ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<LuTrash2 size={14} />}
            onClick={requestDelete}
          >
            {permanent ? t("reader.deletePermanent") : t("reader.delete")}
          </Button>
        ) : null}
      </header>

      <div className="mc-mail__readerbody">
        {readerLoading ? (
          <div className="mc-mail__center">
            <Spinner />
            <span>{t("reader.loading")}</span>
          </div>
        ) : null}

        {!readerLoading && readerError ? (
          <div className="mc-mail__center mc-mail__error">{readerError}</div>
        ) : null}

        {!readerLoading && reader ? (
          <article className="mc-mail__article">
            <div className="mc-mail__subjectrow">
              <SenderAvatar
                name={identity.name || account?.displayName || ""}
                address={identity.address || account?.email || ""}
                size="lg"
              />
              <h1 className="mc-mail__subject">{reader.subject || t("reader.noSubject")}</h1>
            </div>
            {reader.role === "drafts" ? (
              <p className="mc-mail__hint">{t("reader.serverDraftHint")}</p>
            ) : null}

            <dl className="mc-mail__meta">
              <div>
                <dt>{t("reader.from")}</dt>
                <dd>
                  {reader.from.name ? `${reader.from.name} <${reader.from.address}>` : reader.from.address}
                </dd>
              </div>
              <div>
                <dt>{t("reader.to")}</dt>
                <dd>{reader.to.join(", ") || "—"}</dd>
              </div>
              {reader.cc.length ? (
                <div>
                  <dt>{t("reader.cc")}</dt>
                  <dd>{reader.cc.join(", ")}</dd>
                </div>
              ) : null}
              <div>
                <dt>{t("reader.date")}</dt>
                <dd>{formatDateTime(new Date(reader.date))}</dd>
              </div>
              <div>
                <dt>{t("reader.account")}</dt>
                <dd>{account ? `${account.displayName} <${account.email}>` : reader.accountId ?? "—"}</dd>
              </div>
            </dl>

            {visibleAttachments.length ? (
              <section className="mc-mail__attachments">
                <h2>{t("reader.attachmentsTitle", { count: visibleAttachments.length })}</h2>
                {visibleAttachments.map((attachment) => (
                  <div key={`${attachment.index}:${attachment.filename}`} className="mc-mail__attachment">
                    <span className="mc-mail__attachmentname">{attachment.filename}</span>
                    <span className="mc-mail__attachmentsize">{formatBytes(attachment.size)}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<LuDownload size={14} />}
                      onClick={() => void downloadAttachment(attachment.index)}
                    >
                      {t("reader.download")}
                    </Button>
                  </div>
                ))}
              </section>
            ) : null}

            {reader.html ? (
              <MailHtml html={reader.html} allowImages={showImages} />
            ) : (
              <pre className="mc-mail__textbody">{reader.text || t("reader.noBody")}</pre>
            )}
          </article>
        ) : null}
      </div>

      <Dialog open={confirmPermanent} onClose={() => setConfirmPermanent(false)}>
        <div className="mc-mail__dialog">
          <h2>{t("reader.permanentTitle")}</h2>
          <p>{t("reader.permanentBody")}</p>
          <div className="mc-mail__dialogactions">
            <Button variant="ghost" onClick={() => setConfirmPermanent(false)}>
              {t("compose.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmPermanent(false);
                void deleteReader();
              }}
            >
              {t("reader.permanentConfirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
