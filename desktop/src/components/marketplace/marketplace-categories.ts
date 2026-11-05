/**
 * 市场分类的规范值是市场索引与社区提交载荷里的 `category` 字段：要发给后端、要和索引数据做
 * 相等比较，所以不随界面语言变化。界面标签一律在组件里 `t(\`categories.${id}\`)` 查表，
 * 顶层不调 t()（import 期求值会导致切语言不刷新）。
 */

/** 已知分类 id（同时是 `categories.*` 的语义名） */
export type MarketplaceCategoryId =
  | "devTools"
  | "uiDesign"
  | "contentCreation"
  | "productivity"
  | "dataAnalysis"
  | "builtin";

/** 技能页的分类 chips：`all` 只是「不过滤」的哨兵，不是分类、也不会提交 */
export type MarketplaceCategoryFilter = "all" | MarketplaceCategoryId;

/** chips 的展示顺序；标签由组件查词条 */
export const CATEGORY_FILTERS: MarketplaceCategoryFilter[] = [
  "all",
  "devTools",
  "uiDesign",
  "contentCreation",
  "productivity",
  "dataAnalysis",
];

/** 提交表单可选的分类（不含哨兵） */
export const SUBMITTABLE_CATEGORIES: MarketplaceCategoryId[] = [
  "devTools",
  "uiDesign",
  "contentCreation",
  "productivity",
  "dataAnalysis",
];

// i18n-allow-block-start：以下是与后端 / 市场索引一致的规范分类值（数据标识符，不参与翻译）
const CATEGORY_VALUES: Record<MarketplaceCategoryId, string> = {
  devTools: "开发工具",
  uiDesign: "界面设计",
  contentCreation: "内容创作",
  productivity: "效率提升",
  dataAnalysis: "数据分析",
  builtin: "内置",
};
// i18n-allow-block-end

/** 分类 id → 提交与筛选用的规范值；`all` 返回 undefined 表示不过滤 */
export function categoryValue(id: MarketplaceCategoryFilter): string | undefined {
  return id === "all" ? undefined : CATEGORY_VALUES[id];
}

/** 规范值 → 词条 key（反向表）；社区条目可能带自定义分类，未知值原样显示 */
const CATEGORY_LABEL_KEYS: Record<string, string> = Object.fromEntries(
  Object.entries(CATEGORY_VALUES).map(([id, value]) => [value, `categories.${id}`]),
);

export function categoryLabelKey(value: string | undefined): string | undefined {
  return value ? CATEGORY_LABEL_KEYS[value] : undefined;
}
