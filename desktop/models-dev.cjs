/**
 * models.dev 目录的抽表逻辑（纯函数，可单测）。
 *
 * models.dev/api.json 是 326 个服务商 × 几千个模型的大杂烩：同一个模型会出现几十次，
 * 数值互相打架（转售商把 1M 写成 1048576、把最大输出也写成 1048576）。
 * 所以这里按**多数票**收敛，而不是"取最大值"——离群值几乎都偏大。
 */

/**
 * 取众数。并列时：数字取大、布尔取 true、其余保留先出现的。
 * @param {Array<number|boolean|string|null|undefined>} values
 */
function consensus(values) {
  const counts = new Map();
  for (const value of values) {
    if (value === null || value === undefined) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
      continue;
    }
    if (count !== bestCount) continue;
    if (typeof value === "number" && typeof best === "number" && value > best) best = value;
    if (typeof value === "boolean" && value) best = value;
  }
  return bestCount === 0 ? null : best;
}

/**
 * 展平成 id → { contextWindow, maxOutputTokens?, supportsImage?, levels? }。
 * @param {unknown} payload models.dev/api.json 的解析结果
 */
function extractModelsDev(payload) {
  /** @type {Map<string, Array<{context:number, output:number|null, image:boolean|null, levels:string|null}>>} */
  const buckets = new Map();
  for (const provider of Object.values(payload ?? {})) {
    const entries = provider && typeof provider === "object" ? provider.models : null;
    if (!entries || typeof entries !== "object") continue;
    for (const [rawId, model] of Object.entries(entries)) {
      // 有的服务商用命名空间 id（zhipuai/glm-5.3-flash）：去掉前缀并入同一条，
      // 让它们一起投票，而不是在后面悄悄覆盖掉裸 id 的那条。
      const id = String(rawId ?? "").trim().toLowerCase().split("/").pop() ?? "";
      const context = Number(model?.limit?.context);
      if (!id || !Number.isSafeInteger(context) || context <= 0) continue;
      const output = Number(model?.limit?.output);
      const inputs = Array.isArray(model?.modalities?.input) ? model.modalities.input : null;
      const options = Array.isArray(model?.reasoning_options) ? model.reasoning_options : [];
      const effort = options.find((option) => option && option.type === "effort");
      const levels = Array.isArray(effort?.values)
        ? effort.values.filter((value) => typeof value === "string")
        : [];
      const bucket = buckets.get(id) ?? [];
      bucket.push({
        context,
        output: Number.isSafeInteger(output) && output > 0 ? output : null,
        image: inputs ? inputs.includes("image") : null,
        levels: levels.length ? levels.join(",") : null,
      });
      buckets.set(id, bucket);
    }
  }
  /** @type {Record<string, {contextWindow:number,maxOutputTokens?:number,supportsImage?:boolean,levels?:string[]}>} */
  const models = {};
  for (const [id, list] of buckets) {
    const context = consensus(list.map((item) => item.context));
    if (context === null) continue;
    const entry = { contextWindow: context };
    const output = consensus(list.map((item) => item.output));
    if (output !== null) entry.maxOutputTokens = output;
    const image = consensus(list.map((item) => item.image));
    if (image !== null) entry.supportsImage = image;
    const levels = consensus(list.map((item) => item.levels));
    if (levels) entry.levels = String(levels).split(",");
    models[id] = entry;
  }
  return models;
}

module.exports = { consensus, extractModelsDev };
