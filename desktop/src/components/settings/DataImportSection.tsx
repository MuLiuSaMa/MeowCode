import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronDown, LuRefreshCw } from "react-icons/lu";
import {
  applyImportOne,
  getImportSources,
  planDataImport,
  type ImportAppId,
  type ImportGroupId,
  type ImportPlanItem,
  type ImportSource,
} from "../../api";
import { Button } from "../ui/Button";
import { Section } from "../ui/Section";
import codexLogo from "../../assets/brand-icons/import-codex.png";
import dshLogo from "../../assets/brand-icons/import-dsh.png";
import opencodeLogo from "../../assets/brand-icons/import-opencode.png";
import qoderLogo from "../../assets/brand-icons/import-qoder.png";
import workbuddyLogo from "../../assets/brand-icons/import-workbuddy.png";
import workbuddyaiLogo from "../../assets/brand-icons/import-workbuddyai.png";
import zcodeLogo from "../../assets/brand-icons/import-zcode.png";
import "./DataImportSection.css";

const GROUP_IDS: ImportGroupId[] = ["mcp", "memory", "skills", "tasks"];
const APP_IDS: ImportAppId[] = [
  "qoder",
  "qoderintl",
  "workbuddy",
  "workbuddyai",
  "zcode",
  "opencode",
  "dsh",
  "codex",
];
const APP_LOGOS: Record<ImportAppId, string> = {
  qoder: qoderLogo,
  qoderintl: qoderLogo,
  workbuddy: workbuddyLogo,
  workbuddyai: workbuddyaiLogo,
  zcode: zcodeLogo,
  opencode: opencodeLogo,
  dsh: dshLogo,
  codex: codexLogo,
};

type AppResult = { imported: number; skipped: number; failed: Array<{ name: string; reason: string }>; failedOpen: boolean };

export function DataImportSection({
  onToast,
  onImported,
}: {
  onToast: (text: string) => void;
  /** 有内容落盘后回调（导入 MCP / 会话后 App 据此刷新会话列表等） */
  onImported: () => void;
}) {
  const { t } = useTranslation("settings");
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ImportAppId | null>(null);
  const [selected, setSelected] = useState<Record<string, ImportGroupId[]>>({});
  const [importing, setImporting] = useState<ImportAppId | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<Partial<Record<ImportAppId, AppResult>>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getImportSources();
      setSources(next);
      setSelected((prev) => {
        const merged = { ...prev };
        for (const source of next) {
          if (merged[source.appId]) continue;
          merged[source.appId] = GROUP_IDS.filter((id) =>
            source.groups.some((entry) => entry.id === id && entry.count > 0),
          );
        }
        return merged;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byApp = useMemo(() => {
    const map = new Map<ImportAppId, ImportSource>();
    for (const source of sources ?? []) map.set(source.appId, source);
    return map;
  }, [sources]);

  const toggleGroup = (appId: ImportAppId, groupId: ImportGroupId) => {
    setSelected((prev) => {
      const current = prev[appId] ?? [];
      const next = current.includes(groupId)
        ? current.filter((id) => id !== groupId)
        : [...current, groupId];
      return { ...prev, [appId]: next };
    });
  };

  const runImport = async (appId: ImportAppId) => {
    const groups = selected[appId] ?? [];
    if (groups.length === 0 || importing) return;
    setImporting(appId);
    setProgress(null);
    try {
      const items: ImportPlanItem[] = await planDataImport(appId, groups);
      const result: AppResult = { imported: 0, skipped: 0, failed: [], failedOpen: false };

      if (items.length === 0) {
        // plan 为空 = 选中的内容全部已存在；用探测计数展示
        result.skipped = groups.reduce(
          (sum, groupId) => sum + (byApp.get(appId)?.groups.find((entry) => entry.id === groupId)?.count ?? 0),
          0,
        );
      } else {
        setProgress({ done: 0, total: items.length });
        let done = 0;
        for (const item of items) {
          try {
            const outcome = await applyImportOne(appId, item);
            if (outcome.status === "imported") result.imported += 1;
            else if (outcome.status === "skipped") result.skipped += 1;
            else result.failed.push({ name: item.name, reason: outcome.reason ?? "unknown" });
          } catch (err) {
            result.failed.push({
              name: item.name,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
          done += 1;
          setProgress({ done, total: items.length });
        }
        if (groups.includes("mcp") && result.imported > 0) {
          onToast(t("dataImport.result.mcpReloaded"));
        }
      }

      setResults((prev) => ({ ...prev, [appId]: result }));
      if (result.imported > 0) {
        onImported();
      }
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(null);
      setProgress(null);
    }
  };

  if (loading && !sources) {
    return (
      <div className="mc-settings__inner">
        <div className="mc-dataimport__state" role="status">
          {t("dataImport.loading")}
        </div>
      </div>
    );
  }

  if (error || !sources) {
    return (
      <div className="mc-settings__inner">
        <div className="mc-dataimport__state mc-dataimport__state--error" role="alert">
          <span>{t("dataImport.error", { error: error ?? "" })}</span>
          <Button
            size="sm"
            variant="outline"
            icon={<LuRefreshCw size={14} />}
            onClick={() => void load()}
          >
            {t("dataImport.retry")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mc-settings__inner">
      <Section title={t("dataImport.title")} description={t("dataImport.desc")}>
        <div className="mc-dataimport__head">
          <span className="mc-dataimport__headlabel">{t("dataImport.fromApps")}</span>
          <Button
            size="sm"
            variant="ghost"
            icon={<LuRefreshCw size={13} className={loading ? "mc-dataimport__spin" : undefined} />}
            onClick={() => void load()}
            disabled={loading}
          >
            {t("dataImport.redetect")}
          </Button>
        </div>

        <div className="mc-dataimport__list">
          {APP_IDS.map((appId) => {
            const source = byApp.get(appId);
            const result = results[appId];
            const selectedCount = selected[appId]?.length ?? 0;
            const hasContent = (source?.groups ?? []).some((entry) => entry.count > 0);
            const detected = source?.detected ?? false;
            const busy = importing === appId;
            return (
              <div className="mc-dataimport__app" key={appId} data-detected={detected}>
                <div className="mc-dataimport__approw">
                  <span className={`mc-dataimport__badge mc-dataimport__badge--${appId}`}>
                    <img src={APP_LOGOS[appId]} alt="" />
                  </span>
                  <span className="mc-dataimport__appname">{t(`dataImport.app.${appId}`)}</span>
                  <span className="mc-dataimport__appmeta">
                    {!detected
                      ? t("dataImport.notDetected")
                      : busy && progress
                        ? t("dataImport.progress", { done: progress.done, total: progress.total })
                        : t("dataImport.selected", { count: selectedCount })}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!detected || selectedCount === 0 || busy}
                    onClick={() => void runImport(appId)}
                  >
                    {busy ? t("dataImport.importing") : t("dataImport.import")}
                  </Button>
                  <button
                    type="button"
                    className="mc-dataimport__chevron"
                    aria-expanded={expanded === appId}
                    aria-label={t(`dataImport.app.${appId}`)}
                    disabled={!detected || !hasContent}
                    onClick={() => setExpanded(expanded === appId ? null : appId)}
                  >
                    <LuChevronDown size={15} />
                  </button>
                </div>

                {expanded === appId && detected ? (
                  <div className="mc-dataimport__groups">
                    {GROUP_IDS.map((groupId) => {
                      const entry = source?.groups.find((item) => item.id === groupId);
                      const count = entry?.count ?? 0;
                      const checked = selected[appId]?.includes(groupId) ?? false;
                      return (
                        <label className="mc-dataimport__group" key={groupId}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={count === 0}
                            onChange={() => toggleGroup(appId, groupId)}
                          />
                          <span className="mc-dataimport__groupname">
                            {t(`dataImport.groups.${groupId}`)}
                          </span>
                          <span className="mc-dataimport__groupcount">
                            {count > 0 ? count : t("dataImport.groupEmpty")}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : null}

                {result ? (
                  <div className="mc-dataimport__result">
                    <span>
                      {t("dataImport.result.imported", { count: result.imported })}
                      {" · "}
                      {t("dataImport.result.skipped", { count: result.skipped })}
                    </span>
                    {result.failed.length > 0 ? (
                      <div className="mc-dataimport__failed">
                        <button
                          type="button"
                          className="mc-dataimport__failedtoggle"
                          onClick={() =>
                            setResults((prev) =>
                              prev[appId]
                                ? { ...prev, [appId]: { ...prev[appId]!, failedOpen: !prev[appId]!.failedOpen } }
                                : prev,
                            )
                          }
                        >
                          {t("dataImport.result.failed", { count: result.failed.length })}
                        </button>
                        {result.failedOpen
                          ? result.failed.map((item) => (
                              <div className="mc-dataimport__faileditem" key={item.name}>
                                <code>{item.name}</code>
                                <span>{item.reason}</span>
                              </div>
                            ))
                          : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
