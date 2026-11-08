import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuMessageSquare, LuPlug, LuPuzzle, LuRefreshCw, LuSparkles } from "react-icons/lu";
import type { MineListResult, MineSkillEntry, OauthPlatform } from "../../api";
import { MCP_ENV_PLATFORMS } from "../../api";
import {
  listMine,
  listPlugins,
  setPluginsState,
  toggleManualMcp,
  uninstallMarketplaceItem,
  authorizeMcp,
  revokeMcp,
} from "../../api";
import type { MarketTab } from "./MarketplaceNav";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Toggle } from "../ui/Toggle";
import { MarketIcon } from "./MarketplaceCard";
import { McpStatusBadge } from "./McpRow";
import { ManualImportDialog } from "./ManualImportDialog";
import { ManualMcpDialog } from "./ManualMcpDialog";
import "./marketplace.css";

/**
 * 「我的」通道内容（官方/社区/我的三通道之一，通道 chips 由 body 渲染）：
 * 只列当前页签类型下手动添加的条目（manual-<type>-<id>.json 标记），
 * 提供该类型的添加入口与卸载/启停。数据源独立于市场索引，自管刷新与 busy。
 */
export function MinePage({
  tab,
  onUseSkill,
  onOpenSkill,
  onOpenPlugin,
  onConnectOauth,
  oauthFlowPlatform,
  oauthConnectedPlatforms,
  query = "",
}: {
  tab: MarketTab;
  /** 技能行「使用」：与市场卡片同链路，跳转对话并挂技能引用 chip */
  onUseSkill: (entry: { id: string; name: string }) => void;
  /** 点技能行：打开技能详情弹窗（本地技能读 SKILL.md 正文） */
  onOpenSkill?: (entry: MineSkillEntry) => void;
  /** 点插件行：打开插件详情页 */
  onOpenPlugin?: (id: string) => void;
  /** 待配置 OAuth MCP（Undermind 等）：点一下走桌面主进程浏览器授权 */
  onConnectOauth?: (payload: { id: string; env: string; platform: OauthPlatform }) => void;
  oauthFlowPlatform?: OauthPlatform | null;
  oauthConnectedPlatforms?: Partial<Record<OauthPlatform, boolean>>;
  /** 顶部搜索词（搜索框在 MarketplaceBody，与官方市场同一个位置） */
  query?: string;
}) {
  const { t } = useTranslation("marketplace");
  const [list, setList] = useState<MineListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  /** 待确认解除授权的 MCP（清本机 token + 断开，需二次确认） */
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  const markBusy = useCallback((key: string, active: boolean) => {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      setList(await listMine());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>): Promise<void> => {
      markBusy(key, true);
      try {
        await action();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        markBusy(key, false);
      }
    },
    [markBusy, refresh],
  );

  /** MCP 重连/启停要一点时间才落到 statuses：先刷一次，稍后补一次拿最终状态 */
  const refreshLater = useCallback(() => {
    window.setTimeout(() => void refresh(), 1200);
  }, [refresh]);

  /** 手动插件启停：与市场「已加载插件」同一套 settings.plugins.disabled 链路 */
  const togglePlugin = useCallback(
    (id: string, next: boolean) => {
      setError(null);
      void run(`plugin:${id}`, async () => {
        const overview = await listPlugins();
        const nextDisabled = new Set(overview.plugins.filter((p) => !p.enabled).map((p) => p.id));
        if (next) nextDisabled.delete(id);
        else nextDisabled.add(id);
        await setPluginsState([...nextDisabled]);
      });
    },
    [run],
  );

  const toggleMcp = useCallback(
    (id: string, next: boolean) => {
      setError(null);
      void run(`mcp:${id}`, async () => {
        await toggleManualMcp(id, next);
        refreshLater();
      });
    },
    [run, refreshLater],
  );

  const removeEntry = useCallback(
    (type: "skill" | "plugin" | "mcp", id: string) => {
      setError(null);
      void run(`${type}:${id}`, async () => {
        await uninstallMarketplaceItem(id, type);
        if (type === "mcp") refreshLater();
      });
    },
    [run, refreshLater],
  );

  /** 远程 MCP 的协议内授权（与市场页同一条链路）：起浏览器 + 等回环回调 + 重连 */
  const authorizeEntry = useCallback(
    (id: string, force: boolean) => {
      setError(null);
      void run(`mcp:${id}`, async () => {
        await authorizeMcp(id, force);
        refreshLater();
      });
    },
    [run, refreshLater],
  );

  /** 解除远程 MCP 的 OAuth 授权：清本机 token + 断开，状态回到「需要授权」 */
  const revokeEntry = useCallback(
    async (id: string) => {
      setError(null);
      setRevoking(true);
      try {
        await revokeMcp(id);
        setRevokeTarget(null);
        await refresh();
        refreshLater();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRevoking(false);
      }
    },
    [refresh, refreshLater],
  );

  const q = (query ?? "").trim().toLowerCase();  const hit = (...texts: string[]): boolean => !q || texts.some((text) => text.toLowerCase().includes(q));
  const skills = (list?.skills ?? []).filter((item) => hit(item.id, item.name, item.description));
  const plugins = (list?.plugins ?? []).filter((item) => hit(item.id, item.displayName ?? "", item.description ?? ""));
  const mcps = (list?.mcp ?? []).filter((item) => hit(item.id));
  const entries = tab === "skills" ? skills : tab === "plugins" ? plugins : mcps;

  return (
    <>
      <div className="mc-mkt__toolbar">
        {tab === "skills" ? (
          <button type="button" className="mc-mkt__reload" onClick={() => setImportOpen(true)}>
            <LuSparkles size={13} />
            {t("mine.addSkill")}
          </button>
        ) : null}
        {tab === "plugins" ? (
          <button type="button" className="mc-mkt__reload" onClick={() => setImportOpen(true)}>
            <LuPuzzle size={13} />
            {t("mine.addPlugin")}
          </button>
        ) : null}
        {tab === "mcp" ? (
          <button type="button" className="mc-mkt__reload" onClick={() => setMcpOpen(true)}>
            <LuPlug size={13} />
            {t("mine.addMcp")}
          </button>
        ) : null}
        <button type="button" className="mc-mkt__reload" onClick={() => void refresh()} disabled={refreshing}>
          <LuRefreshCw size={13} className={refreshing ? "mc-mkt__spin" : undefined} />
          {t("actions.refresh")}
        </button>
      </div>

      {error ? <p className="mc-mkt__error">{error}</p> : null}
      {list === null && !error ? <p className="mc-mkt__empty">{t("actions.loading")}</p> : null}
      {list !== null && entries.length === 0 ? <p className="mc-mkt__empty">{t("mine.empty")}</p> : null}

      {tab === "skills" ? (
        <div className="mc-mkt__rows">
          {skills.map((entry) => (
            <div className="mc-mkt__row" key={entry.id}>
              <MarketIcon entry={{ id: entry.id, name: entry.name, source: "" }} size={30} />
              <button
                type="button"
                className="mc-mkt__rowinfo mc-mkt__rowinfo--clickable"
                onClick={() => onOpenSkill?.(entry)}
                title={t("actions.viewDetails")}
              >
                <div className="mc-mkt__rowname">
                  <span title={entry.id}>{entry.name}</span>
                  <Badge>{t("mine.badge")}</Badge>
                  {entry.status === "missing" ? <Badge tone="danger">{t("mine.missing")}</Badge> : null}
                </div>
                <p className="mc-mkt__rowdesc">{entry.description || t("plugin.noDescription")}</p>
              </button>
              <div className="mc-mkt__badges">
                {entry.status === "ok" ? (
                  <button
                    type="button"
                    className="mc-mkt__install"
                    disabled={busyKeys.has(`skill:${entry.id}`)}
                    onClick={() => onUseSkill({ id: entry.id, name: entry.name })}
                  >
                    <LuMessageSquare size={13} />
                    {t("actions.use")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="mc-mkt__ghost"
                  disabled={busyKeys.has(`skill:${entry.id}`)}
                  onClick={() => removeEntry("skill", entry.id)}
                >
                  {t("actions.uninstall")}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "plugins" ? (
        <div className="mc-mkt__rows">
          {plugins.map((entry) => (
            <div className="mc-mkt__row" key={entry.id}>
              <MarketIcon entry={{ id: entry.id, name: entry.displayName ?? entry.id, source: "" }} size={30} />
              <button
                type="button"
                className="mc-mkt__rowinfo mc-mkt__rowinfo--clickable"
                onClick={() => onOpenPlugin?.(entry.id)}
                title={t("actions.viewDetails")}
              >
                <div className="mc-mkt__rowname">
                  <span title={entry.id}>{entry.displayName ?? entry.id}</span>
                  <Badge>{t("mine.badge")}</Badge>
                  {entry.status === "missing" ? <Badge tone="danger">{t("mine.missing")}</Badge> : null}
                </div>
                <p className="mc-mkt__rowdesc">{entry.error || entry.description || t("plugin.noDescription")}</p>
              </button>
              <div className="mc-mkt__badges">
                <Toggle
                  checked={entry.enabled && entry.status === "ok"}
                  disabled={busyKeys.has(`plugin:${entry.id}`) || entry.status !== "ok"}
                  label={t("plugin.enableAria", { id: entry.id })}
                  onChange={(next) => togglePlugin(entry.id, next)}
                />
                <button
                  type="button"
                  className="mc-mkt__ghost"
                  disabled={busyKeys.has(`plugin:${entry.id}`)}
                  onClick={() => removeEntry("plugin", entry.id)}
                >
                  {t("actions.uninstall")}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "mcp" ? (
        <div className="mc-mkt__rows">
          {mcps.map((entry) => {
            const envName = entry.missingEnv?.[0] ?? "";
            const oauthPlatform = envName ? MCP_ENV_PLATFORMS[envName] : undefined;
            const oauthPending = oauthPlatform != null && oauthFlowPlatform === oauthPlatform;
            const oauthConnected = oauthPlatform != null && oauthConnectedPlatforms?.[oauthPlatform] === true;
            return (
            <div className="mc-mkt__row" key={entry.id}>
              <MarketIcon entry={{ id: entry.id, name: entry.id, source: "" }} size={30} />
              <div className="mc-mkt__rowinfo">
                <div className="mc-mkt__rowname">
                  <span title={entry.id}>{entry.id}</span>
                  <Badge>{t("mine.badge")}</Badge>
                  {entry.status === "missing" ? <Badge tone="danger">{t("mine.missing")}</Badge> : null}
                </div>
                {entry.status === "ok" ? (
                  <p className="mc-mkt__rowdesc">
                    <McpStatusBadge
                      state={
                        entry.mcpStatus
                          ? {
                              status: entry.mcpStatus,
                              toolCount: entry.toolCount ?? 0,
                              error: entry.error,
                              missingEnv: entry.missingEnv,
                            }
                          : undefined
                      }
                    />
                  </p>
                ) : null}
              </div>
              <div className="mc-mkt__badges">
                {oauthPlatform && onConnectOauth && (!oauthConnected || entry.mcpStatus === "failed") ? (
                  <button
                    type="button"
                    className="mc-mkt__connect"
                    disabled={oauthPending}
                    onClick={() =>
                      onConnectOauth({ id: entry.id, env: envName, platform: oauthPlatform })
                    }
                  >
                    {oauthPending
                      ? t("oauth.awaitingBrowser")
                      : oauthConnected
                        ? t("actions.reauthorize")
                        : t("oauth.connectPlatform", {
                            platform: t(`platforms.${oauthPlatform}`),
                          })}
                  </button>
                ) : null}
                {!oauthPlatform &&
                entry.oauthCapable &&
                entry.mcpStatus &&
                entry.mcpStatus !== "ready" &&
                entry.mcpStatus !== "unconfigured" ? (
                  <button
                    type="button"
                    className="mc-mkt__connect"
                    disabled={busyKeys.has(`mcp:${entry.id}`)}
                    title={entry.error ?? t("mcp.authorizeTitle")}
                    onClick={() => authorizeEntry(entry.id, entry.mcpStatus === "failed")}
                  >
                    {busyKeys.has(`mcp:${entry.id}`)
                      ? t("mcp.authorizing")
                      : entry.mcpStatus === "failed"
                        ? t("mcp.reauthorize")
                        : t("mcp.authorize")}
                  </button>
                ) : null}
                {!oauthPlatform && entry.oauthCapable && entry.mcpStatus === "ready" ? (
                  <button
                    type="button"
                    className="mc-mkt__ghost"
                    disabled={busyKeys.has(`mcp:${entry.id}`)}
                    title={t("body.disconnect.title", { platform: entry.id })}
                    onClick={() => setRevokeTarget(entry.id)}
                  >
                    {t("actions.disconnect")}
                  </button>
                ) : null}
                {entry.status === "ok" ? (
                  <Toggle
                    checked={entry.enabled}
                    disabled={busyKeys.has(`mcp:${entry.id}`)}
                    label={t("mine.mcp.toggleAria", { id: entry.id })}
                    onChange={(next) => toggleMcp(entry.id, next)}
                  />
                ) : null}
                <button
                  type="button"
                  className="mc-mkt__ghost"
                  disabled={busyKeys.has(`mcp:${entry.id}`)}
                  onClick={() => removeEntry("mcp", entry.id)}
                >
                  {t("actions.remove")}
                </button>
              </div>
            </div>
            );
          })}
        </div>
      ) : null}

      {tab !== "mcp" ? (
        <ManualImportDialog
          open={importOpen}
          type={tab === "skills" ? "skill" : "plugin"}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false);
            void refresh();
          }}
        />
      ) : null}
      {tab === "mcp" ? (
        <ManualMcpDialog
          open={mcpOpen}
          onClose={() => setMcpOpen(false)}
          onSaved={() => {
            setMcpOpen(false);
            void refresh();
            refreshLater();
          }}
        />
      ) : null}

      <Dialog
        open={revokeTarget !== null}
        onClose={() => {
          if (!revoking) setRevokeTarget(null);
        }}
        labelledBy="mc-mcp-revoke-title"
      >
        <span className="mc-dialog__title" id="mc-mcp-revoke-title">
          {t("body.disconnect.title", { platform: revokeTarget ?? "" })}
        </span>
        <p className="mc-dialog__desc">
          {t("body.disconnect.desc", { platform: revokeTarget ?? "" })}
          {t("body.disconnect.platformHint", { platform: revokeTarget ?? "" })}
        </p>
        <div className="mc-dialog__footer">
          <Button variant="ghost" disabled={revoking} onClick={() => setRevokeTarget(null)}>
            {t("actions.cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={revoking}
            onClick={() => {
              if (revokeTarget) void revokeEntry(revokeTarget);
            }}
          >
            {revoking ? t("actions.disconnecting") : t("actions.disconnect")}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
