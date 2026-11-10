import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import type {
  MailAccount,
  MailBody,
  MailCategory,
  MailCounts,
  MailDraft,
  MailDraftAttachment,
  MailListItem,
} from "../../mail/types";

const PAGE_SIZE = 80;

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

export type MailScreen = "list" | "reader" | "compose" | "wizard";

export type ComposeIntent = {
  mode: "new" | "reply" | "forward" | "draft";
  accountId: string;
  body?: MailBody;
  draft?: MailDraft;
  returnTo: "list" | "reader";
  /** 打开写信时直接展开 AI 输入栏 */
  ai?: boolean;
};

export type MailComposePayload = {
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachments: MailDraftAttachment[];
  inReplyTo: string | null;
  references: string | null;
  draftId?: string;
};

type MailContextValue = {
  accounts: MailAccount[];
  accountsLoaded: boolean;
  unified: MailCounts;
  activeAccountId: string;
  activeAccount: MailAccount | null;
  category: MailCategory;
  counts: MailCounts;
  items: MailListItem[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  syncing: boolean;
  screen: MailScreen;
  reader: MailBody | null;
  readerLoading: boolean;
  readerError: string | null;
  compose: ComposeIntent | null;
  wizardAccount: MailAccount | null;
  errorText: (code?: string | null, detail?: string | null) => string;
  notify: (text: string) => void;
  /** 邮件 AI 写作模型 id；空串 = 跟随聊天 */
  aiProviderId: string;
  selectAccount: (accountId: string) => void;
  selectCategory: (category: MailCategory) => void;
  syncNow: () => void;
  loadMore: () => Promise<void>;
  openMessage: (item: MailListItem) => Promise<void>;
  closeReader: () => void;
  startCompose: (ai?: boolean) => void;
  reply: () => void;
  forward: () => void;
  closeCompose: () => void;
  saveDraft: (payload: MailComposePayload) => Promise<boolean>;
  send: (payload: MailComposePayload) => Promise<{ ok: boolean; error?: string }>;
  deleteReader: () => Promise<void>;
  markUnread: () => Promise<void>;
  downloadAttachment: (index: number) => Promise<void>;
  startAddAccount: () => void;
  editAccount: (account: MailAccount) => void;
  closeWizard: () => void;
  completeWizard: (accountId?: string) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;
  retryOutbox: (id: string) => Promise<void>;
  removeOutbox: (id: string) => Promise<void>;
};

const MailContext = createContext<MailContextValue | null>(null);

export function useMail(): MailContextValue {
  const value = useContext(MailContext);
  if (!value) throw new Error("useMail must be used inside MailProvider");
  return value;
}

export function MailProvider({
  children,
  onToast,
  aiProviderId = "",
}: {
  children: ReactNode;
  onToast?: (text: string) => void;
  aiProviderId?: string;
}) {
  const { t } = useTranslation("mail");
  const toastRef = useRef(onToast);
  toastRef.current = onToast;

  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [unified, setUnified] = useState<MailCounts>(EMPTY_COUNTS);
  const [activeAccountId, setActiveAccountId] = useState("unified");
  const [category, setCategory] = useState<MailCategory>("inbox");
  const [items, setItems] = useState<MailListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [screen, setScreen] = useState<MailScreen>("list");
  const [reader, setReader] = useState<MailBody | null>(null);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeIntent | null>(null);
  const [wizardAccount, setWizardAccount] = useState<MailAccount | null>(null);

  const accountIdRef = useRef(activeAccountId);
  const categoryRef = useRef(category);
  const itemsRef = useRef<MailListItem[]>([]);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const listSeq = useRef(0);
  const readerSeq = useRef(0);

  const errorText = useCallback(
    (code?: string | null, detail?: string | null) => {
      const key = `error.${code || "internal_error"}`;
      const text = t(key, { detail: detail ?? "" });
      if (text !== key) return text;
      const fallback = t("error.internal_error");
      return detail ? `${fallback} (${detail})` : fallback;
    },
    [t],
  );

  const notify = useCallback((text: string) => {
    toastRef.current?.(text);
  }, []);

  const applyList = useCallback((result: { items: MailListItem[]; total: number; hasMore: boolean }, reset: boolean) => {
    const next = reset ? result.items : [...itemsRef.current, ...result.items];
    itemsRef.current = next;
    hasMoreRef.current = result.hasMore;
    setItems(next);
    setTotal(result.total);
    setHasMore(result.hasMore);
  }, []);

  const loadList = useCallback(
    async ({ reset, limit }: { reset: boolean; limit?: number }) => {
      const accountId = accountIdRef.current;
      const currentCategory = categoryRef.current;
      const seq = ++listSeq.current;
      if (reset) setLoading(true);
      try {
        const result = await api.mailList({
          accountId,
          category: currentCategory,
          offset: reset ? 0 : itemsRef.current.length,
          limit: limit ?? PAGE_SIZE,
        });
        if (seq !== listSeq.current) return;
        applyList(result, reset);
      } catch {
        if (seq === listSeq.current && reset) {
          applyList({ items: [], total: 0, hasMore: false }, true);
        }
      } finally {
        if (seq === listSeq.current) setLoading(false);
      }
    },
    [applyList],
  );

  const reloadAccounts = useCallback(async () => {
    try {
      const result = await api.mailAccounts();
      setAccounts(result.accounts);
      setUnified(result.unified);
      setAccountsLoaded(true);
      const current = accountIdRef.current;
      if (current !== "unified" && !result.accounts.some((account) => account.id === current)) {
        accountIdRef.current = "unified";
        setActiveAccountId("unified");
      }
    } catch {
      setAccountsLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reloadAccounts();
    let timer = 0;
    const off = api.onMailEvent((event) => {
      if (event.type === "sync-start" || event.type === "sync-error") {
        void reloadAccounts();
        return;
      }
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void reloadAccounts();
        void loadList({ reset: true, limit: Math.max(PAGE_SIZE, itemsRef.current.length) });
      }, 250);
    });
    return () => {
      off();
      if (timer) window.clearTimeout(timer);
    };
  }, [reloadAccounts, loadList]);

  useEffect(() => {
    accountIdRef.current = activeAccountId;
  }, [activeAccountId]);

  useEffect(() => {
    categoryRef.current = category;
  }, [category]);

  useEffect(() => {
    if (!accountsLoaded) return;
    setScreen("list");
    setReader(null);
    setReaderError(null);
    setCompose(null);
    if (!accounts.length) {
      applyList({ items: [], total: 0, hasMore: false }, true);
      return;
    }
    void loadList({ reset: true });
    // 不依赖 accounts.length：同步/加删账户导致的长度变化不应把正在写的信关掉；
    // 首个账户由 completeWizard 显式切换选中并加载。
  }, [activeAccountId, category, accountsLoaded, loadList, applyList]);

  const selectAccount = useCallback((accountId: string) => {
    setScreen("list");
    setReader(null);
    setReaderError(null);
    setCompose(null);
    if (accountIdRef.current === accountId) return;
    accountIdRef.current = accountId;
    setActiveAccountId(accountId);
  }, []);

  const selectCategory = useCallback((next: MailCategory) => {
    setScreen("list");
    setReader(null);
    setReaderError(null);
    setCompose(null);
    if (categoryRef.current === next) return;
    categoryRef.current = next;
    setCategory(next);
  }, []);

  const syncNow = useCallback(() => {
    void api.mailSync({ accountId: accountIdRef.current, category: categoryRef.current });
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      if (hasMoreRef.current) {
        await loadList({ reset: false });
        return;
      }
      const currentCategory = categoryRef.current;
      if (currentCategory === "outbox") return;
      const accountId = accountIdRef.current;
      const previous = itemsRef.current.length;
      await api.mailSync({ accountId, category: currentCategory, extra: 200 });
      const result = await api.mailList({
        accountId,
        category: currentCategory,
        offset: 0,
        limit: previous + PAGE_SIZE,
      });
      applyList(result, true);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [applyList, loadList]);

  const closeReader = useCallback(() => {
    readerSeq.current += 1;
    setScreen("list");
    setReader(null);
    setReaderError(null);
    setReaderLoading(false);
  }, []);

  const openMessage = useCallback(
    async (item: MailListItem) => {
      if (item.kind === "outbox") return;
      if (item.kind === "draft") {
        const result = await api.mailDrafts(item.accountId);
        const draft = result.drafts.find((entry) => entry.id === item.draftId);
        if (!draft) return;
        setCompose({ mode: "draft", accountId: draft.accountId, draft, returnTo: "list" });
        setScreen("compose");
        return;
      }
      if (!item.role || item.uid == null) return;
      const seq = ++readerSeq.current;
      setReader(null);
      setReaderError(null);
      setReaderLoading(true);
      setScreen("reader");
      const result = await api.mailMessage({
        accountId: item.accountId,
        role: item.role,
        uid: item.uid,
        uidValidity: item.uidValidity,
        folder: item.folder,
      });
      if (seq !== readerSeq.current) return;
      setReaderLoading(false);
      if (!result.ok || !result.message) {
        setReaderError(errorText(result.code ?? "internal_error", result.detail));
        return;
      }
      setReader(result.message);
    },
    [errorText],
  );

  const composerAccountId = useCallback(() => {
    if (accountIdRef.current !== "unified") return accountIdRef.current;
    return accounts[0]?.id ?? "";
  }, [accounts]);

  const startCompose = useCallback(
    (ai = false) => {
      const accountId = composerAccountId();
      if (!accountId) {
        setScreen("wizard");
        return;
      }
      setCompose({ mode: "new", accountId, returnTo: "list", ...(ai ? { ai: true } : {}) });
      setScreen("compose");
    },
    [composerAccountId],
  );

  const reply = useCallback(() => {
    if (!reader) return;
    setCompose({
      mode: "reply",
      accountId: reader.accountId ?? composerAccountId(),
      body: reader,
      returnTo: "reader",
    });
    setScreen("compose");
  }, [reader, composerAccountId]);

  const forward = useCallback(() => {
    if (!reader) return;
    setCompose({
      mode: "forward",
      accountId: reader.accountId ?? composerAccountId(),
      body: reader,
      returnTo: "reader",
    });
    setScreen("compose");
  }, [reader, composerAccountId]);

  const closeCompose = useCallback(() => {
    setCompose(null);
    setScreen(compose?.returnTo === "reader" && reader ? "reader" : "list");
  }, [compose, reader]);

  const saveDraft = useCallback(
    async (payload: MailComposePayload) => {
      const result = await api.mailSaveDraft({
        id: payload.draftId,
        accountId: payload.accountId,
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        subject: payload.subject,
        text: payload.text,
        attachments: payload.attachments,
        inReplyTo: payload.inReplyTo,
        references: payload.references,
      });
      if (!result.ok) {
        toastRef.current?.(errorText(result.code, result.detail));
        return false;
      }
      toastRef.current?.(t("compose.saved"));
      closeCompose();
      return true;
    },
    [closeCompose, errorText, t],
  );

  const send = useCallback(
    async (payload: MailComposePayload) => {
      const result = await api.mailSend({
        accountId: payload.accountId,
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        subject: payload.subject,
        text: payload.text,
        attachments: payload.attachments,
        inReplyTo: payload.inReplyTo,
        references: payload.references,
        draftId: payload.draftId,
      });
      if (!result.ok) {
        return { ok: false, error: errorText(result.code, result.detail) };
      }
      toastRef.current?.(t("compose.sent"));
      closeCompose();
      return { ok: true };
    },
    [closeCompose, errorText, t],
  );

  const deleteReader = useCallback(async () => {
    if (!reader?.accountId) return;
    const result = await api.mailDelete({
      accountId: reader.accountId,
      role: reader.role,
      uid: reader.uid,
      uidValidity: reader.uidValidity,
      folder: reader.folder,
    });
    if (!result.ok) {
      toastRef.current?.(errorText(result.code, result.detail));
      return;
    }
    toastRef.current?.(t("reader.deleted"));
    closeReader();
  }, [reader, closeReader, errorText, t]);

  const markUnread = useCallback(async () => {
    if (!reader?.accountId) return;
    const result = await api.mailSetSeen({
      items: [
        {
          accountId: reader.accountId,
          role: reader.role,
          uid: reader.uid,
          uidValidity: reader.uidValidity,
          folder: reader.folder,
        },
      ],
      seen: false,
    });
    if (!result.ok) {
      toastRef.current?.(errorText(result.code, result.detail));
      return;
    }
    toastRef.current?.(t("reader.markedUnread"));
    closeReader();
  }, [reader, closeReader, errorText, t]);

  const downloadAttachment = useCallback(
    async (index: number) => {
      if (!reader?.accountId) return;
      const result = await api.mailDownloadAttachment({
        accountId: reader.accountId,
        role: reader.role,
        uid: reader.uid,
        uidValidity: reader.uidValidity,
        folder: reader.folder,
        index,
      });
      if (!result.ok) {
        toastRef.current?.(errorText(result.code, result.detail));
        return;
      }
      toastRef.current?.(
        result.canceled ? t("reader.downloadCanceled") : t("reader.downloaded"),
      );
    },
    [reader, errorText, t],
  );

  const startAddAccount = useCallback(() => {
    setWizardAccount(null);
    setScreen("wizard");
  }, []);

  const editAccount = useCallback((account: MailAccount) => {
    setWizardAccount(account);
    setScreen("wizard");
  }, []);

  const closeWizard = useCallback(() => {
    setWizardAccount(null);
    setScreen(accounts.length ? "list" : "wizard");
  }, [accounts.length]);

  const completeWizard = useCallback(
    async (accountId?: string) => {
      setWizardAccount(null);
      await reloadAccounts();
      if (accountId) {
        accountIdRef.current = accountId;
        setActiveAccountId(accountId);
        categoryRef.current = "inbox";
        setCategory("inbox");
      }
      setScreen("list");
      void loadList({ reset: true });
    },
    [loadList, reloadAccounts],
  );

  const removeAccount = useCallback(
    async (accountId: string) => {
      const result = await api.mailRemoveAccount(accountId);
      if (!result.ok) return;
      if (accountIdRef.current === accountId) {
        accountIdRef.current = "unified";
        setActiveAccountId("unified");
      }
      await reloadAccounts();
    },
    [reloadAccounts],
  );

  const retryOutbox = useCallback(
    async (id: string) => {
      await api.mailRetryOutbox(id);
      await loadList({ reset: true, limit: Math.max(PAGE_SIZE, itemsRef.current.length) });
    },
    [loadList],
  );

  const removeOutbox = useCallback(
    async (id: string) => {
      await api.mailRemoveOutbox(id);
      await loadList({ reset: true, limit: Math.max(PAGE_SIZE, itemsRef.current.length) });
    },
    [loadList],
  );

  const activeAccount = accounts.find((account) => account.id === activeAccountId) ?? null;
  const counts =
    activeAccountId === "unified" ? unified : activeAccount?.counts ?? EMPTY_COUNTS;
  const syncing =
    activeAccountId === "unified"
      ? accounts.some((account) => account.syncing)
      : Boolean(activeAccount?.syncing);
  const effectiveScreen: MailScreen =
    accountsLoaded && accounts.length === 0 ? "wizard" : screen;

  const value = useMemo<MailContextValue>(
    () => ({
      accounts,
      accountsLoaded,
      unified,
      activeAccountId,
      activeAccount,
      category,
      counts,
      items,
      total,
      hasMore,
      loading,
      loadingMore,
      syncing,
      screen: effectiveScreen,
      reader,
      readerLoading,
      readerError,
      compose,
      wizardAccount,
      errorText,
      notify,
      aiProviderId,
      selectAccount,
      selectCategory,
      syncNow,
      loadMore,
      openMessage,
      closeReader,
      startCompose,
      reply,
      forward,
      closeCompose,
      saveDraft,
      send,
      deleteReader,
      markUnread,
      downloadAttachment,
      startAddAccount,
      editAccount,
      closeWizard,
      completeWizard,
      removeAccount,
      retryOutbox,
      removeOutbox,
    }),
    [
      accounts,
      accountsLoaded,
      unified,
      activeAccountId,
      activeAccount,
      category,
      counts,
      items,
      total,
      hasMore,
      loading,
      loadingMore,
      syncing,
      effectiveScreen,
      reader,
      readerLoading,
      readerError,
      compose,
      wizardAccount,
      errorText,
      notify,
      aiProviderId,
      selectAccount,
      selectCategory,
      syncNow,
      loadMore,
      openMessage,
      closeReader,
      startCompose,
      reply,
      forward,
      closeCompose,
      saveDraft,
      send,
      deleteReader,
      markUnread,
      downloadAttachment,
      startAddAccount,
      editAccount,
      closeWizard,
      completeWizard,
      removeAccount,
      retryOutbox,
      removeOutbox,
    ],
  );

  return <MailContext.Provider value={value}>{children}</MailContext.Provider>;
}
