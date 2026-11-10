export type MailRole = "inbox" | "sent" | "drafts" | "trash" | "junk";
export type MailCategory =
  | "all"
  | "inbox"
  | "unread"
  | "drafts"
  | "outbox"
  | "sent"
  | "trash"
  | "junk";

export type MailFolderRoles = Record<MailRole, string | null>;

export type MailServer = {
  host: string;
  port: number;
  secure: boolean;
  requireTLS?: boolean;
};

export type MailSyncState = {
  intervalMinutes: number;
  lastSyncAt: string | null;
  lastError: string | null;
  backoffUntil: number | null;
};

export type MailCounts = Record<MailCategory, number>;

export type MailAccount = {
  id: string;
  provider: string;
  email: string;
  displayName: string;
  imap: MailServer;
  smtp: MailServer;
  folderRoles: MailFolderRoles;
  sync: MailSyncState;
  hasPassword: boolean;
  passwordOk: boolean;
  createdAt: string;
  counts?: MailCounts;
  syncing?: boolean;
};

export type MailAccountInput = {
  id?: string;
  provider: string;
  email: string;
  displayName: string;
  imap: MailServer;
  smtp: MailServer;
  folderRoles?: Partial<MailFolderRoles>;
  sync?: { intervalMinutes?: number };
};

export type MailFolder = {
  path: string;
  name: string;
  specialUse: string | null;
  role: MailRole | null;
};

export type MailAttachmentMeta = {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  related?: boolean;
  /** cid 内嵌图（已转 data URL 渲染），不在附件列表重复展示 */
  inline?: boolean;
};

export type MailDraftAttachment = {
  path: string;
  name: string;
  size: number;
};

export type MailListItem = {
  kind: "message" | "draft" | "outbox";
  id: string;
  accountId: string;
  role?: MailRole;
  uid?: number;
  uidValidity?: number;
  folder?: string;
  draftId?: string;
  outboxId?: string;
  subject: string;
  fromName?: string;
  fromAddr?: string;
  to: string[];
  date: string;
  sortAt?: number;
  seen?: boolean;
  hasAttachments?: boolean;
  snippet?: string;
  serverDraft?: boolean;
  status?: string;
  lastError?: string | null;
  attempts?: number;
};

export type MailListResult = {
  items: MailListItem[];
  total: number;
  hasMore: boolean;
};

export type MailAccountsResult = {
  accounts: MailAccount[];
  unified: MailCounts;
};

export type MailBody = {
  uid: number;
  uidValidity: number;
  role: MailRole;
  folder: string;
  messageId: string;
  subject: string;
  from: { name: string; address: string };
  to: string[];
  cc: string[];
  date: string;
  text: string;
  html: string | null;
  attachments: MailAttachmentMeta[];
  inReplyTo: string | null;
  references: string | null;
  snippet?: string;
  accountId?: string;
};

export type MailDraft = {
  id: string;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachments: MailDraftAttachment[];
  inReplyTo: string | null;
  references: string | null;
  updatedAt: string;
};

export type MailOutboxPayload = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachments: MailDraftAttachment[];
  inReplyTo: string | null;
  references: string | null;
};

export type MailOutboxEntry = {
  id: string;
  accountId: string;
  status: "queued" | "sending" | "sent" | "failed";
  attempts: number;
  lastError: string | null;
  smtpOk: boolean;
  payload: MailOutboxPayload;
  createdAt: string;
  updatedAt: string;
};

export type MailEvent = {
  type:
    | "sync-start"
    | "sync-done"
    | "sync-error"
    | "counts-changed"
    | "drafts-changed"
    | "outbox-changed"
    | "account-changed";
  accountId?: string;
  code?: string;
  detail?: string;
  warnings?: number;
};

export type MailError = {
  ok: false;
  code: string;
  detail?: string;
};

export type MailImapTestResult = {
  ok: boolean;
  code?: string;
  detail?: string;
  roles?: MailFolderRoles;
  folders?: MailFolder[];
};

export type MailSmtpTestResult = {
  ok: boolean;
  code?: string;
  detail?: string;
};

export type MailAccountTestPayload = {
  accountId?: string;
  account?: MailAccountInput;
  password?: string;
};

export type MailAccountTestResult = {
  ok: boolean;
  code?: string;
  detail?: string;
  imap?: MailImapTestResult;
  smtp?: MailSmtpTestResult;
};

export type MailAccountSavePayload = {
  account: MailAccountInput;
  password?: string;
};

export type MailAccountSaveResult = {
  ok: boolean;
  code?: string;
  detail?: string;
  account?: MailAccount;
};

export type MailSyncResultItem = {
  accountId: string;
  ok: boolean;
  code: string | null;
  detail: string | null;
  warnings: number;
};

export type MailSyncResult = {
  ok: boolean;
  code?: string;
  detail?: string;
  results?: MailSyncResultItem[];
};

export type MailSyncPayload = {
  accountId: string;
  category?: MailCategory;
  extra?: number;
};

export type MailMessagePayload = {
  accountId: string;
  role: MailRole;
  uid: number;
  uidValidity?: number;
  folder?: string;
};

export type MailMessageResult = {
  ok: boolean;
  code?: string;
  detail?: string;
  message?: MailBody;
};

export type MailSeenPayload = {
  items: Array<{
    accountId: string;
    role: MailRole;
    uid: number;
    uidValidity?: number;
    folder?: string;
  }>;
  seen: boolean;
};

export type MailDeletePayload = {
  accountId: string;
  role: MailRole;
  uid: number;
  uidValidity?: number;
  folder?: string;
};

export type MailDeleteResult = {
  ok: boolean;
  code?: string;
  detail?: string;
  permanent?: boolean;
};

export type MailAttachmentDownloadPayload = {
  accountId: string;
  role: MailRole;
  uid: number;
  uidValidity?: number;
  folder?: string;
  index: number;
};

export type MailAttachmentDownloadResult = {
  ok: boolean;
  code?: string;
  detail?: string;
  canceled?: boolean;
  path?: string;
  filename?: string;
  size?: number;
};

export type MailSendPayload = {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  attachments?: MailDraftAttachment[];
  inReplyTo?: string | null;
  references?: string | null;
  draftId?: string;
};

export type MailSendResult = {
  ok: boolean;
  code?: string;
  detail?: string;
  outboxId?: string;
};

export type MailDraftSaveResult = {
  ok: boolean;
  code?: string;
  detail?: string;
  draft?: MailDraft;
};

export type MailDraftsListResult = {
  drafts: MailDraft[];
};

export type MailOutboxListResult = {
  items: MailOutboxEntry[];
};

export type MailOutboxResult = {
  ok: boolean;
  code?: string;
  detail?: string;
};

export type MailPickAttachmentsResult = {
  ok: boolean;
  files: MailDraftAttachment[];
  canceled?: boolean;
};

export type MailListPayload = {
  accountId: string;
  category: MailCategory;
  offset?: number;
  limit?: number;
};
