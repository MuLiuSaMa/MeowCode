/**
 * 主进程从 ZCode 内置配置同步来的模型规则：
 * 思考档位、上下文窗口、最大输出、图片输入能力。
 *
 * 新模型发布后无需改代码：远程规则优先，内置表兜底。
 * 内置表只补远程还没覆盖的新模型（目前是 MiMo V2.6 系列），
 * 远程一旦给出具体规则就整条采用远程值（包括它的 `.*` 通用层）。
 */

export type ModelProfile = {
  /** ZCode 的 modelMatch 正则（字符串形式） */
  match: string;
  /** 思考档位；主进程已过滤掉 disabled/enabled 这类开关值 */
  values?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsImage?: boolean;
};

export type ModelCapabilities = {
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsImage?: boolean;
};

/** models.dev 的一行：模型级能力（同一模型取上下文最大的那条，不是某家网关的裁剪值）。 */
export type CatalogModel = {
  contextWindow: number;
  maxOutputTokens?: number;
  supportsImage?: boolean;
  levels?: string[];
};

let catalogModels = new Map<string, CatalogModel>();

/** 模型名归一化：小写 + 去掉网关前缀（`zcode/GLM-5.4` → `glm-5.4`）。 */
function normalizeModelId(model: string): string {
  const lower = (model ?? "").trim().toLowerCase();
  if (!lower) return "";
  const slash = lower.lastIndexOf("/");
  return (slash >= 0 ? lower.slice(slash + 1) : lower).trim();
}

/** 换掉 models.dev 目录（主进程拉取后推过来）。 */
export function setModelsDevCatalog(models?: Record<string, CatalogModel> | null): void {
  const next = new Map<string, CatalogModel>();
  for (const [id, entry] of Object.entries(models ?? {})) {
    if (!entry || typeof entry !== "object" || typeof entry.contextWindow !== "number") continue;
    const key = normalizeModelId(id);
    if (key) next.set(key, entry);
  }
  catalogModels = next;
  notifyProfiles();
}

/**
 * 目录命中：先精确，再退化到"带后缀"（`glm-5.4-economy` → `glm-5.4`）。
 * 只在分隔符处退化，`glm-5` 不会吃掉 `glm-5.4`。
 */
export function catalogForModel(model: string): CatalogModel | undefined {
  const id = normalizeModelId(model);
  if (!id) return undefined;
  const exact = catalogModels.get(id);
  if (exact) return exact;
  let best: CatalogModel | undefined;
  let bestLength = 0;
  for (const [key, entry] of catalogModels) {
    if (key.length <= bestLength || !id.startsWith(key)) continue;
    if (!["-", ":", "_"].includes(id.charAt(key.length))) continue;
    best = entry;
    bestLength = key.length;
  }
  return best;
}

/**
 * 内置兜底表：远程规则没覆盖的模型用它。匹配语义与远程一致（后写的规则覆盖先写的），
 * 与 ZCode 远程规则逐条对齐，方便远程补充后无缝切换。
 *
 * MiMo V2.6（2026-09 发布，官方文档核对）：全系 1M 上下文 / 128K 最大输出、支持图片输入；
 * V2.5 / V2 系列沿用 ZCode 规则（V2.5-Pro 与 V2 系列不支持图片输入）。
 *
 * GLM-5.4（2026-11-23 发布，官方口径 1M 上下文 / 128K 输出 / 原生视觉）：上游 ZCode 表
 * 迟迟只有 `.*glm-5` 的 200K 兜底，会把 5.4 误判成上一代规格，所以在这里先补一条；
 * 等上游补上同名规则，同特异度时远程优先，会自动切回远程值。
 */
const BUILTIN_PROFILES: ModelProfile[] = [
  {
    match: ".*glm-5\\.4(?:[.\\-:/\\[].*)?",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsImage: true,
  },
  {
    match: ".*mimo-v2\\.6(?:[.\\-:/\\[].*)?",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsImage: true,
  },
  {
    match: ".*mimo-v2\\.5(?:[.\\-:/\\[].*)?",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsImage: true,
  },
  {
    match: ".*mimo-v2\\.5-pro(?:[.\\-:/\\[].*)?",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsImage: false,
  },
  {
    match: ".*mimo-v2-omni(?:[.\\-:/\\[].*)?",
    contextWindow: 262_144,
    maxOutputTokens: 131_072,
    supportsImage: true,
  },
  {
    match: ".*mimo-v2-pro(?:[.\\-:/\\[].*)?",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsImage: false,
  },
  {
    match: ".*mimo-v2-flash(?:[.\\-:/\\[].*)?",
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    supportsImage: false,
  },
];

const builtinProfiles = BUILTIN_PROFILES.map((profile) => ({
  source: profile.match,
  match: new RegExp(profile.match, "i"),
  profile,
}));

let remoteProfiles: Array<{ source: string; match: RegExp; profile: ModelProfile }> = [];

/** 规则表变化时通知界面（设置弹层要按新规则重新校正已填的容量）。 */
const profileListeners = new Set<() => void>();
let profileRevision = 0;

export function subscribeModelProfiles(listener: () => void): () => void {
  profileListeners.add(listener);
  return () => profileListeners.delete(listener);
}

/** 自增版本号：组件把它放进 effect 依赖，规则一到就重算。 */
export function modelProfilesRevision(): number {
  return profileRevision;
}

function notifyProfiles(): void {
  profileRevision += 1;
  for (const listener of profileListeners) listener();
}

export function setModelProfiles(profiles?: ModelProfile[] | null): void {
  const next: typeof remoteProfiles = [];
  for (const profile of profiles ?? []) {
    if (!profile || typeof profile.match !== "string") continue;
    try {
      next.push({ source: profile.match, match: new RegExp(profile.match, "i"), profile });
    } catch {
      // 远程正则不合法就跳过，不影响其它规则
    }
  }
  remoteProfiles = next;
  notifyProfiles();
}

type RankedRule = {
  source: string;
  match: RegExp;
  profile: ModelProfile;
  /** 规则的特异度（字面字符数）：`.*glm-5` 是 4，`.*glm-5\.4` 是 5 */
  rank: number;
  /** 是否来自远程同步：并列时远程优先 */
  remote: boolean;
};

/** 字面字符越多，限定的版本越具体；`.*` 这类兜底自然排到最低。 */
function rankOf(source: string): number {
  return (source.match(/[A-Za-z0-9]/g) ?? []).length;
}

/** 模型名里的版本号片段："GLM-5.4" → ["5.4"]，"MiMo-V2.6-Pro" → ["2.6"]。 */
function versionTokens(model: string): string[] {
  return [...model.matchAll(/(\d+(?:\.\d+)+)/g)].map((match) => match[1]);
}

/**
 * 这条远程规则是不是"点名的这一版"：把正则里的转义去掉再比版本串。
 * `.*glm-5\.4` → `.*glm-5.4` 命中 "5.4"；上游的 `.*glm-5` 不含版本号 → 不算。
 */
function coversVersion(rule: { source: string }, tokens: string[]): boolean {
  const plain = rule.source.replace(/\\/g, "").toLowerCase();
  return tokens.some((token) => plain.includes(token.toLowerCase()));
}

/**
 * 命中规则按优先级**升序**排好（最后一个最优）：
 *  0. **远程点名了这一版 → 远程这条直接排到最前**（用户要求：远程只要有这条就用远程的值），
 *     但**不丢内置规则**：远程没写的字段（比如图片能力）继续由内置的同一版规则补，
 *     这样上游的局部更新不会把 5.4 的视觉能力一起抹掉；
 *  1. 否则 rank 高的赢 —— `glm-5\.4` 压过上游 `glm-5` 的 200K 兜底；
 *  2. rank 相同时远程赢；
 *  3. 同源同 rank 时后写的赢 —— 保持 ZCode 的 overlay 语义。
 */
const VERSION_CLAIM_BONUS = 1000;

function rankedHits(model: string): RankedRule[] {
  const hits: Array<{ source: string; match: RegExp; profile: ModelProfile; remote: boolean; index: number }> = [];
  let index = 0;
  for (const item of builtinProfiles) {
    if (item.match.test(model)) hits.push({ ...item, remote: false, index: index++ });
  }
  for (const item of remoteProfiles) {
    if (item.match.test(model)) hits.push({ ...item, remote: true, index: index++ });
  }
  const tokens = versionTokens(model);
  const claims = (hit: { source: string; remote: boolean }) =>
    hit.remote && hit.source !== ".*" && tokens.length > 0 && coversVersion(hit, tokens);
  return hits
    .map((hit) => ({ hit, rank: rankOf(hit.source) + (claims(hit) ? VERSION_CLAIM_BONUS : 0) }))
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        Number(left.hit.remote) - Number(right.hit.remote) ||
        left.hit.index - right.hit.index,
    )
    .map(({ hit, rank }) => ({ source: hit.source, match: hit.match, profile: hit.profile, rank, remote: hit.remote }));
}

/**
 * 能力字段的取值顺序：优先级从高到低。
 * `.*` 兜底只给具体规则缺的字段补位，且**永远不单独生效** ——
 * 否则自定义模型会被套上 1M 上下文，截断阈值全错。
 */
function capabilityHits(model: string): RankedRule[] {
  const hits = rankedHits(model).reverse();
  return hits.some((item) => item.source !== ".*") ? hits : [];
}

/** 思考档位：models.dev 的模型级目录优先，其次按规则优先级（远程补齐后自动接管）。 */
export function remoteReasoningValues(model: string): readonly string[] | undefined {
  const catalog = catalogForModel(model);
  if (catalog?.levels?.length) return catalog.levels;
  return rankedHits(model)
    .reverse()
    .find((item) => item.profile.values?.length)?.profile.values;
}

/**
 * 按模型名检测上下文窗口 / 最大输出 / 图片输入。
 * 取值顺序：models.dev（模型级、最新）→ ZCode / 内置规则（缺的字段补位）。
 * 只有命中具体规则才返回（见 capabilityHits）。
 */
export function detectedCapabilities(model: string): ModelCapabilities {
  const result: ModelCapabilities = {};
  const catalog = catalogForModel(model);
  if (catalog) {
    result.contextWindow = catalog.contextWindow;
    if (catalog.maxOutputTokens) result.maxOutputTokens = catalog.maxOutputTokens;
    if (catalog.supportsImage !== undefined) result.supportsImage = catalog.supportsImage;
  }
  // 从高优先级往低取：先取到的值保留，缺的字段由后面的规则补
  for (const item of capabilityHits(model)) {
    const profile = item.profile;
    if (result.contextWindow === undefined && profile.contextWindow) {
      result.contextWindow = profile.contextWindow;
    }
    if (result.maxOutputTokens === undefined && profile.maxOutputTokens) {
      result.maxOutputTokens = profile.maxOutputTokens;
    }
    if (result.supportsImage === undefined && profile.supportsImage !== undefined) {
      result.supportsImage = profile.supportsImage;
    }
  }
  return result;
}

/** 能自动校正的容量字段（图片能力是布尔，另算）。 */
export type CapabilityField = "contextWindow" | "maxOutputTokens";

/**
 * 这个已保存的值是不是"按旧规则自动填的"：
 * 它恰好等于某条命中规则的该字段值，但优先级最高的规则已经给了别的值。
 *
 * 用来把旧条目自动升到新规格 —— 比如 GLM-5.4 之前被上游 `.*glm-5` 的兜底填成 20 万，
 * 现在有了具体规则（1M），打开设置页就该自动纠正，而不是逼用户重填。
 * 用户手填的、和任何规则都对不上的值不会被碰。
 */
export function isStaleCapability(
  model: string,
  field: CapabilityField,
  value: number | undefined,
): boolean {
  if (value === undefined) return false;
  const catalog = catalogForModel(model);
  const catalogValue = catalog?.[field];
  const hits = capabilityHits(model);
  const best = catalogValue ?? hits.find((hit) => hit.profile[field] !== undefined)?.profile[field];
  if (best === undefined || best === value) return false;
  // 旧值来自 models.dev 的上一版，或来自某条更低优先级的规则 → 判定为自动填的
  if (catalogValue === value) return true;
  return hits.some((hit) => hit.profile[field] === value);
}
