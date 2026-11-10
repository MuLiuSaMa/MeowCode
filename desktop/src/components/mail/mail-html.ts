import DOMPurify from "dompurify";

export function hasRemoteImages(html: string): boolean {
  return /<img\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i.test(html);
}

export type MailHtmlColors = {
  background: string;
  foreground: string;
  accent: string;
  border: string;
  fontFamily: string;
};

export function buildMailSrcDoc(
  html: string,
  allowImages: boolean,
  colors: MailHtmlColors,
): string {
  // srcdoc 的基准地址继承父页面：打包后是 file://，协议相对地址会解析失败；统一补 https
  const normalized = html
    .replace(/(\b(?:src|href)\s*=\s*["'])\/\//gi, "$1https://")
    .replace(/<img\b[^>]*\bsrc\s*=\s*["']cid:[^"']*["'][^>]*>/gi, "");
  const clean = DOMPurify.sanitize(normalized, {
    FORBID_TAGS: [
      "script",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "form",
      "input",
      "textarea",
      "select",
      "button",
      "link",
      "meta",
      "base",
    ],
    FORBID_ATTR: ["srcdoc", "formaction"],
  });
  const imageSources = allowImages ? "https: http: data:" : "data:";
  const csp = [
    "default-src 'none'",
    `img-src ${imageSources}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
  ].join("; ");
  const baseStyle = `
    html,body{margin:0;padding:0;background:${colors.background};}
    body{
      padding:16px 20px 22px;
      font-family:${colors.fontFamily};
      font-size:14px;line-height:1.65;color:${colors.foreground};
      word-wrap:break-word;overflow-wrap:anywhere;
    }
    a{color:${colors.accent};text-decoration:underline;}
    img{max-width:100%;height:auto;}
    table{max-width:100%;border-collapse:collapse;}
    pre{white-space:pre-wrap;word-wrap:break-word;}
    blockquote{margin:8px 0;padding-left:12px;border-left:2px solid ${colors.border};color:${colors.foreground};}
    hr{border:none;border-top:1px solid ${colors.border};}
  `;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${baseStyle}</style></head><body>${clean}</body></html>`;
}
