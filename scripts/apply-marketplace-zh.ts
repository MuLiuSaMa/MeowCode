/**
 * 一次性回填：把 scripts/marketplace-zh.ts 的中文名称/介绍写进已生成的 index.json。
 * 不重跑整个市场采集（不会动 skills/ 目录与图标），只改 skill 条目的 name / description。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ZH_SKILL_TEXT } from "./marketplace-zh.js";

const indexPath = "resources/marketplace/index.json";
const json = JSON.parse(readFileSync(indexPath, "utf8")) as {
  items: Array<{ type: string; id: string; name?: string; description?: string }>;
};

let updated = 0;
const missing: string[] = [];
json.items = json.items.map((item) => {
  if (item.type !== "skill") return item;
  const zh = ZH_SKILL_TEXT[item.id];
  if (!zh) {
    missing.push(item.id);
    return item;
  }
  updated += 1;
  return { ...item, name: zh.name ?? item.name, description: zh.description };
});

writeFileSync(indexPath, `${JSON.stringify(json, null, 2)}\n`);
console.log(`updated ${updated} skills; missing zh text: ${missing.length}`);
if (missing.length) console.log(missing.join("\n"));
