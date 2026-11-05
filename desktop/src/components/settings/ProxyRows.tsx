import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getProxy, setProxy, type ProxyMode } from "../../api";
import { CustomSelect, type CustomSelectOption } from "../ui/CustomSelect";
import { FieldRow } from "../ui/Section";
import "./ProxyRows.css";

const PROXY_MODES: ProxyMode[] = ["direct", "system", "manual"];

/**
 * 网络代理两行（模式 + 手动地址）。
 *
 * 自己管状态而不是走 App 的 preferences：代理要「改了立刻生效」，
 * 落盘只影响下次启动，实时生效走 /config/proxy 热切换 —— 和记忆/学习开关同一条路子。
 */
export function ProxyRows({ onToast }: { onToast: (text: string) => void }) {
  const { t } = useTranslation("settings");
  const [mode, setMode] = useState<ProxyMode>("direct");
  const [url, setUrl] = useState("");
  /** 输入框草稿：失焦/回车才提交，避免每敲一个字符就发一次 PUT */
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getProxy()
      .then((config) => {
        if (cancelled) return;
        setMode(config.mode);
        setUrl(config.url);
        setDraft(config.url);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const modeOptions = useMemo<CustomSelectOption<ProxyMode>[]>(
    () => PROXY_MODES.map((value) => ({ value, label: t(`proxy.mode.${value}`) })),
    [t],
  );

  const commit = async (next: { mode: ProxyMode; url: string }) => {
    try {
      await setProxy(next);
      // 落盘供下次启动；走 saveProviderPrefs，绝不重启 agent server
      await window.meow.saveProviderPrefs({ proxyMode: next.mode, proxyUrl: next.url });
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("proxy.failed"));
    }
  };

  const changeMode = (value: ProxyMode) => {
    setMode(value);
    void commit({ mode: value, url });
  };

  const commitUrl = () => {
    const next = draft.trim();
    if (next === url) return;
    setUrl(next);
    void commit({ mode, url: next });
  };

  return (
    <>
      <FieldRow label={t("proxy.title")} hint={t("proxy.desc")}>
        <CustomSelect
          value={mode}
          options={modeOptions}
          onChange={changeMode}
          ariaLabel={t("proxy.title")}
          className="mc-proxy__mode"
        />
      </FieldRow>
      {mode === "manual" ? (
        <FieldRow
          label={t("proxy.urlLabel")}
          hint={loaded && !url ? t("proxy.urlMissing") : t("proxy.urlHint")}
        >
          <input
            className="mc-fieldrow__input"
            value={draft}
            spellCheck={false}
            placeholder="http://127.0.0.1:7890"
            aria-label={t("proxy.urlLabel")}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitUrl}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitUrl();
              }
            }}
          />
        </FieldRow>
      ) : null}
    </>
  );
}
