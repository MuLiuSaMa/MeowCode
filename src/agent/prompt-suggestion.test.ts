import { describe, expect, it } from "vitest";
import { cleanSuggestionCandidate, usableSuggestion } from "./prompt-suggestion";

describe("cleanSuggestionCandidate", () => {
  it("strips wrappers, labels and quotes", () => {
    expect(cleanSuggestionCandidate("<suggestion>run the tests</suggestion>")).toBe("run the tests");
    expect(cleanSuggestionCandidate("建议：运行测试")).toBe("运行测试");
    expect(cleanSuggestionCandidate("“提交这个”")).toBe("提交这个");
  });
});

describe("usableSuggestion", () => {
  it("accepts a short, specific next prompt", () => {
    expect(usableSuggestion("run the tests")).toBe("run the tests");
    expect(usableSuggestion("提交这个")).toBe("提交这个");
  });

  it("rejects assistant voice, evaluative replies and meta text", () => {
    expect(usableSuggestion("Let me run the tests")).toBeNull();
    expect(usableSuggestion("看起来不错")).toBeNull();
    expect(usableSuggestion("暂无建议")).toBeNull();
    expect(usableSuggestion("silence")).toBeNull();
  });

  it("rejects multiple sentences and long text", () => {
    expect(usableSuggestion("run tests. Then commit.")).toBeNull();
    expect(usableSuggestion("把 SEO 收尾完成。顺便提交 sitemap")).toBeNull();
    expect(
      usableSuggestion(
        "this is a deliberately long suggestion that should never be shown to the user because it is too long",
      ),
    ).toBeNull();
    expect(usableSuggestion("- run the tests")).toBe("run the tests");
  });

  it("accepts normal Chinese suggestions and domains", () => {
    expect(usableSuggestion("把 SEO 收尾做完并提交 sitemap")).toBe("把 SEO 收尾做完并提交 sitemap");
    expect(usableSuggestion("部署 meowcode.cn")).toBe("部署 meowcode.cn");
  });

  it("extracts a candidate from a verbose or formatted reply", () => {
    expect(usableSuggestion("**Suggestion:** run the tests")).toBe("run the tests");
    expect(usableSuggestion('{"suggestion":"run the tests"}')).toBe("run the tests");
    expect(
      usableSuggestion("用户刚说了“你好”，下一句可能是：\n1. 帮我看看这个项目\n2. 帮我改个 bug"),
    ).toBe("帮我改个 bug");
    expect(usableSuggestion("我认为最可能是：\n```\n提交这些更改\n```")).toBe("提交这些更改");
  });

  it("drops verbose replies without a usable candidate", () => {
    expect(
      usableSuggestion("你可以让我帮你改代码、查文件或排查问题。如果需要，随时告诉我。"),
    ).toBeNull();
  });

  it("allows slash commands and CJK short prompts", () => {
    expect(usableSuggestion("/compact")).toBe("/compact");
    expect(usableSuggestion("继续")).toBe("继续");
  });
});
