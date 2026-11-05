declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt, options?: { enabled?: boolean; label?: boolean; labelAfter?: boolean }) => void;
  export default plugin;
}

declare module "markdown-it-abbr" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module "markdown-it-container" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt, name: string, options?: Record<string, unknown>) => void;
  export default plugin;
}

declare module "markdown-it-deflist" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module "markdown-it-footnote" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module "markdown-it-implicit-figures" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt, options?: { figcaption?: boolean; link?: boolean; dataType?: boolean }) => void;
  export default plugin;
}

declare module "markdown-it-ins" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module "markdown-it-link-attributes" {
  import type MarkdownIt from "markdown-it";
  const plugin: (
    md: MarkdownIt,
    options?: {
      matcher?: (href: string) => boolean;
      attrs?: Record<string, string>;
    },
  ) => void;
  export default plugin;
}

declare module "markdown-it-mark" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module "markdown-it-sub" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module "markdown-it-sup" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module "markdown-it-texmath" {
  import type MarkdownIt from "markdown-it";
  const plugin: (
    md: MarkdownIt,
    options?: {
      engine: unknown;
      delimiters?: string | string[];
      katexOptions?: Record<string, unknown>;
      outerSpace?: boolean;
    },
  ) => void;
  export default plugin;
}

declare module "markdown-it-emoji" {
  import type MarkdownIt from "markdown-it";
  export const full: (md: MarkdownIt) => void;
  export const light: (md: MarkdownIt) => void;
  export const bare: (md: MarkdownIt) => void;
}
