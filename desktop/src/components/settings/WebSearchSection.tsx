import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebFetchProviderPreference, WebSearchProviderPreference } from "../../api";
import { Button } from "../ui/Button";
import { CustomSelect } from "../ui/CustomSelect";
import { FieldRow, Section } from "../ui/Section";
import { Toggle } from "../ui/Toggle";
import "./WebSearchSection.css";

/**
 * 设置 → 网页搜索与获取（参考 DSH：搜索与抓取分别选择提供方）。
 * auto 跟随当前模型能力；选择与模型不匹配时该工具不可用，不会悄悄换后端。
 */
export function WebSearchSection({
  searchProvider,
  onSearchProviderChange,
  fetchProvider,
  onFetchProviderChange,
  sendOriginalQuestion,
  onSendOriginalQuestionChange,
  hasDeepseekApiKey,
  onSaveDeepseekApiKey,
}: {
  searchProvider: WebSearchProviderPreference;
  onSearchProviderChange: (value: WebSearchProviderPreference) => void;
  fetchProvider: WebFetchProviderPreference;
  onFetchProviderChange: (value: WebFetchProviderPreference) => void;
  sendOriginalQuestion: boolean;
  onSendOriginalQuestionChange: (value: boolean) => void;
  /** 是否已保存 DeepSeek 网页工具密钥（明文不回显） */
  hasDeepseekApiKey: boolean;
  /** 保存 / 清除（空串）DeepSeek 密钥 */
  onSaveDeepseekApiKey: (value: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [keyInput, setKeyInput] = useState("");
  const needsDeepseekKey =
    searchProvider === "deepseek-search-api" || fetchProvider === "deepseek-fetch-api";
  const commitKey = () => {
    const value = keyInput.trim();
    if (!value) return;
    onSaveDeepseekApiKey(value);
    setKeyInput("");
  };

  const searchOptions = useMemo(
    () => [
      { value: "auto", label: t("webSearch.searchOptions.auto") },
      { value: "provider-native", label: t("webSearch.searchOptions.providerNative") },
      { value: "deepseek-search-api", label: t("webSearch.searchOptions.deepseek") },
      { value: "off", label: t("webSearch.searchOptions.off") },
    ],
    [t],
  );
  const fetchOptions = useMemo(
    () => [
      { value: "auto", label: t("webSearch.fetchOptions.auto") },
      { value: "http", label: t("webSearch.fetchOptions.http") },
      { value: "deepseek-fetch-api", label: t("webSearch.fetchOptions.deepseek") },
    ],
    [t],
  );

  return (
    <div className="mc-settings__inner">
      <Section title={t("webSearch.section")} description={t("webSearch.desc")}>
        <FieldRow label={t("webSearch.search.label")} hint={t("webSearch.search.hint")}>
          <CustomSelect
            value={searchProvider}
            options={searchOptions}
            onChange={(value) => onSearchProviderChange(value as WebSearchProviderPreference)}
            ariaLabel={t("webSearch.search.label")}
          />
        </FieldRow>
        <FieldRow label={t("webSearch.fetch.label")} hint={t("webSearch.fetch.hint")}>
          <CustomSelect
            value={fetchProvider}
            options={fetchOptions}
            onChange={(value) => onFetchProviderChange(value as WebFetchProviderPreference)}
            ariaLabel={t("webSearch.fetch.label")}
          />
        </FieldRow>
        <FieldRow
          label={t("webSearch.originalQuestion.label")}
          hint={t("webSearch.originalQuestion.hint")}
        >
          <Toggle
            checked={sendOriginalQuestion}
            onChange={onSendOriginalQuestionChange}
            label={t("webSearch.originalQuestion.label")}
          />
        </FieldRow>
        {needsDeepseekKey ? (
          <FieldRow label={t("webSearch.deepseekKey.label")} hint={t("webSearch.deepseekKey.hint")}>
            <div className="mc-webkey">
              <input
                className="mc-fieldrow__input mc-webkey__input"
                type="password"
                value={keyInput}
                spellCheck={false}
                autoComplete="off"
                placeholder={
                  hasDeepseekApiKey
                    ? t("webSearch.deepseekKey.saved")
                    : t("webSearch.deepseekKey.placeholder")
                }
                aria-label={t("webSearch.deepseekKey.label")}
                onChange={(event) => setKeyInput(event.target.value)}
                onBlur={commitKey}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  commitKey();
                  event.currentTarget.blur();
                }}
              />
              {hasDeepseekApiKey ? (
                <Button size="sm" variant="ghost" onClick={() => onSaveDeepseekApiKey("")}>
                  {t("webSearch.deepseekKey.clear")}
                </Button>
              ) : null}
            </div>
          </FieldRow>
        ) : null}
      </Section>
    </div>
  );
}
