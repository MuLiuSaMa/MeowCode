import { afterEach, describe, expect, it } from "vitest";
import i18n from "i18next";
import { setupI18n } from "../../i18n";
import { setModelProfiles } from "../../modelProfiles";
import { formatCapacity } from "../../util";
import { applyDetectedCapabilities, buildProvider, providerLabel } from "./modelForm";
import type { ProviderSettings } from "../../api";

// buildProvider 的报错文案走 i18next，取词发生在调用时：测试里要先初始化实例
setupI18n();

const base: ProviderSettings = {
  id: "provider-1",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/anthropic",
  model: "deepseek-chat",
  protocol: "anthropic-messages",
  templateId: "deepseek",
};

afterEach(() => {
  setModelProfiles(null);
});

describe("applyDetectedCapabilities", () => {
  it("fills context, max output and image modality from the model rule", () => {
    setModelProfiles([
      { match: "claude-sonnet-4", contextWindow: 200_000, maxOutputTokens: 64_000, supportsImage: true },
    ]);
    const result = applyDetectedCapabilities(
      { ...base, model: "claude-sonnet-4" },
      "",
      "",
      { context: false, max: false, image: false },
    );
    expect(result.contextInput).toBe(formatCapacity(200_000));
    expect(result.maxInput).toBe(formatCapacity(64_000));
    expect(result.form.inputModalities).toEqual(["text", "image"]);
    expect(result.auto).toEqual({ context: true, max: true, image: true });
  });

  it("keeps manually entered values and only overwrites auto-filled ones", () => {
    setModelProfiles([{ match: "claude-sonnet-4", contextWindow: 200_000 }]);
    const manual = applyDetectedCapabilities(
      { ...base, model: "claude-sonnet-4" },
      "131072",
      "",
      { context: false, max: false, image: false },
    );
    expect(manual.contextInput).toBe("131072");

    const autoFilled = applyDetectedCapabilities(
      { ...base, model: "claude-sonnet-4" },
      "100k",
      "",
      { context: true, max: false, image: false },
    );
    expect(autoFilled.contextInput).toBe(formatCapacity(200_000));
  });

  it("clears an auto-filled context when the new model has no matching rule", () => {
    const result = applyDetectedCapabilities(
      { ...base, model: "unknown-model" },
      "200k",
      "64k",
      { context: true, max: true, image: false },
    );
    expect(result.contextInput).toBe("");
    expect(result.maxInput).toBe("");
    expect(result.auto.context).toBe(false);
    expect(result.auto.max).toBe(false);
  });
});

describe("providerLabel", () => {
  it("falls back to the model id when the display name is blank", () => {
    expect(providerLabel({ displayName: "  ", model: " deepseek-chat " })).toBe("deepseek-chat");
    expect(providerLabel({ displayName: " DeepSeek 对话 ", model: "deepseek-chat" })).toBe(
      "DeepSeek 对话",
    );
  });
});

describe("buildProvider", () => {
  it("allows the same model id twice when display names differ", () => {
    const result = buildProvider(
      { ...base, displayName: "DeepSeek 备用端点" },
      "",
      "",
      ["DeepSeek 对话"],
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a duplicate display name through the settings entry", () => {
    const result = buildProvider({ ...base, displayName: "  DeepSeek 对话  " }, "", "", [
      "DeepSeek 对话",
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 文案由词条拼装，测试只钉住「用的哪条 key」和「重名的那个名字有没有带进去」
    expect(result.error).toBe(i18n.t("settings:models.error.duplicateName", { name: "DeepSeek 对话" }));
    expect(result.error).toContain("DeepSeek 对话");
  });

  it("treats the model id as the label when no display name is given", () => {
    const result = buildProvider(base, "", "", ["deepseek-chat"]);
    expect(result).toMatchObject({ ok: false });
  });
});
