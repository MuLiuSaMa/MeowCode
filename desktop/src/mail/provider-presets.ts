export type MailPreset = {
  key: string;
  domains: string[];
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpRequireTLS: boolean;
};

export const MAIL_PRESETS: MailPreset[] = [
  {
    key: "qq",
    domains: ["qq.com", "vip.qq.com", "foxmail.com"],
    imapHost: "imap.qq.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.qq.com",
    smtpPort: 465,
    smtpSecure: true,
    smtpRequireTLS: false,
  },
  {
    key: "netease163",
    domains: ["163.com"],
    imapHost: "imap.163.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.163.com",
    smtpPort: 465,
    smtpSecure: true,
    smtpRequireTLS: false,
  },
  {
    key: "netease126",
    domains: ["126.com"],
    imapHost: "imap.126.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.126.com",
    smtpPort: 465,
    smtpSecure: true,
    smtpRequireTLS: false,
  },
  {
    key: "icloud",
    domains: ["icloud.com", "me.com", "mac.com"],
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecure: false,
    smtpRequireTLS: true,
  },
  {
    key: "exmail",
    domains: ["exmail.qq.com"],
    imapHost: "imap.exmail.qq.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.exmail.qq.com",
    smtpPort: 465,
    smtpSecure: true,
    smtpRequireTLS: false,
  },
  {
    key: "custom",
    domains: [],
    imapHost: "",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "",
    smtpPort: 465,
    smtpSecure: true,
    smtpRequireTLS: false,
  },
];

export function presetByKey(key: string | undefined): MailPreset | null {
  return MAIL_PRESETS.find((preset) => preset.key === key) ?? null;
}

export function presetForEmail(email: string): MailPreset | null {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return null;
  return MAIL_PRESETS.find((preset) => preset.domains.includes(domain)) ?? null;
}
