import { useTranslation } from "react-i18next";
import {
  LuPaperclip,
  LuRefreshCw,
  LuRotateCw,
  LuSquarePen,
  LuTrash2,
} from "react-icons/lu";
import { formatDateTime, formatSessionStamp } from "../../i18n/format";
import type { MailCategory, MailListItem } from "../../mail/types";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Spinner } from "../ui/Spinner";
import { SenderAvatar } from "./SenderAvatar";
import { useMail } from "./MailProvider";
import { accountColor, parseAddress } from "./mail-meta";
import "./mail.css";

const EMPTY_KEY: Record<MailCategory, string> = {
  all: "list.emptyAll",
  inbox: "list.emptyInbox",
  unread: "list.emptyUnread",
  drafts: "list.emptyDrafts",
  outbox: "list.emptyOutbox",
  sent: "list.emptySent",
  trash: "list.emptyTrash",
  junk: "list.emptyJunk",
};

function senderLabel(t: (key: string, options?: Record<string, unknown>) => string, item: MailListItem): string {
  if (item.role === "sent" || item.kind === "outbox" || item.kind === "draft") {
    const to = (item.to || []).join(", ");
    return to ? t("list.toPrefix", { to }) : "—";
  }
  return item.fromName || item.fromAddr || "—";
}

function itemIdentity(item: MailListItem): { name: string; address: string } {
  if (item.role === "sent" || item.kind === "outbox" || item.kind === "draft") {
    const first = (item.to || [])[0] || "";
    return first ? parseAddress(first) : { name: "", address: "" };
  }
  return { name: item.fromName || "", address: item.fromAddr || "" };
}

function OutboxStatus({
  item,
  errorText,
}: {
  item: MailListItem;
  errorText: (code?: string | null, detail?: string | null) => string;
}) {
  const { t } = useTranslation("mail");
  if (item.status === "failed") {
    const [code, ...rest] = String(item.lastError || "smtp_error").split(":");
    return <span className="mc-mail__outboxerror">{t("list.outboxFailed", { error: errorText(code, rest.join(":").trim()) })}</span>;
  }
  return (
    <span className="mc-mail__outboxstate">
      {item.status === "sending" ? t("list.outboxSending") : t("list.outboxQueued")}
    </span>
  );
}

export function MailList() {
  const { t } = useTranslation("mail");
  const {
    items,
    total,
    hasMore,
    loading,
    loadingMore,
    category,
    syncing,
    activeAccountId,
    accounts,
    syncNow,
    startCompose,
    openMessage,
    loadMore,
    retryOutbox,
    removeOutbox,
    errorText,
  } = useMail();

  const accountById = new Map(accounts.map((account) => [account.id, account]));

  return (
    <div className="mc-mail__listwrap">
      <header className="mc-mail__listhead">
        <div className="mc-mail__listtitle">
          <h2>{t(`categories.${category}`)}</h2>
          <span className="mc-mail__listcount">{t("list.messageCount", { count: total })}</span>
          {syncing ? <Spinner size={14} /> : null}
        </div>
        <div className="mc-mail__listactions">
          <IconButton label={t("list.refresh")} onClick={syncNow} size="sm">
            <LuRefreshCw size={15} />
          </IconButton>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => startCompose(true)}
            title={t("compose.aiWrite")}
          >
            {t("compose.aiWrite")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<LuSquarePen size={14} />}
            onClick={() => startCompose()}
          >
            {t("list.compose")}
          </Button>
        </div>
      </header>

      <div className="mc-mail__rows">
        {loading && !items.length ? (
          <div className="mc-mail__center">
            <Spinner />
          </div>
        ) : null}

        {!loading && !items.length ? (
          <div className="mc-mail__center mc-mail__empty">{t(EMPTY_KEY[category])}</div>
        ) : null}

        {items.map((item) => {
          const unread = item.kind === "message" && item.seen === false;
          const account = accountById.get(item.accountId);
          const identity = itemIdentity(item);
          const stamp = formatSessionStamp(new Date(item.date));
          const fullDate = formatDateTime(new Date(item.date));
          const isOutbox = item.kind === "outbox";
          return (
            <div
              key={item.id}
              className="mc-mail__row"
              data-unread={unread}
              data-kind={item.kind}
              role={isOutbox ? undefined : "button"}
              tabIndex={isOutbox ? -1 : 0}
              onClick={() => {
                if (!isOutbox) void openMessage(item);
              }}
              onKeyDown={(event) => {
                if (isOutbox) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void openMessage(item);
                }
              }}
            >
              {activeAccountId === "unified" && account ? (
                <span
                  className={`mc-mail__dot ${accountColor(account.id)}`}
                  title={account.email}
                  aria-hidden="true"
                />
              ) : null}
              <SenderAvatar
                name={identity.name || account?.displayName || ""}
                address={identity.address || account?.email || ""}
              />
              <div className="mc-mail__rowbody">
                <div className="mc-mail__rowtop">
                  <span className="mc-mail__sender">{senderLabel(t, item)}</span>
                  <span className="mc-mail__rowtime" title={fullDate}>
                    {stamp || fullDate}
                  </span>
                </div>
                <div className="mc-mail__rowsubject">
                  {unread ? <span className="mc-mail__unreaddot" aria-hidden="true" /> : null}
                  <span>{item.subject || t("list.noSubject")}</span>
                  {item.hasAttachments ? <LuPaperclip size={13} /> : null}
                  {item.serverDraft ? <span className="mc-mail__tag">{t("list.serverDraft")}</span> : null}
                  {item.kind === "draft" ? <span className="mc-mail__tag">{t("list.localDraft")}</span> : null}
                </div>
                <div className="mc-mail__rowsnippet">
                  {isOutbox ? <OutboxStatus item={item} errorText={errorText} /> : null}
                  {item.snippet ? <span>{item.snippet}</span> : null}
                </div>
              </div>
              {isOutbox && item.outboxId ? (
                <div className="mc-mail__outboxactions">
                  <IconButton
                    label={t("list.retry")}
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      void retryOutbox(item.outboxId!);
                    }}
                  >
                    <LuRotateCw size={14} />
                  </IconButton>
                  <IconButton
                    label={t("list.remove")}
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeOutbox(item.outboxId!);
                    }}
                  >
                    <LuTrash2 size={14} />
                  </IconButton>
                </div>
              ) : null}
            </div>
          );
        })}

        {!loading && items.length && category !== "outbox" && (hasMore || total >= 80) ? (
          <div className="mc-mail__loadmore">
            <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? t("list.loading") : t("list.loadMore")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
