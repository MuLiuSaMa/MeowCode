import type { ApiFormat } from "../api";

/**
 * 可添加的服务商目录 = ZCode ∪ DSH，去重合并。
 *
 * - ZCode：`config/provider/zcode-builtin.json` → `providerConfigRules.templateRules`
 *   提供 中文显示名 / API 协议 / 默认端点 / 内置模型 ID / 图标 key。
 * - DSH：`packages/llm/llm-pi-ai/src/provider-data.generated.ts`
 *   只提供 id / 默认端点，没有中文名、没有协议、没有图标。
 *
 * 合并规则：按小写 id 去重，**ZCode 胜**（拿名字/协议/图标）。
 * 同一服务商在同一目录里出现多条的（同端点不同协议、同品牌不同入口）视为重复，
 * 一律折叠成一条 —— API 协议可以在添加后的表单里随意切换，没必要按协议各放一条。
 */
export type ProviderTemplate = {
  id: string;
  /** 显示名（ZCode 的 zh-CN 名，或由 id 派生的名字） */
  name: string;
  /** 默认根地址；空字符串表示该服务商没有可预设的端点，必须由用户填写 */
  baseUrl: string;
  protocol: ApiFormat;
  /** 图标 key，见 providerIcons.ts */
  iconKey?: string;
  /** 官方内置模型 ID，作为「模型 ID」输入框的候选 */
  models?: readonly string[];
  /** 目录来源，仅用于排查 */
  source: "zcode" | "dsh" | "custom";
};

/** ZCode 内置模板（19 条，含中文名、协议、图标、内置模型）。 */
const ZCODE_TEMPLATES: ProviderTemplate[] = [
  {
    id: "zai-api",
    name: "Z.ai Coding Plan",
    baseUrl: "https://api.z.ai/api/anthropic",
    protocol: "anthropic-messages",
    iconKey: "zai",
    models: ["GLM-5.3", "GLM-5.3-Flash"],
    source: "zcode",
  },
  {
    id: "zai-standard-api",
    name: "Z.ai API",
    baseUrl: "https://api.z.ai/api/paas/v4",
    protocol: "openai-chat-completions",
    iconKey: "zai",
    models: [
      "GLM-5.3",
      "GLM-5.3-Flash",
      "GLM-5V-Turbo",
      "GLM-5.1",
      "GLM-5.1-Highspeed",
      "GLM-5",
      "GLM-5-Turbo",
      "GLM-4.7",
      "GLM-4.7-FlashX",
      "GLM-4.7-Flash",
      "GLM-4.6",
      "GLM-4.5-Air",
      "GLM-4.5",
      "GLM-4.6V",
      "GLM-4.6V-Flash",
      "GLM-4.6V-FlashX",
      "GLM-4.1V-Thinking-FlashX",
      "GLM-4.1V-Thinking-Flash",
      "GLM-4-FlashX-250414",
      "GLM-4-Flash-250414",
      "GLM-4V-Flash",
      "codegeex-4",
      "charglm-4",
      "emohaa",
    ],
    source: "zcode",
  },
  {
    id: "bigmodel-api",
    name: "BigModel Coding Plan",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    protocol: "anthropic-messages",
    iconKey: "bigmodel",
    models: ["GLM-5.3", "GLM-5.3-Flash"],
    source: "zcode",
  },
  {
    id: "bigmodel-standard-api",
    name: "BigModel API",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai-chat-completions",
    iconKey: "bigmodel",
    models: [
      "GLM-5.3",
      "GLM-5.3-Flash",
      "GLM-5V-Turbo",
      "GLM-5.1",
      "GLM-5.1-Highspeed",
      "GLM-5",
      "GLM-5-Turbo",
      "GLM-4.7",
      "GLM-4.7-FlashX",
      "GLM-4.7-Flash",
      "GLM-4.6",
      "GLM-4.5-Air",
      "GLM-4.5",
      "GLM-4.6V",
      "GLM-4.6V-Flash",
      "GLM-4.6V-FlashX",
      "GLM-4.1V-Thinking-FlashX",
      "GLM-4.1V-Thinking-Flash",
      "GLM-4-FlashX-250414",
      "GLM-4-Flash-250414",
      "GLM-4V-Flash",
      "codegeex-4",
      "charglm-4",
      "emohaa",
    ],
    source: "zcode",
  },
  {
    id: "moonshot-kimi",
    name: "Kimi",
    baseUrl: "https://api.moonshot.cn/anthropic",
    protocol: "anthropic-messages",
    iconKey: "moonshot-kimi",
    models: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.7-code-highspeed", "k3", "k3-256k"],
    source: "zcode",
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/anthropic",
    protocol: "anthropic-messages",
    iconKey: "minimax",
    models: [
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
    ],
    source: "zcode",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    protocol: "anthropic-messages",
    iconKey: "deepseek",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    source: "zcode",
  },
  {
    id: "qwen-alibaba-model-studio-cn",
    name: "阿里云百炼（中国）", // i18n-allow 服务商品牌名（含地区限定），按厂商官方叫法原样展示
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    protocol: "anthropic-messages",
    iconKey: "alibaba-model-studio",
    models: [
      "qwen3.8-max",
      "qwen3.8-flash",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.7-flash",
      "qwen3.6-plus",
      "qwen3.6-flash",
      "qwen3.5-plus",
      "qwen3.5-flash",
      "qwen3-max",
      "qwen-plus",
      "qwen-flash",
      "qwen3-vl-plus",
    ],
    source: "zcode",
  },
  {
    id: "qwen-alibaba-model-studio-intl",
    name: "阿里云百炼（国际）", // i18n-allow 服务商品牌名（含地区限定），按厂商官方叫法原样展示
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    protocol: "openai-chat-completions",
    iconKey: "alibaba-model-studio",
    models: [
      "qwen3.8-max",
      "qwen3.8-flash",
      "qwen3.8-omni-flash",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.7-flash",
      "qwen3.6-plus",
      "qwen3.6-flash",
      "qwen3.5-plus",
      "qwen3.5-flash",
      "qwen3-max",
      "qwen-plus",
      "qwen-flash",
      "qwen3-vl-plus",
    ],
    source: "zcode",
  },
  {
    id: "xiaomi-mimo",
    name: "Xiaomi MiMo",
    baseUrl: "https://api.xiaomimimo.com/anthropic",
    protocol: "anthropic-messages",
    iconKey: "xiaomi-mimo",
    models: ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"],
    source: "zcode",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-responses",
    iconKey: "openai",
    models: [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6",
      "gpt-5.4",
      "gpt-5.4-pro",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.3-codex",
    ],
    source: "zcode",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    protocol: "anthropic-messages",
    iconKey: "anthropic",
    models: ["claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    source: "zcode",
  },
  {
    id: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    protocol: "openai-responses",
    iconKey: "xai",
    models: ["grok-4.6", "grok-build-0.1", "grok-4.3"],
    source: "zcode",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    protocol: "anthropic-messages",
    iconKey: "openrouter",
    models: [
      "anthropic/claude-fable-5.1",
      "openai/gpt-6-astra",
      "openai/gpt-5.6-sol",
      "anthropic/claude-opus-5",
      "deepseek/deepseek-v4-pro",
      "moonshotai/kimi-k3",
      "z-ai/glm-5.3",
      "qwen/qwen3.8-max",
      "minimax/minimax-m3",
      "xiaomi/mimo-v2.5-pro",
      "x-ai/grok-4.6",
      "deepseek/deepseek-v4.1-flash",
      "openai/gpt-5.6",
      "openai/gpt-5.4",
      "openai/gpt-5.4-pro",
      "openai/gpt-5.4-mini",
      "openai/gpt-5.3-codex",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4.5",
      "deepseek/deepseek-v4-flash",
      "moonshotai/kimi-k2.7-code",
      "z-ai/glm-5.3-flash",
      "z-ai/glm-5.2",
      "z-ai/glm-4.7",
      "qwen/qwen3.8-flash",
      "qwen/qwen3-vl-plus",
      "minimax/minimax-m2.7",
      "x-ai/grok-4.3",
    ],
    source: "zcode",
  },
  {
    // 同一端点原来按协议拆了 3 条（Chat / Anthropic / Responses），纯重复 —— 合并成一条，
    // 协议在表单里随时可切；模型候选取原来三份的并集。
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    protocol: "openai-chat-completions",
    iconKey: "opencode",
    models: [
      "glm-5.3-flash",
      "glm-5.3",
      "glm-5.2",
      "glm-5.1",
      "kimi-k3",
      "kimi-k2.7-code",
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "minimax-m3",
      "minimax-m2.7",
      "minimax-m2.5",
      "qwen3.8-max",
      "qwen3.8-flash",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-plus",
      "gpt-5.6-luna",
      "grok-4.6",
    ],
    source: "zcode",
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    protocol: "openai-chat-completions",
    iconKey: "opencode",
    models: [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6",
      "gpt-5.4",
      "gpt-5.4-pro",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.2",
      "gpt-5.1",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "kimi-k3",
      "minimax-m3",
      "minimax-m2.7",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "glm-5.2",
      "glm-5.1",
      "qwen3.7-max",
      "qwen3.6-plus",
    ],
    source: "zcode",
  },
  {
    id: "volcengine-ark",
    name: "火山方舟 API", // i18n-allow 服务商品牌名，按厂商官方叫法原样展示
    baseUrl: "https://ark.cn-beijing.volces.com/api/compatible",
    protocol: "anthropic-messages",
    iconKey: "volcengine",
    models: [
      "doubao-seed-evolving",
      "doubao-seed-2-1-pro-260915",
      "doubao-seed-2-1-lite-260915",
      "doubao-seed-2-1-turbo-260628",
    ],
    source: "zcode",
  },
  {
    id: "volcengine-coding-plan",
    name: "火山方舟 Coding Plan", // i18n-allow 服务商品牌名，按厂商官方叫法原样展示
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
    protocol: "anthropic-messages",
    iconKey: "volcengine",
    models: ["doubao-seed-2.1-pro", "doubao-seed-2.1-lite"],
    source: "zcode",
  },
  {
    id: "volcengine-agent-plan",
    name: "火山方舟 Agent Plan", // i18n-allow 服务商品牌名，按厂商官方叫法原样展示
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
    protocol: "anthropic-messages",
    iconKey: "volcengine",
    models: ["doubao-seed-2.1-pro", "doubao-seed-2.1-lite"],
    source: "zcode",
  },
];

/**
 * DSH 独有的服务商。
 * 没有中文名与协议 → 显示名由 id 派生，协议默认 openai-chat-completions。
 *
 * 相比原始清单删掉的重复项：
 *  - `zai`（Z.ai 标准）      ≈ ZCode `zai-standard-api` / `zai-api`
 *  - `zai-coding-cn`          ≈ ZCode `bigmodel-api`（同为 open.bigmodel.cn 编码套餐）
 *  - `xiaomi`（MiMo 标准）   ≈ ZCode `xiaomi-mimo`
 *  - `moonshotai` / `moonshotai-cn` ≈ ZCode `moonshot-kimi`（Kimi）
 *  - `qwen-token-plan-individual`   ≈ `qwen-token-plan`（端点逐字节相同）
 * 协议在添加后的表单里可自由切换，因此每种品牌/套餐只保留一条。
 *
 * 端点参考 Cherry Studio / LobeChat 的服务商清单补充；
 * **每条都必须有品牌图形**（图片或字形，见 providerIcons.ts），
 * 拿不到品牌图形的（ant-ling / radius / index / typesafe）已直接从目录删除；
 * baseten / cerebras / fireworks / groq / togetherai / digitalocean / venice
 * 的品牌图标后来从 OpenCode 的服务商图标集补入。
 */
// i18n-allow-block-start 以下为服务商预置条目：名称是厂商品牌名（含「中国 / 本地」等地区限定），不翻译
const DSH_ONLY: Array<[id: string, name: string, baseUrl: string, iconKey?: string]> = [
  ["amazon-bedrock", "Amazon Bedrock", "", "aws"],
  ["azure", "Azure OpenAI", "", "azure"],
  ["cloudflare-ai-gateway", "Cloudflare AI Gateway", "", "cloudflare"],
  ["cloudflare-workers-ai", "Cloudflare Workers AI", "", "cloudflare-workers"],
  ["github-copilot", "GitHub Copilot", "https://api.individual.githubcopilot.com", "github-copilot"],
  ["google", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "google-gemini"],
  ["google-vertex", "Google Vertex AI", "", "google-cloud"],
  ["huggingface", "Hugging Face", "https://router.huggingface.co/v1", "huggingface"],
  ["kimi-coding", "Kimi Coding", "https://api.kimi.com/coding", "moonshot-kimi"],
  ["meta", "Meta", "https://api.meta.ai/v1", "meta"],
  ["mistral", "Mistral", "https://api.mistral.ai", "mistral"],
  ["nvidia", "NVIDIA", "https://integrate.api.nvidia.com/v1", "nvidia"],
  ["openai-codex", "OpenAI Codex", "https://chatgpt.com/backend-api", "openai"],
  ["qwen-token-plan", "Qwen Token Plan", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", "qwen"],
  ["qwen-token-plan-cn", "Qwen Token Plan（中国）", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "qwen"],
  ["vercel-ai-gateway", "Vercel AI Gateway", "https://ai-gateway.vercel.sh", "vercel"],
  ["xiaomi-token-plan-ams", "Xiaomi Token Plan（AMS）", "https://token-plan-ams.xiaomimimo.com/v1", "xiaomi"],
  ["xiaomi-token-plan-cn", "Xiaomi Token Plan（中国）", "https://token-plan-cn.xiaomimimo.com/v1", "xiaomi"],
  ["xiaomi-token-plan-sgp", "Xiaomi Token Plan（SGP）", "https://token-plan-sgp.xiaomimimo.com/v1", "xiaomi"],
  // —— 参考开源项目（Cherry Studio / LobeChat）补充的服务商，全部有品牌图形 ——
  ["siliconcloud", "硅基流动", "https://api.siliconflow.cn/v1", "siliconcloud"],
  ["tencent-hunyuan", "腾讯混元", "https://api.hunyuan.cloud.tencent.com/v1", "hunyuan"],
  ["iflytek-spark", "讯飞星火", "https://spark-api-open.xf-yun.com/v1", "spark"],
  ["baidu-qianfan", "百度千帆", "https://qianfan.baidubce.com/v2", "wenxin"],
  ["baichuan", "百川智能", "https://api.baichuan-ai.com/v1", "baichuan"],
  ["stepfun", "阶跃星辰", "https://api.stepfun.com/v1", "stepfun"],
  ["sensenova", "商汤日日新", "https://api.sensenova.cn/compatible-mode/v1", "sensenova"],
  ["modelscope", "魔搭社区", "https://api-inference.modelscope.cn/v1", "modelscope"],
  ["gitee-ai", "Gitee AI", "https://ai.gitee.com/v1", "giteeai"],
  ["aihubmix", "AIHubMix", "https://aihubmix.com/v1", "aihubmix"],
  ["ppio", "PPIO 派欧云", "https://api.ppinfra.com/v3/openai", "ppio"],
  ["perplexity", "Perplexity", "https://api.perplexity.ai", "perplexity"],
  ["cohere", "Cohere", "https://api.cohere.ai/compatibility/v1", "cohere"],
  ["deepinfra", "DeepInfra", "https://api.deepinfra.com/v1/openai", "deepinfra"],
  ["novita", "Novita AI", "https://api.novita.ai/v3/openai", "novita"],
  ["github-models", "GitHub Models", "https://models.github.ai/inference", "github-models"],
  ["ollama", "Ollama（本地）", "http://localhost:11434/v1", "ollama"],
  ["lmstudio", "LM Studio（本地）", "http://localhost:1234/v1", "lmstudio"],
  // —— 参考 OpenCode 的服务商（品牌图标取自 opencode 的 provider 图标集）——
  ["groq", "Groq", "https://api.groq.com/openai/v1", "groq"],
  ["cerebras", "Cerebras", "https://api.cerebras.ai/v1", "cerebras"],
  ["togetherai", "Together AI", "https://api.together.xyz/v1", "togetherai"],
  ["fireworks", "Fireworks AI", "https://api.fireworks.ai/inference/v1", "fireworks"],
  ["baseten", "Baseten", "https://inference.baseten.co/v1", "baseten"],
  ["digitalocean", "DigitalOcean", "https://inference.do-ai.run/v1", "digitalocean"],
  ["venice", "Venice AI", "https://api.venice.ai/api/v1", "venice"],
];
// i18n-allow-block-end

const DSH_TEMPLATES: ProviderTemplate[] = DSH_ONLY.map(([id, name, baseUrl, iconKey]) => ({
  id,
  name,
  baseUrl,
  protocol: "openai-chat-completions",
  iconKey,
  source: "dsh",
}));

export const PROVIDER_CATALOG: ProviderTemplate[] = [...ZCODE_TEMPLATES, ...DSH_TEMPLATES];

/** 「自定义服务商」虚拟模板：不在目录计数里，由选择器单独置顶展示。 */
export const CUSTOM_TEMPLATE: ProviderTemplate = {
  id: "custom",
  name: "自定义服务商", // i18n-allow 与预置品牌名同一份展示数据，消费方按模板名直接渲染
  baseUrl: "",
  protocol: "openai-chat-completions",
  iconKey: "custom",
  source: "custom",
};

export function findTemplate(id: string | undefined): ProviderTemplate | undefined {
  if (!id) return undefined;
  const key = id.toLowerCase();
  if (key === CUSTOM_TEMPLATE.id) return CUSTOM_TEMPLATE;
  return PROVIDER_CATALOG.find((item) => item.id.toLowerCase() === key);
}

/** 无图标时用的首字母（字母 / 数字取前两个；纯中文名取前两个汉字）。 */
export function templateInitials(template: ProviderTemplate): string {
  const ascii = template.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
  if (ascii) return ascii;
  return template.name.replace(/\s+/g, "").slice(0, 2) || "??";
}
