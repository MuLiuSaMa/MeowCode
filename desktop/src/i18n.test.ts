import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import i18n from "i18next";
import { resolveUiLanguage, UI_LANGUAGES } from "./i18n/languages";
import { setupI18n, NAMESPACES } from "./i18n";
import { formatNumber, formatRelative, formatSessionStamp } from "./i18n/format";

const here = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.join(here, "i18n", "locales");

function flatten(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

function localeCodes(): string[] {
  return readdirSync(localesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function keysFor(locale: string, namespace: string): string[] {
  const file = path.join(localesDir, locale, `${namespace}.json`);
  return flatten(JSON.parse(readFileSync(file, "utf8")));
}

describe("界面语言解析", () => {
  it("显式偏好原样生效", () => {
    expect(resolveUiLanguage("fr", ["en-US"])).toBe("fr");
    expect(resolveUiLanguage("zh-TW", ["en-US"])).toBe("zh-TW");
  });

  it("跟随系统按顺序找第一个能归类的标签，并做子标签降级", () => {
    expect(resolveUiLanguage("system", ["ja-JP", "en-US"])).toBe("ja");
    expect(resolveUiLanguage("system", ["en-US", "zh-CN"])).toBe("en");
    expect(resolveUiLanguage("system", ["pt-BR"])).toBe("pt");
    expect(resolveUiLanguage("system", ["zh_HK"])).toBe("zh-TW");
    expect(resolveUiLanguage("system", ["zh-SG"])).toBe("zh-CN");
    expect(resolveUiLanguage("system", ["zh-Hant-TW"])).toBe("zh-TW");
    expect(resolveUiLanguage("system", ["de-DE", "en-DE"])).toBe("de");
  });

  it("系统语言全都不在清单内时回落简体中文", () => {
    expect(resolveUiLanguage("system", ["sw", "tl"])).toBe("zh-CN");
    expect(resolveUiLanguage("system", [])).toBe("zh-CN");
  });

  it("每个语种都有母语写法，且清单无重复", () => {
    expect(new Set(UI_LANGUAGES.map((item) => item.code)).size).toBe(UI_LANGUAGES.length);
    for (const item of UI_LANGUAGES) expect(item.nativeName.trim().length).toBeGreaterThan(0);
  });
});

describe("语言偏好管道", () => {
  it("主进程白名单与 UI 语种清单一致，漏改会让新语种重启后静默失效", () => {
    const main = readFileSync(path.join(here, "..", "main.cjs"), "utf8");
    const block = /const LANGUAGE_PREFERENCES = \[([\s\S]*?)\];/.exec(main);
    expect(block, "main.cjs 里的 LANGUAGE_PREFERENCES 定义找不到").not.toBeNull();
    const allowed = [...block![1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    // 只要求集合一致：两边顺序各自表达分组意图，不是约束
    expect([...allowed].sort()).toEqual(["system", ...UI_LANGUAGES.map((item) => item.code)].sort());
  });
});

function namespacesFor(locale: string): string[] {
  return readdirSync(path.join(localesDir, locale))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
}

describe("词条文件", () => {
  const locales = localeCodes();

  it("11 个语种目录齐全，与 UI 清单一致", () => {
    expect(locales.sort()).toEqual(UI_LANGUAGES.map((item) => item.code).sort());
  });

  it("每个 ns 文件都属于已声明的命名空间", () => {
    for (const locale of locales) {
      for (const namespace of namespacesFor(locale)) {
        expect(NAMESPACES.includes(namespace as (typeof NAMESPACES)[number]), `${locale}/${namespace}`).toBe(true);
      }
    }
  });

  it("每个语种的 key 集合与 zh-CN 完全一致（少一个 key 就红，防止切语言后局部仍是中文）", () => {
    const zhNamespaces = namespacesFor("zh-CN");
    for (const locale of locales) {
      for (const namespace of zhNamespaces) {
        expect(namespacesFor(locale), `${locale} 缺 ${namespace}.json`).toContain(namespace);
        expect(keysFor(locale, namespace).sort(), `${locale}/${namespace} 与 zh-CN 不一致`).toEqual(
          keysFor("zh-CN", namespace).sort(),
        );
      }
    }
  });

  it("任何语种的任何 key 都不留空值", () => {
    for (const locale of locales) {
      for (const namespace of namespacesFor(locale)) {
        const tree = JSON.parse(
          readFileSync(path.join(localesDir, locale, `${namespace}.json`), "utf8"),
        ) as Record<string, unknown>;
        for (const key of flatten(tree)) {
          const leaf = key.split(".").reduce<unknown>((node, part) => {
            if (!node || typeof node !== "object") return undefined;
            return (node as Record<string, unknown>)[part];
          }, tree);
          expect(
            typeof leaf === "string" && leaf.trim().length > 0,
            `${locale}/${namespace} 空值: ${key}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("运行时切换", () => {
  it("切语言即时生效，插值按各语言语序拼接", () => {
    setupI18n();
    i18n.changeLanguage("zh-CN");
    expect(i18n.t("common:delete")).toBe("删除");
    expect(i18n.t("common:deleteAria", { name: "a.txt" })).toBe("删除 a.txt");

    i18n.changeLanguage("ja");
    expect(i18n.t("common:delete")).toBe("削除");
    // 日语把动词放句尾：插值不能靠中文那套「动词 + 空格 + 名称」拼
    expect(i18n.t("common:deleteAria", { name: "a.txt" })).toBe("a.txt を削除");

    i18n.changeLanguage("en");
    expect(i18n.t("common:deleteAria", { name: "a.txt" })).toBe("Delete a.txt");
  });

  it("回退链锁定简体中文：漏翻要看得出没翻，不能被英文伪装成已翻", () => {
    setupI18n();
    expect(i18n.options.fallbackLng).toEqual(["zh-CN"]);
  });

  it("数字与相对时间按当前语种格式化", () => {
    i18n.changeLanguage("en");
    const english = formatNumber(1234567);
    i18n.changeLanguage("ru");
    const russian = formatNumber(1234567);
    expect(english).toBe("1,234,567");
    // 俄语用空格做千分位分组，不能跟着英文写死逗号
    expect(russian).not.toBe(english);

    i18n.changeLanguage("zh-CN");
    expect(formatRelative(Date.now() - 5_000)).toBe("刚刚");
    expect(formatRelative(Date.now() - 3 * 60 * 1000)).toContain("分钟前");
    expect(formatRelative(0)).toBe("");
  });

  it("会话列表的紧凑时间按「越近越精确」取", () => {
    i18n.changeLanguage("zh-CN");
    const now = new Date();
    // 今天：只给钟点
    expect(formatSessionStamp(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12))).toMatch(
      /^\d{2}:\d{2}$/,
    );
    // 昨天：走 Intl 的「昨天」，不写死中文
    expect(
      formatSessionStamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12)),
    ).toBe("昨天");
    // 更早：日期串，且不会再给钟点
    const older = formatSessionStamp(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 60, 12),
    );
    expect(older).not.toBe("");
    expect(older).not.toMatch(/^\d{2}:\d{2}$/);
    // 无有效时间：给空串，列表不显示占位符
    expect(formatSessionStamp(0)).toBe("");
  });
});
