import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuEllipsis,
  LuLayers,
  LuPencil,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
} from "react-icons/lu";
import * as api from "../../api";
import type { MailAccount, MailCounts } from "../../mail/types";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { useMail } from "./MailProvider";
import { CATEGORY_ICON, CATEGORY_ORDER, accountColor, accountInitial } from "./mail-meta";
import "./mail.css";

const EMPTY_COUNTS: MailCounts = {
  all: 0,
  inbox: 0,
  unread: 0,
  drafts: 0,
  outbox: 0,
  sent: 0,
  trash: 0,
  junk: 0,
};

function CategoryList({ counts, prefix }: { counts: MailCounts; prefix: string }) {
  const { t } = useTranslation("mail");
  const { category, selectCategory } = useMail();
  return (
    <div className="mc-mail__cats">
      {CATEGORY_ORDER.map((key) => {
        const Icon = CATEGORY_ICON[key];
        const count = counts[key] ?? 0;
        return (
          <button
            key={`${prefix}:${key}`}
            type="button"
            className="mc-mail__cat"
            data-active={category === key}
            onClick={() => selectCategory(key)}
          >
            <Icon size={15} />
            <span className="mc-mail__catlabel">{t(`categories.${key}`)}</span>
            {count > 0 ? <span className="mc-mail__catcount">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function MailNav() {
  const { t } = useTranslation("mail");
  const {
    accounts,
    unified,
    activeAccountId,
    selectAccount,
    editAccount,
    removeAccount,
    startAddAccount,
    errorText,
  } = useMail();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<MailAccount | null>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!menuFor) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && navRef.current?.contains(target)) {
        const inMenu = (target as Element).closest?.(".mc-mail__accountmenu");
        if (inMenu) return;
      }
      setMenuFor(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuFor]);

  const syncAccount = (account: MailAccount) => {
    setMenuFor(null);
    void api.mailSync({ accountId: account.id });
  };

  const syncError = (account: MailAccount) => {
    const raw = account.sync?.lastError;
    if (!raw) return null;
    const [code, ...rest] = raw.split(":");
    return errorText(code, rest.join(":").trim());
  };

  return (
    <nav ref={navRef} className="mc-panel mc-panel--conversations mc-mail__nav" aria-label={t("nav.title")}>
      <div className="mc-mail__navhead">
        <h1 className="mc-settings__heading">{t("nav.title")}</h1>
        <button
          type="button"
          className="mc-mail__addbtn"
          aria-label={t("nav.add")}
          title={t("nav.add")}
          onClick={startAddAccount}
        >
          <LuPlus size={15} />
        </button>
      </div>

      <div className="mc-mail__accounts">
        <div className="mc-mail__account" data-active={activeAccountId === "unified"}>
          <div className="mc-mail__accountcard" data-active={activeAccountId === "unified"}>
            <button
              type="button"
              className="mc-mail__accountrow"
              data-active={activeAccountId === "unified"}
              onClick={() => selectAccount("unified")}
            >
              <span className="mc-mail__avatar mc-mail__avatar--all">
                <LuLayers size={15} />
              </span>
              <span className="mc-mail__accountname">{t("nav.unified")}</span>
              {unified.inbox > 0 ? <span className="mc-mail__badge">{unified.inbox}</span> : null}
            </button>
          </div>
          {activeAccountId === "unified" && accounts.length ? (
            <CategoryList counts={unified} prefix="unified" />
          ) : null}
        </div>

        {accounts.map((account) => {
          const counts = account.counts ?? EMPTY_COUNTS;
          const active = activeAccountId === account.id;
          const problem = syncError(account);
          return (
            <div key={account.id} className="mc-mail__account" data-active={active}>
              <div className="mc-mail__accountcard" data-active={active}>
                <button
                  type="button"
                  className="mc-mail__accountrow"
                  data-active={active}
                  onClick={() => selectAccount(account.id)}
                >
                  <span className={`mc-mail__avatar ${accountColor(account.id)}`}>
                    {accountInitial(account.displayName, account.email)}
                  </span>
                  <span className="mc-mail__accountmeta">
                    <span className="mc-mail__accountname">{account.displayName || account.email}</span>
                    <span className="mc-mail__accountmail">{account.email}</span>
                  </span>
                  {account.syncing ? (
                    <LuRefreshCw className="mc-mail__syncing" size={13} aria-label={t("nav.syncing")} />
                  ) : problem ? (
                    <span className="mc-mail__accounterror" title={problem} />
                  ) : null}
                  {counts.inbox > 0 ? <span className="mc-mail__badge">{counts.inbox}</span> : null}
                </button>
                <button
                  type="button"
                  className="mc-mail__accountmore"
                  aria-label={t("nav.accountMenu")}
                  title={t("nav.accountMenu")}
                  onClick={() => setMenuFor(menuFor === account.id ? null : account.id)}
                >
                  <LuEllipsis size={15} />
                </button>
                {menuFor === account.id ? (
                  <div className="mc-mail__accountmenu" role="menu">
                    <button type="button" role="menuitem" onClick={() => syncAccount(account)}>
                      <LuRefreshCw size={14} />
                      {t("nav.syncNow")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuFor(null);
                        editAccount(account);
                      }}
                    >
                      <LuPencil size={14} />
                      {t("nav.edit")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-danger="true"
                      onClick={() => {
                        setMenuFor(null);
                        setRemoveTarget(account);
                      }}
                    >
                      <LuTrash2 size={14} />
                      {t("nav.remove")}
                    </button>
                  </div>
                ) : null}
              </div>
              {active ? <CategoryList counts={counts} prefix={account.id} /> : null}
            </div>
          );
        })}

        {!accounts.length ? <p className="mc-mail__navempty">{t("nav.noAccounts")}</p> : null}
      </div>

      <div className="mc-mail__navfoot">
        <Button variant="outline" size="sm" icon={<LuPlus size={14} />} block onClick={startAddAccount}>
          {t("nav.add")}
        </Button>
      </div>

      <Dialog open={Boolean(removeTarget)} onClose={() => setRemoveTarget(null)}>
        <div className="mc-mail__dialog">
          <h2>{t("nav.removeTitle")}</h2>
          <p>{t("nav.removeBody", { email: removeTarget?.email ?? "" })}</p>
          <div className="mc-mail__dialogactions">
            <Button variant="ghost" onClick={() => setRemoveTarget(null)}>
              {t("wizard.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = removeTarget;
                setRemoveTarget(null);
                if (target) void removeAccount(target.id);
              }}
            >
              {t("nav.removeConfirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    </nav>
  );
}
