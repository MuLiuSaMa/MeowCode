import type { IconType } from "react-icons";
import {
  SiCloudflare,
  SiCloudflareworkers,
  SiGithub,
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
import aihubmix from "../assets/provider-icons/model-provider-aihubmix.png";
import baichuan from "../assets/provider-icons/model-provider-baichuan.png";
import cohere from "../assets/provider-icons/model-provider-cohere.png";
import deepinfra from "../assets/provider-icons/model-provider-deepinfra.png";
import doubao from "../assets/provider-icons/model-provider-doubao.png";
import giteeai from "../assets/provider-icons/model-provider-giteeai.png";
import hunyuan from "../assets/provider-icons/model-provider-hunyuan.png";
import lmstudioLight from "../assets/provider-icons/model-provider-lmstudio.png";
import lmstudioDark from "../assets/provider-icons/model-provider-lmstudio-dark.png";
import modelscope from "../assets/provider-icons/model-provider-modelscope.png";
import novita from "../assets/provider-icons/model-provider-novita.png";
import ollamaLight from "../assets/provider-icons/model-provider-ollama.png";
import ollamaDark from "../assets/provider-icons/model-provider-ollama-dark.png";
import perplexity from "../assets/provider-icons/model-provider-perplexity.png";
import ppio from "../assets/provider-icons/model-provider-ppio.png";
import sensenova from "../assets/provider-icons/model-provider-sensenova.png";
import siliconcloud from "../assets/provider-icons/model-provider-siliconcloud.png";
import spark from "../assets/provider-icons/model-provider-spark.png";
import stepfun from "../assets/provider-icons/model-provider-stepfun.png";
import volcengine from "../assets/provider-icons/model-provider-volcengine.webp";
import wenxin from "../assets/provider-icons/model-provider-wenxin.png";
import appIcon from "../assets/icon.png";
// OpenCode 的服务商品牌 SVG（单色黑标，深色主题反色）
import baseten from "../assets/provider-icons/model-provider-baseten.svg";
import cerebras from "../assets/provider-icons/model-provider-cerebras.svg";
import digitalocean from "../assets/provider-icons/model-provider-digitalocean.svg";
import fireworks from "../assets/provider-icons/model-provider-fireworks.svg";
import groq from "../assets/provider-icons/model-provider-groq.svg";
import togetherai from "../assets/provider-icons/model-provider-togetherai.svg";
import venice from "../assets/provider-icons/model-provider-venice.svg";

/**
 * 服务商图标。目录里每个服务商都必须有品牌图形，拿不到图形的服务商直接从目录删除。
 *
 * 图片资源分两类来源：
 *  - ZCode 自带图标（alibaba / deepseek / minimax / bigmodel / zai / moonshot-kimi / …）
 *  - LobeChat 的 @lobehub/icons-static-png 彩色标（siliconcloud / doubao / hunyuan / …）
 *
 * 实测（逐个采样）分三类：
 *  - **彩色标**：alibaba / deepseek / minimax / bigmodel 及 lobehub 彩色标 —— 两个主题都能用，不动。
 *  - **单色黑标**（透明底 + 纯黑）：zai / moonshot-kimi / xai / xiaomi-mimo —— 深色主题下会看不见，
 *    需要 `filter: invert(1)`。
 *  - **浅底黑标**（自带浅色不透明底 + 黑标）：anthropic / openai —— 同样在深色主题下反色，
 *    反色后浅底变深底、黑标变白标，正好融进深色底。
 *  - **明暗成对**：opencode / openrouter / ollama / lmstudio —— 按主题直接选对应文件。
 *
 * 没有图片资源的服务商用 Simple Icons / Tabler 的单色字形（currentColor，两个主题都自适应）。
 */
export type ProviderIcon =
  | { kind: "img"; src: string; invert: boolean }
  | { kind: "glyph"; Icon: IconType };

type IconSpec =
  | { kind: "single"; src: string; invertOnDark?: boolean }
  | { kind: "paired"; light: string; dark: string }
  | { kind: "glyph"; Icon: IconType };

const ICONS: Record<string, IconSpec> = {
  // 彩色标
  "alibaba-model-studio": { kind: "single", src: alibabaCloud },
  deepseek: { kind: "single", src: deepseek },
  minimax: { kind: "single", src: minimax },
  bigmodel: { kind: "single", src: bigmodel },
  // lobehub 彩色标（@lobehub/icons-static-png）
  siliconcloud: { kind: "single", src: siliconcloud },
  doubao: { kind: "single", src: doubao },
  volcengine: { kind: "single", src: volcengine },
  hunyuan: { kind: "single", src: hunyuan },
  spark: { kind: "single", src: spark },
  baichuan: { kind: "single", src: baichuan },
  stepfun: { kind: "single", src: stepfun },
  sensenova: { kind: "single", src: sensenova },
  wenxin: { kind: "single", src: wenxin },
  modelscope: { kind: "single", src: modelscope },
  giteeai: { kind: "single", src: giteeai },
  perplexity: { kind: "single", src: perplexity },
  cohere: { kind: "single", src: cohere },
  deepinfra: { kind: "single", src: deepinfra },
  novita: { kind: "single", src: novita },
  aihubmix: { kind: "single", src: aihubmix },
  ppio: { kind: "single", src: ppio },
  // 单色标（深色主题反色）
  zai: { kind: "single", src: zai, invertOnDark: true },
  "moonshot-kimi": { kind: "single", src: moonshotKimi, invertOnDark: true },
  xai: { kind: "single", src: xai, invertOnDark: true },
  "xiaomi-mimo": { kind: "single", src: xiaomiMimo, invertOnDark: true },
  anthropic: { kind: "single", src: anthropic, invertOnDark: true },
  openai: { kind: "single", src: openai, invertOnDark: true },
  // OpenCode 品牌 SVG：同样是单色黑标
  groq: { kind: "single", src: groq, invertOnDark: true },
  cerebras: { kind: "single", src: cerebras, invertOnDark: true },
  togetherai: { kind: "single", src: togetherai, invertOnDark: true },
  fireworks: { kind: "single", src: fireworks, invertOnDark: true },
  baseten: { kind: "single", src: baseten, invertOnDark: true },
  digitalocean: { kind: "single", src: digitalocean, invertOnDark: true },
  venice: { kind: "single", src: venice, invertOnDark: true },
  // 明暗成对
  opencode: { kind: "paired", light: opencodeLight, dark: opencodeDark },
  openrouter: { kind: "paired", light: openrouterLight, dark: openrouterDark },
  ollama: { kind: "paired", light: ollamaLight, dark: ollamaDark },
  lmstudio: { kind: "paired", light: lmstudioLight, dark: lmstudioDark },
  // 单色字形（Simple Icons / Tabler，currentColor 自适应主题）
  aws: { kind: "glyph", Icon: TbBrandAws },
  azure: { kind: "glyph", Icon: TbBrandAzure },
  cloudflare: { kind: "glyph", Icon: SiCloudflare },
  "cloudflare-workers": { kind: "glyph", Icon: SiCloudflareworkers },
  "github-copilot": { kind: "glyph", Icon: SiGithubcopilot },
  "github-models": { kind: "glyph", Icon: SiGithub },
  "google-gemini": { kind: "glyph", Icon: SiGooglegemini },
  "google-cloud": { kind: "glyph", Icon: SiGooglecloud },
  huggingface: { kind: "glyph", Icon: SiHuggingface },
  meta: { kind: "glyph", Icon: SiMeta },
  mistral: { kind: "glyph", Icon: SiMistralai },
  nvidia: { kind: "glyph", Icon: SiNvidia },
  qwen: { kind: "glyph", Icon: SiQwen },
  vercel: { kind: "glyph", Icon: SiVercel },
  xiaomi: { kind: "glyph", Icon: SiXiaomi },
  // 自定义服务商入口：用 MeowCode 应用 Logo
  custom: { kind: "single", src: appIcon },
};

export function providerIcon(key: string | undefined, theme: "light" | "dark"): ProviderIcon | undefined {
  if (!key) return undefined;
  const spec = ICONS[key];
  if (!spec) return undefined;
  if (spec.kind === "glyph") return { kind: "glyph", Icon: spec.Icon };
  if (spec.kind === "paired") {
    return { kind: "img", src: theme === "dark" ? spec.dark : spec.light, invert: false };
  }
  return { kind: "img", src: spec.src, invert: theme === "dark" && Boolean(spec.invertOnDark) };
}

/** 模型品牌 → 图标 key（模型列表显示的是模型 Logo，不是服务商 Logo）。 */
const MODEL_ICON_PREFIXES: Array<readonly [readonly string[], string]> = [
  [["deepseek"], "deepseek"],
  [["glm", "charglm", "codegeex", "emohaa"], "zai"],
  [["mimo"], "xiaomi-mimo"],
  [["kimi", "moonshot"], "moonshot-kimi"],
  [["qwen", "qwq", "qvq"], "qwen"],
  [["claude"], "anthropic"],
  [["gpt", "chatgpt", "codex", "o1", "o2", "o3", "o4"], "openai"],
  [["gemini", "gemma"], "google-gemini"],
  [["grok"], "xai"],
  [["mistral", "mixtral", "codestral", "devstral", "magistral"], "mistral"],
  [["llama"], "meta"],
  [["doubao", "seed"], "doubao"],
  [["hunyuan"], "hunyuan"],
  [["spark", "xinghuo"], "spark"],
  [["ernie", "wenxin"], "wenxin"],
  [["minimax", "abab"], "minimax"],
  [["step"], "stepfun"],
  [["sense"], "sensenova"],
  [["command"], "cohere"],
  [["sonar", "perplexity"], "perplexity"],
  [["nemotron"], "nvidia"],
  [["copilot"], "github-copilot"],
  [["baichuan"], "baichuan"],
  [["nova"], "aws"],
  [["cloudflare"], "cloudflare"],
];

/** 按模型名识别品牌图标；聚合平台前缀（openrouter 的 `vendor/model`）取最后一段。 */
export function modelIconKey(model: string): string | undefined {
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return undefined;
  const bare = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  for (const [prefixes, iconKey] of MODEL_ICON_PREFIXES) {
    if (prefixes.some((prefix) => bare.startsWith(prefix))) return iconKey;
  }
  return undefined;
}
