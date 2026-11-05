#!/usr/bin/env node
/**
 * 扫描 desktop/src 里没走 i18next 的硬编码中文（汉字），供分批迁移自查与最终防回归。
 *
 * 只关心用户可见字符串：注释不计入（本项目注释一律中文）。
 * 行尾加 `// i18n-allow` 可豁免——例如 i18n/languages.ts 里各语言的母语写法，它们本就不该被翻译。
 *
 * 用法：
 *   node scripts/i18n-scan.mjs            # 全量扫描，有问题退出码 1
 *   node scripts/i18n-scan.mjs --only src/components/Composer.tsx   # 只看某个文件（相对 desktop）
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.join(repoRoot, "desktop");
const sourceRoot = path.join(desktopRoot, "src");

/** 汉字区间：假名/谚文不纳入，避免把将来真要写的日语常量误判成硬编码中文 */
const HAN = /[\u4e00-\u9fff]/;
/** 豁免标记：`// i18n-allow` 或 `/* i18n-allow *\/` */
const ALLOW = /i18n-allow/;

/** 这些文件里的中文不是界面文案，整份跳过。 */
const SKIP_FILES = new Set([path.join(sourceRoot, "i18n", "languages.ts")]);

function collectFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (SKIP_FILES.has(full)) continue;
    const entry = statSync(full);
    if (entry.isDirectory()) {
      if (name === "assets" || name === "locales" || name === "node_modules") continue;
      found.push(...collectFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    // 测试与类型声明不是界面文案
    if (/\.(test|d)\.(ts|tsx)$/.test(name)) continue;
    found.push(full);
  }
  return found;
}

/** 逐行去掉注释：块注释用状态机跨行跟踪，行注释按引号外首个 // 截断。 */
function stripComments(source) {
  const lines = source.split(/\r?\n/);
  const kept = [];
  let inBlock = false;
  for (const line of lines) {
    let text = line;
    if (inBlock) {
      const closed = text.indexOf("*/");
      if (closed === -1) {
        kept.push("");
        continue;
      }
      text = text.slice(closed + 2);
      inBlock = false;
    }
    let index = 0;
    let output = "";
    let quote = null;
    while (index < text.length) {
      const char = text[index];
      const next = text[index + 1];
      if (quote) {
        output += char;
        if (char === "\\") {
          output += text[index + 1] ?? "";
          index += 2;
          continue;
        }
        if (char === quote) quote = null;
        index += 1;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        output += char;
        index += 1;
        continue;
      }
      if (char === "/" && next === "/") break; // 行注释
      if (char === "/" && next === "*") {
        const closed = text.indexOf("*/", index + 2);
        if (closed === -1) {
          inBlock = true;
          break;
        }
        index = closed + 2;
        continue;
      }
      output += char;
      index += 1;
    }
    kept.push(output);
  }
  return kept;
}

function scan(files) {
  const hits = [];
  for (const file of files) {
    const original = readFileSync(file, "utf8").split(/\r?\n/);
    const stripped = stripComments(original.join("\n"));
    let inAllowedBlock = false;
    stripped.forEach((line, index) => {
      const source = original[index] ?? "";
      if (source.includes("i18n-allow-block-start")) inAllowedBlock = true;
      if (inAllowedBlock) {
        if (source.includes("i18n-allow-block-end")) inAllowedBlock = false;
        return;
      }
      if (!HAN.test(line)) return;
      if (ALLOW.test(source)) return;
      hits.push({
        file: path.relative(desktopRoot, file).replace(/\\/g, "/"),
        line: index + 1,
        text: line.trim().slice(0, 120),
      });
    });
  }
  return hits;
}

const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];

const files = collectFiles(sourceRoot);
const needle = only ? only.replace(/^\/?desktop\/src\//, "").replace(/^\/?src\//, "") : null;
const hits = scan(files).filter((hit) => (needle ? hit.file.includes(needle) : true));

if (hits.length === 0) {
  console.log(`i18n-scan: ${files.length} 个文件，未发现未迁移的硬编码中文`);
  process.exit(0);
}

const byFile = new Map();
for (const hit of hits) {
  const list = byFile.get(hit.file) ?? [];
  list.push(hit);
  byFile.set(hit.file, list);
}
console.log(`i18n-scan: ${hits.length} 处待迁移，分布在 ${byFile.size} 个文件`);
for (const [file, list] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(list.length).padStart(4)}  ${file}`);
  if (only) {
    for (const hit of list) console.log(`        ${hit.line}: ${hit.text}`);
  }
}
process.exit(1);
