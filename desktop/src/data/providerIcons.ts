import type { IconType } from "react-icons";
import {
  SiCloudflare,
  SiCloudflareworkers,
  SiGithubcopilot,
  SiGooglegemini,
  SiGooglecloud,
  SiHuggingface,
  SiMeta,
  SiMistralai,
  SiNvidia,
  SiQwen,
  SiVercel,
  SiXiaomi,
} from "react-icons/si";
import { TbBrandAws, TbBrandAzure } from "react-icons/tb";
import alibabaCloud from "../assets/provider-icons/model-provider-alibaba-cloud.png";
import anthropic from "../assets/provider-icons/model-provider-anthropic.png";
import bigmodel from "../assets/provider-icons/logo-bigmodel.svg";
import deepseek from "../assets/provider-icons/model-provider-deepseek.png";
import minimax from "../assets/provider-icons/model-provider-minimax.png";
import moonshotKimi from "../assets/provider-icons/model-provider-moonshot-kimi.png";
import openai from "../assets/provider-icons/model-provider-openai.png";
import opencodeDark from "../assets/provider-icons/model-provider-opencode-dark.svg";
import opencodeLight from "../assets/provider-icons/model-provider-opencode-light.svg";
import openrouterDark from "../assets/provider-icons/model-provider-openrouter-dark.svg";
import openrouterLight from "../assets/provider-icons/model-provider-openrouter-light.svg";
import xai from "../assets/provider-icons/model-provider-xai.png";
import xiaomiMimo from "../assets/provider-icons/model-provider-xiaomi-mimo.png";
import zai from "../assets/provider-icons/model-provider-zai.png";
import appIcon from "../assets/icon.png";

/**
 * 服务商图标。
 *
 * ZCode 的图标资源是混合的，实测（逐个采样）分三类：
 *  - **彩色标**：alibaba / deepseek / minimax / bigmodel —— 两个主题都能用，不动。
 *  - **单色黑标**（透明底 + 纯黑）：zai / moonshot-kimi / xai / xiaomi-mimo —— 深色主题下会看不见，
 *    需要 `filter: invert(1)`。
 *  - **浅底黑标**（自带浅色不透明底 + 黑标）：anthropic / openai —— 同样在深色主题下反色，
 *    反色后浅底变深底、黑标变白标，正好融进深色底。
 *  - **明暗成对**：opencode / openrouter —— 按主题直接选对应文件。
 *
 * 没有图片资源的服务商用 Simple Icons / Tabler 的单色字形（currentColor，两个主题都自适应）；
 * 连品牌字形都拿不到的（Baseten / Cerebras / Fireworks / Groq / Radius / Together 等）
 * 用品牌色字母标 —— 因此目录里每个服务商都有图标。
 */
export type ProviderIcon =
  | { kind: "img"; src: string; invert: boolean }
  | { kind: "glyph"; Icon: IconType }
  /** 品牌色字母标：拿不到品牌图形时直接用品牌色首字母（无底色） */
  | { kind: "letter"; text: string; color: string };

type IconSpec =
  | { kind: "single"; src: string; invertOnDark?: boolean }
  | { kind: "paired"; light: string; dark: string }
  | { kind: "glyph"; Icon: IconType }
  | { kind: "letter"; text: string; color: string };

const ICONS: Record<string, IconSpec> = {
  // 彩色标
  "alibaba-model-studio": { kind: "single", src: alibabaCloud },
  deepseek: { kind: "single", src: deepseek },
  minimax: { kind: "single", src: minimax },
  bigmodel: { kind: "single", src: bigmodel },
  // 单色标（深色主题反色）
  zai: { kind: "single", src: zai, invertOnDark: true },
  "moonshot-kimi": { kind: "single", src: moonshotKimi, invertOnDark: true },
  xai: { kind: "single", src: xai, invertOnDark: true },
  "xiaomi-mimo": { kind: "single", src: xiaomiMimo, invertOnDark: true },
  anthropic: { kind: "single", src: anthropic, invertOnDark: true },
  openai: { kind: "single", src: openai, invertOnDark: true },
  // 明暗成对
  opencode: { kind: "paired", light: opencodeLight, dark: opencodeDark },
  openrouter: { kind: "paired", light: openrouterLight, dark: openrouterDark },
  // 单色字形（Simple Icons / Tabler，currentColor 自适应主题）
  aws: { kind: "glyph", Icon: TbBrandAws },
  azure: { kind: "glyph", Icon: TbBrandAzure },
  cloudflare: { kind: "glyph", Icon: SiCloudflare },
  "cloudflare-workers": { kind: "glyph", Icon: SiCloudflareworkers },
  "github-copilot": { kind: "glyph", Icon: SiGithubcopilot },
  "google-gemini": { kind: "glyph", Icon: SiGooglegemini },
  "google-cloud": { kind: "glyph", Icon: SiGooglecloud },
  huggingface: { kind: "glyph", Icon: SiHuggingface },
  meta: { kind: "glyph", Icon: SiMeta },
  mistral: { kind: "glyph", Icon: SiMistralai },
  nvidia: { kind: "glyph", Icon: SiNvidia },
  qwen: { kind: "glyph", Icon: SiQwen },
  vercel: { kind: "glyph", Icon: SiVercel },
  xiaomi: { kind: "glyph", Icon: SiXiaomi },
  // 品牌图形拿不到的 → 品牌色字母标（颜色取各家品牌的近似主色）
  "ant-ling": { kind: "letter", text: "A", color: "#1677ff" }, // 蚂蚁蓝
  baseten: { kind: "letter", text: "B", color: "#6366f1" }, // indigo
  cerebras: { kind: "letter", text: "C", color: "#f97316" }, // 橙
  fireworks: { kind: "letter", text: "F", color: "#ff4a00" }, // 焰橙
  groq: { kind: "letter", text: "G", color: "#f55036" }, // Groq 橙
  radius: { kind: "letter", text: "R", color: "#a855f7" }, // 紫
  together: { kind: "letter", text: "T", color: "#2563eb" }, // 蓝
  typesafe: { kind: "letter", text: "T", color: "#10b981" }, // 绿
  // 自定义服务商入口：用 MeowCode 应用 Logo
  custom: { kind: "single", src: appIcon },
};

export function providerIcon(key: string | undefined, theme: "light" | "dark"): ProviderIcon | undefined {
  if (!key) return undefined;
  const spec = ICONS[key];
  if (!spec) return undefined;
  if (spec.kind === "glyph") return { kind: "glyph", Icon: spec.Icon };
  if (spec.kind === "letter") return { kind: "letter", text: spec.text, color: spec.color };
  if (spec.kind === "paired") {
    return { kind: "img", src: theme === "dark" ? spec.dark : spec.light, invert: false };
  }
  return { kind: "img", src: spec.src, invert: theme === "dark" && Boolean(spec.invertOnDark) };
}
