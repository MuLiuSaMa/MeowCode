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
import claude from "../assets/provider-icons/model-provider-claude.svg";
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
import grok from "../assets/provider-icons/model-provider-grok.png";
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
// 小众 / 国产模型的品牌标（@lobehub/icons-static-svg）
import longcatLight from "../assets/provider-icons/model-provider-longcat.svg";
import longcatDark from "../assets/provider-icons/model-provider-longcat-dark.svg";
import yiLight from "../assets/provider-icons/model-provider-yi.svg";
import yiDark from "../assets/provider-icons/model-provider-yi-dark.svg";
import internlm from "../assets/provider-icons/model-provider-internlm.svg";
import skywork from "../assets/provider-icons/model-provider-skywork.svg";
import tiangong from "../assets/provider-icons/model-provider-tiangong.svg";
import ling from "../assets/provider-icons/model-provider-ling.svg";
import codegeex from "../assets/provider-icons/model-provider-codegeex.svg";
import rwkv from "../assets/provider-icons/model-provider-rwkv.svg";
import upstage from "../assets/provider-icons/model-provider-upstage.svg";
import snowflake from "../assets/provider-icons/model-provider-snowflake.svg";
import microsoft from "../assets/provider-icons/model-provider-microsoft.svg";
import aya from "../assets/provider-icons/model-provider-aya.svg";
import baaiLight from "../assets/provider-icons/model-provider-baai.svg";
import baaiDark from "../assets/provider-icons/model-provider-baai-dark.svg";
import ai21Light from "../assets/provider-icons/model-provider-ai21.svg";
import ai21Dark from "../assets/provider-icons/model-provider-ai21-dark.svg";
import rekaLight from "../assets/provider-icons/model-provider-reka.svg";
import rekaDark from "../assets/provider-icons/model-provider-reka-dark.svg";
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
 * 图片资源分三类来源：
 *  - ZCode 自带图标（alibaba / deepseek / minimax / bigmodel / zai / moonshot-kimi / …）
 *  - LobeChat 的 @lobehub/icons-static-png 彩色标（siliconcloud / doubao / hunyuan / …）
 *  - LobeChat 的 @lobehub/icons-static-svg（longcat / yi / internlm / skywork / … 这些小众模型，
 *    原文件用 currentColor，经 <img> 加载时恒为黑色，已固化成明暗两份）
 *
 * 实测（逐个采样）分三类：
 *  - **彩色标**：alibaba / deepseek / minimax / bigmodel 及 lobehub 彩色标 —— 两个主题都能用，不动。
 *  - **单色黑标**（透明底 + 纯黑）：zai / moonshot-kimi / xai / xiaomi-mimo —— 深色主题下会看不见，
 *    需要 `filter: invert(1)`。
 *  - **浅底黑标**（自带浅色不透明底 + 黑标）：anthropic / openai —— 同样在深色主题下反色，
 *    反色后浅底变深底、黑标变白标，正好融进深色底。
 *  - **明暗成对**：opencode / openrouter / ollama / lmstudio / longcat / yi / baai / ai21 / reka
 *    —— 按主题直接选对应文件。
 *
 * 没有图片资源的服务商用 Simple Icons / Tabler 的单色字形（currentColor，两个主题都自适应）。
 * 认不出品牌的**模型**统一退回 `meow`（MeowCode 自己的应用图标）。
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
  // Claude 品牌标（珊瑚色星芒）：和 Anthropic 的企业标分开，
  // 模型列表里 Claude 用它，服务商列表才用 anthropic
  claude: { kind: "single", src: claude },
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
  // Grok 品牌标（白字黑底），模型列表用；服务商仍用 xai 的企业标
  grok: { kind: "single", src: grok },
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
  // 小众 / 国产模型品牌标（@lobehub/icons-static-svg）
  // 有 currentColor 的标已固化成明暗两份，避免 <img> 里 currentColor 恒为黑色
  longcat: { kind: "paired", light: longcatLight, dark: longcatDark },
  yi: { kind: "paired", light: yiLight, dark: yiDark },
  baai: { kind: "paired", light: baaiLight, dark: baaiDark },
  ai21: { kind: "paired", light: ai21Light, dark: ai21Dark },
  reka: { kind: "paired", light: rekaLight, dark: rekaDark },
  internlm: { kind: "single", src: internlm },
  skywork: { kind: "single", src: skywork },
  tiangong: { kind: "single", src: tiangong },
  ling: { kind: "single", src: ling },
  codegeex: { kind: "single", src: codegeex },
  rwkv: { kind: "single", src: rwkv },
  upstage: { kind: "single", src: upstage },
  snowflake: { kind: "single", src: snowflake },
  microsoft: { kind: "single", src: microsoft },
  aya: { kind: "single", src: aya },
  // 自定义服务商入口：用 MeowCode 应用 Logo
  custom: { kind: "single", src: appIcon },
  /** 认不出的模型统一退回 MeowCode 自己的 Logo */
  meow: { kind: "single", src: appIcon },
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

/**
 * 模型品牌 → 图标 key（模型列表显示的是模型 Logo，不是服务商 Logo）。
 *
 * 每条规则三段：
 *  - `prefixes`：模型名（或其中一个被分隔开的词）以它开头算命中；
 *  - `icon`：ICONS 里的 key；
 *  - `anywhere`（可选）：够独特的品牌词，模型名里任意位置出现都算命中。
 *    只放不会误伤的词：`o1` / `step` / `phi` / `seed` / `nova` 这类短词只在开头或独立成词时才算。
 */
const MODEL_ICON_RULES: Array<readonly [readonly string[], string, (readonly string[] | undefined)?]> = [
  [["deepseek"], "deepseek", ["deepseek"]],
  [["glm", "charglm", "emohaa"], "zai", ["glm", "charglm", "emohaa"]],
  [["codegeex"], "codegeex", ["codegeex"]],
  [["mimo"], "xiaomi-mimo", ["mimo"]],
  [["kimi", "moonshot"], "moonshot-kimi", ["kimi", "moonshot"]],
  [["qwen", "qwq", "qvq"], "qwen", ["qwen", "qwq", "qvq"]],
  [["claude"], "claude", ["claude"]],
  [["gpt", "chatgpt", "codex", "o1", "o2", "o3", "o4"], "openai", ["gpt", "chatgpt", "codex"]],
  [["gemini", "gemma"], "google-gemini", ["gemini", "gemma"]],
  [["grok"], "grok", ["grok"]],
  [
    ["mistral", "mixtral", "codestral", "devstral", "magistral"],
    "mistral",
    ["mistral", "mixtral", "codestral", "devstral", "magistral"],
  ],
  [["llama"], "meta", ["llama"]],
  [["doubao", "seed"], "doubao", ["doubao"]],
  // Hy4 是腾讯混元的别名（WorkBuddy 等路由用它），中文名也可能直接写成「混元」
  [["hunyuan", "hy4", "混元"], "hunyuan", ["hunyuan", "hy4", "混元"]],
  [["spark", "xinghuo"], "spark", ["spark", "xinghuo"]],
  [["ernie", "wenxin"], "wenxin", ["ernie", "wenxin"]],
  [["minimax", "abab"], "minimax", ["minimax", "abab"]],
  [["step"], "stepfun", ["stepfun"]],
  [["sense"], "sensenova", ["sensenova"]],
  [["command"], "cohere", ["cohere"]],
  [["sonar", "perplexity"], "perplexity", ["sonar", "perplexity"]],
  [["nemotron"], "nvidia", ["nemotron"]],
  [["copilot"], "github-copilot", ["copilot"]],
  [["baichuan"], "baichuan", ["baichuan"]],
  [["nova"], "aws"],
  [["cloudflare"], "cloudflare", ["cloudflare"]],
  // 小众 / 国产模型：带连字符的前缀是为了不误伤（yi- 不会命中 yiyan），
  // 因此这两条也刻意没有 anywhere 兜底。Ling 同时接受整名（自定义服务商常写 "Ling"），
  // kling 仍然不会被命中：bare 不以 ling 开头、整词也不等于 ling。
  [["longcat"], "longcat", ["longcat"]],
  [["yi-"], "yi"],
  [["internlm"], "internlm", ["internlm"]],
  [["skywork"], "skywork", ["skywork"]],
  [["tiangong"], "tiangong", ["tiangong"]],
  [["ling-", "ling"], "ling"],
  [["rwkv"], "rwkv", ["rwkv"]],
  [["aquila", "emu3"], "baai", ["aquila", "emu3"]],
  [["jamba", "jurassic"], "ai21", ["jamba", "jurassic"]],
  [["solar"], "upstage", ["solar"]],
  [["arctic"], "snowflake", ["arctic"]],
  [["phi"], "microsoft"],
  [["aya"], "aya"],
  [["reka"], "reka", ["reka"]],
];

// 短品牌词（o1 / step / phi / seed / nova …）在词里只允许**整词**相等，避免 stepstone / proto3 这类误伤
const TOKEN_PREFIX_MIN = 5;

/** 一个被分隔开的词是否命中品牌词：长词允许前缀（deepseek-r1 / claudeXXX），短词要求整词相等 */
function tokenHit(token: string, prefix: string): boolean {
  return token === prefix || (prefix.length >= TOKEN_PREFIX_MIN && token.startsWith(prefix));
}

/** 拆词：`jwadijawodwa-deepseek-1313013` → ["jwadijawodwa", "deepseek", "1313013"]（小写） */
function modelTokens(model: string): string[] {
  return model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * 按模型名识别品牌图标：大小写不敏感，随机前后缀、聚合平台前缀都不影响。
 * （`acme-DeepSeek-1313013`、`jwadijawodwadeepseek1313013`、`openrouter/deepseek/deepseek-v3` 都认 deepseek）
 *
 * 匹配顺序：
 *  1. 模型名（或其中某个被分隔开的词）以品牌词开头 —— 最准，保留原有行为；
 *  2. 品牌词出现在模型名任意位置 —— 只对足够独特的词生效（见 MODEL_ICON_RULES 的 anywhere）。
 * 返回 undefined 表示认不出品牌，调用方用 `"meow"`（MeowCode 自己的 Logo）兜底。
 */
export function modelIconKey(model: string): string | undefined {
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return undefined;
  // 聚合平台前缀（openrouter 的 vendor/model）取最后一段做「开头」判定
  const bare = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const tokens = modelTokens(trimmed);

  for (const [prefixes, iconKey] of MODEL_ICON_RULES) {
    const hit = prefixes.some(
      (prefix) => bare.startsWith(prefix) || tokens.some((token) => tokenHit(token, prefix)),
    );
    if (hit) return iconKey;
  }
  for (const [, iconKey, anywhere] of MODEL_ICON_RULES) {
    if (anywhere?.some((needle) => trimmed.includes(needle))) return iconKey;
  }
  return undefined;
}

/**
 * 模型行图标：模型 ID 优先（真实品牌），用户设置的显示名兜底。
 * 路由组/聚合器常把模型 ID 换成别名，此时 ID 认不出品牌，但显示名通常还写着
 * "DeepSeek-Flash"；反过来 ID 准确时不被用户随手改的显示名带偏。
 */
export function providerModelIconKey(provider: {
  model: string;
  displayName?: string | null;
}): string {
  return modelIconKey(provider.model) ?? modelIconKey(provider.displayName ?? "") ?? "meow";
}
