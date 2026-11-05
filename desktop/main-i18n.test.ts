import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type MainI18n = {
  SUPPORTED_LANGUAGES: string[];
  MAIN_STRINGS: Record<string, Record<string, string>>;
  resolveMainLanguage: (preference: string, systemLanguages: string | string[]) => string;
  mainStrings: (preference: string, systemLanguages: string | string[]) => Record<string, string>;
};

const requireCjs = createRequire(import.meta.url);
const { SUPPORTED_LANGUAGES, MAIN_STRINGS, resolveMainLanguage, mainStrings } =
  requireCjs("./main-i18n.cjs") as MainI18n;

const here = path.dirname(fileURLToPath(import.meta.url));

describe("main process i18n", () => {
  it("covers every supported language with the same keys", () => {
    const reference = Object.keys(MAIN_STRINGS["zh-CN"]).sort();
    expect(reference.length).toBe(19);
    for (const language of SUPPORTED_LANGUAGES) {
      const strings = MAIN_STRINGS[language];
      expect(strings, `missing main strings for ${language}`).toBeTruthy();
      expect(Object.keys(strings).sort()).toEqual(reference);
      expect(Object.values(strings).every((value) => value.trim().length > 0)).toBe(true);
    }
    expect(Object.keys(MAIN_STRINGS).sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
  });

  it("keeps main.cjs's language whitelist in sync", () => {
    const main = readFileSync(path.join(here, "main.cjs"), "utf8");
    const block = /const LANGUAGE_PREFERENCES = \[([\s\S]*?)\];/.exec(main);
    expect(block, "main.cjs 里的 LANGUAGE_PREFERENCES 定义找不到").not.toBeNull();
    const allowed = [...block![1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect([...allowed].sort()).toEqual(["system", ...SUPPORTED_LANGUAGES].sort());
  });

  it("resolves the preference and system languages like the renderer", () => {
    expect(resolveMainLanguage("ja", ["en-US"])).toBe("ja");
    expect(resolveMainLanguage("system", ["zh-HK", "en-US"])).toBe("zh-TW");
    expect(resolveMainLanguage("system", ["it-IT", "fr-FR"])).toBe("fr");
    expect(resolveMainLanguage("system", ["it-IT"])).toBe("zh-CN");
    expect(resolveMainLanguage("bogus", ["de-DE"])).toBe("de");
  });

  it("returns localized native UI strings", () => {
    expect(mainStrings("en", ["en-US"]).quit).toBe("Quit");
    expect(mainStrings("system", ["zh-HK"]).settings).toBe("設定…");
  });
});
