/**
 * 主进程从 ZCode 内置配置同步来的模型规则：
 * 思考档位、上下文窗口、最大输出、图片输入能力。
 *
 * 新模型发布后无需改代码：远程规则优先，内置表兜底。
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

let remoteProfiles: Array<{ source: string; match: RegExp; profile: ModelProfile }> = [];

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
}

function matchingProfiles(model: string): Array<{ source: string; profile: ModelProfile }> {
  return remoteProfiles.filter((item) => item.match.test(model));
}

/** ZCode 的 modelRules 是有序 overlay：后面的规则覆盖前面的。 */
export function remoteReasoningValues(model: string): readonly string[] | undefined {
  const hits = matchingProfiles(model).filter((item) => item.profile.values?.length);
  return hits.at(-1)?.profile.values;
}

/**
 * 按模型名检测上下文窗口 / 最大输出 / 图片输入。
 * 只有命中具体规则才返回：ZCode 的 `.*` 兜底是 1M 上下文，
 * 套到自定义模型上会把截断阈值拉错。
 */
export function detectedCapabilities(model: string): ModelCapabilities {
  const hits = matchingProfiles(model);
  if (!hits.some((item) => item.source !== ".*")) return {};
  const result: ModelCapabilities = {};
  // 从后往前取：后面的规则优先，先取到的值保留
  for (let index = hits.length - 1; index >= 0; index -= 1) {
    const profile = hits[index].profile;
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
