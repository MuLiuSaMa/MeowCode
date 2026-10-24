import { useCallback, useEffect, useMemo, useState } from "react";
import { LuRefreshCw } from "react-icons/lu";
import {
  installMarketplaceItem,
  listMarketplace,
  listPlugins,
  setPluginsState,
  uninstallMarketplaceItem,
  MCP_ENV_PLATFORMS,
  MCP_PLATFORM_LABELS,
  type MarketplaceEntry,
  type OauthPlatform,
  type OauthPlatformStatus,
  type PluginsOverview,
  type PluginDescriptor,
} from "../../api";
import { GithubConnectDialog } from "./GithubConnectDialog";
import { PlatformOauthDialog } from "./PlatformOauthDialog";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { MarketplaceCard } from "./MarketplaceCard";
import { MarketplaceDetailDialog } from "./MarketplaceDetailDialog";
import { PluginDetailPage } from "./PluginDetailPage";
import { InstalledPluginRow, McpRow } from "./McpRow";
import type { MarketTab } from "./MarketplaceNav";
import "./marketplace.css";

const CATEGORIES = ["全部", "开发工具", "界面设计", "内容创作", "效率提升", "数据分析"] as const;

const TAB_TYPE = { plugins: "plugin", skills: "skill", mcp: "mcp" } as const;

/** 市场条目对应的 OAuth 平台（Gitee / GitCode） */
function oauthPlatformOf(entry: MarketplaceEntry): OauthPlatform | undefined {
  return MCP_ENV_PLATFORMS[(entry.requiresEnv ?? [])[0] ?? ""];
}

/**
 * 市场主体（占主内容槽）：搜索 + 分类 chips + 已安装分区 + 卡片网格/列表。
 * 数据并行来自 GET /marketplace（索引+安装态+图标）与 GET /plugins（已加载插件/MCP 运行状态）。
 * 点击技能卡片 → 详情弹窗；点击插件卡片 → 详情页；技能「使用」→ 安装（若未装）+ 跳转对话引用。
 */
export function MarketplaceBody({
  tab,
  onUseSkill,
}: {
  tab: MarketTab;
  onUseSkill: (entry: MarketplaceEntry, iconUrl?: string) => void;
}) {
  const [items, setItems] = useState<MarketplaceEntry[] | null>(null);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [overview, setOverview] = useState<PluginsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("全部");
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  /** 任一条目操作中：仅用于全局刷新/弹窗禁用，卡片按钮按条目独立 busy */
  const busy = busyKeys.size > 0;
  const isBusy = useCallback(
    (type: MarketplaceEntry["type"], id: string) => busyKeys.has(`${type}:${id}`),
    [busyKeys],
  );
  const markBusy = useCallback((key: string, active: boolean) => {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [refreshing, setRefreshing] = useState(false);
  /** 技能详情弹窗 */
  const [dialogEntry, setDialogEntry] = useState<MarketplaceEntry | null>(null);
  /** 插件详情页（占整个主体） */
  const [pluginPageId, setPluginPageId] = useState<string | null>(null);
  /** GitHub OAuth 是否已连接（token 在主进程，不暴露给渲染层） */
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubDialogOpen, setGithubDialogOpen] = useState(false);
  /** Gitee/GitCode OAuth 连接状态（token 在主进程） */
  const [oauthStatus, setOauthStatus] = useState<Record<OauthPlatform, OauthPlatformStatus> | null>(
    null,
  );
  /** 正在走浏览器授权的平台：starting=打开浏览器中，pending=等待回调 */
  const [oauthFlow, setOauthFlow] = useState<{
    platform: OauthPlatform;
    phase: "starting" | "pending";
  } | null>(null);
  const [oauthTarget, setOauthTarget] = useState<
    { platform: OauthPlatform; entry: MarketplaceEntry } | null
  >(null);
  const [disconnectTarget, setDisconnectTarget] = useState<
    { platform: "github" | OauthPlatform; label: string } | null
  >(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const [marketResult, pluginsResult, authResult, oauthResult] = await Promise.all([
        listMarketplace(),
        listPlugins(),
        window.meow.githubAuthStatus
          ? window.meow.githubAuthStatus().catch(() => null)
          : Promise.resolve(null),
        window.meow.oauthStatus
          ? window.meow.oauthStatus().catch(() => null)
          : Promise.resolve(null),
      ]);
      setItems(marketResult.items);
      setIcons(marketResult.icons);
      setOverview(pluginsResult);
      setGithubConnected(Boolean(authResult?.connected));
      setOauthStatus(oauthResult);
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

  /** 插件启停（settings.plugins.disabled 全局合并，重启 server 生效） */
  const disabledIds = useMemo(
    () => new Set((overview?.plugins ?? []).filter((p) => !p.enabled).map((p) => p.id)),
    [overview],
  );

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

  const install = useCallback(
    (entry: MarketplaceEntry) => {
      setError(null);
      void run(`${entry.type}:${entry.id}`, () => installMarketplaceItem(entry.id, entry.type));
    },
    [run],
  );

  const uninstall = useCallback(
    (entry: MarketplaceEntry) => {
      setError(null);
      void run(`${entry.type}:${entry.id}`, () => uninstallMarketplaceItem(entry.id, entry.type));
    },
    [run],
  );

  /** OAuth 成功后立即刷新；MCP 重连需要一点时间，再补一次状态 */
  const handleMcpConnected = useCallback(() => {
    void refresh();
    window.setTimeout(() => void refresh(), 1200);
  }, [refresh]);

  /**
   * 「连接 Gitee / GitCode」点一下直接用系统浏览器授权：
   * 已配好凭据时完全不弹表单；只有首次缺 Client Secret 才打开配置弹窗。
   */
  const connectOauth = useCallback(
    async (row: MarketplaceEntry) => {
      const platform = oauthPlatformOf(row);
      if (!platform || oauthFlow) return;
      setError(null);
      setOauthFlow({ platform, phase: "starting" });
      try {
        const result = await window.meow.oauthConnectStart({ platform });
        if (!result.ok) {
          setOauthFlow(null);
          if (result.needsClientSecret) {
            setOauthTarget({ platform, entry: row });
          } else {
            setError(result.message);
          }
          return;
        }
        setOauthFlow({ platform, phase: "pending" });
        const openError = await window.meow.openExternal(result.authorizeUrl);
        if (openError) {
          setOauthFlow(null);
          void window.meow.oauthConnectCancel?.({ platform });
          setError(`无法自动打开系统浏览器：${openError}`);
        }
      } catch (err) {
        setOauthFlow(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [oauthFlow],
  );

  const cancelOauth = useCallback(() => {
    const platform = oauthFlow?.platform;
    setOauthFlow(null);
    if (platform) void window.meow.oauthConnectCancel?.({ platform });
  }, [oauthFlow]);

  // 浏览器回跳是主进程收的：这里只轮询结果，成功后刷新 MCP 状态
  useEffect(() => {
    if (!oauthFlow || oauthFlow.phase !== "pending") return;
    const platform = oauthFlow.platform;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (cancelled) return;
      try {
        const result = await window.meow.oauthConnectPoll({ platform });
        if (cancelled) return;
        if (result.status === "pending") {
          timer = window.setTimeout(tick, 1000);
          return;
        }
        setOauthFlow(null);
        if (result.status === "success") {
          if (result.warning) setError(result.warning);
          handleMcpConnected();
          return;
        }
        setError(result.message || "授权失败，请重试。");
      } catch (err) {
        if (cancelled) return;
        setOauthFlow(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    timer = window.setTimeout(tick, 1000);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      void window.meow.oauthConnectCancel?.({ platform });
    };
  }, [oauthFlow, handleMcpConnected]);

  const runDisconnect = useCallback(async () => {
    if (!disconnectTarget) return;
    setDisconnecting(true);
    try {
      const result =
        disconnectTarget.platform === "github"
          ? await window.meow.githubDisconnect()
          : await window.meow.oauthDisconnect({ platform: disconnectTarget.platform });
      if (disconnectTarget.platform === "github") setGithubConnected(false);
      setDisconnectTarget(null);
      await refresh();
      if (result.warning) setError(result.warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDisconnecting(false);
    }
  }, [disconnectTarget, refresh]);

  const handleOauthSaved = useCallback(
    (warning?: string) => {
      setOauthTarget(null);
      void refresh();
      window.setTimeout(() => void refresh(), 1200);
      if (warning) setError(warning);
    },
    [refresh],
  );

  const togglePlugin = useCallback(
    (descriptor: PluginDescriptor, next: boolean) => {
      const nextDisabled = new Set(disabledIds);
      if (next) nextDisabled.delete(descriptor.id);
      else nextDisabled.add(descriptor.id);
      setError(null);
      void run(`plugin:${descriptor.id}`, () => setPluginsState([...nextDisabled]));
    },
    [disabledIds, run],
  );

  const uninstallPlugin = useCallback(
    (id: string) => {
      setError(null);
      void run(`plugin:${id}`, async () => {
        await uninstallMarketplaceItem(id, "plugin");
        const nextDisabled = new Set(disabledIds);
        nextDisabled.delete(id);
        await setPluginsState([...nextDisabled]);
        setPluginPageId(null);
      });
    },
    [disabledIds, run],
  );

  const iconUrlOf = useCallback(
    (entry: MarketplaceEntry): string | undefined => icons[`${entry.type}:${entry.id}`],
    [icons],
  );

  /** 使用技能：未安装先装（本地复制，快），再跳转对话引用（带图标给 chip） */
  const useSkill = useCallback(
    (entry: MarketplaceEntry) => {
      setError(null);
      const iconUrl = iconUrlOf(entry);
      if (entry.installed) {
        onUseSkill(entry, iconUrl);
        return;
      }
      const key = `skill:${entry.id}`;
      markBusy(key, true);
      void installMarketplaceItem(entry.id, "skill")
        .then(() => refresh())
        .then(() => onUseSkill({ ...entry, installed: true }, iconUrl))
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => markBusy(key, false));
    },
    [iconUrlOf, markBusy, onUseSkill, refresh],
  );

  const tabItems = useMemo(
    () => (items ?? []).filter((entry) => entry.type === TAB_TYPE[tab]),
    [items, tab],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tabItems.filter((entry) => {
      // 分类筛选只属于技能页；切到插件/MCP 后不再套用，避免内容被过滤成空
      if (tab === "skills" && category !== "全部" && entry.category !== category) return false;
      if (!q) return true;
      return (
        entry.name.toLowerCase().includes(q) ||
        entry.id.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [tabItems, query, category]);

  const installedItems = useMemo(() => filtered.filter((entry) => entry.installed), [filtered]);
  /** skills 页签全部直接显示卡片（使用=自动装+跳转引用），plugins/mcp 只显示未安装的 */
  const availableItems = useMemo(
    () => (tab === "skills" ? filtered : filtered.filter((entry) => !entry.installed)),
    [filtered, tab],
  );

  /** 已加载的插件 descriptor（含用户手放的非市场插件） */
  const pluginDescriptors = useMemo(() => {
    if (tab !== "plugins") return [];
    const q = query.trim().toLowerCase();
    return (overview?.plugins ?? []).filter((p) => {
      // 已加载插件不在市场索引里，没有分类可言，只按关键词过滤
      if (!q) return true;
      return p.id.toLowerCase().includes(q) || (p.toolNames ?? []).some((t) => t.toLowerCase().includes(q));
    });
  }, [tab, overview, query]);

  const mcpStates = overview?.mcp ?? {};
  const pluginPageEntry = useMemo(
    () =>
      pluginPageId
        ? (items ?? []).find((entry) => entry.type === "plugin" && entry.id === pluginPageId) ?? null
        : null,
    [items, pluginPageId],
  );

  // ---- 插件详情页（覆盖整个主体）----
  if (tab === "plugins" && pluginPageEntry) {
    return (
      <PluginDetailPage
        entry={pluginPageEntry}
        iconUrl={iconUrlOf(pluginPageEntry)}
        descriptor={(overview?.plugins ?? []).find((p) => p.id === pluginPageEntry.id)}
        busy={isBusy("plugin", pluginPageEntry.id)}
        onBack={() => setPluginPageId(null)}
        onInstall={install}
        onToggle={togglePlugin}
        onUninstall={(pageEntry) => uninstallPlugin(pageEntry.id)}
      />
    );
  }
  return (
    <div className="mc-mkt__body">
      <div className="mc-mkt__inner">
        <div className="mc-mkt__toolbar">
          <input
            type="search"
            className="mc-mkt__search"
            placeholder={tab === "mcp" ? "搜索 MCP" : tab === "skills" ? "搜索技能" : "搜索插件"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="mc-mkt__reload"
            onClick={() => void refresh()}
            disabled={refreshing || busy}
          >
            <LuRefreshCw size={13} className={refreshing ? "mc-mkt__spin" : undefined} />
            刷新
          </button>
        </div>

        {tab === "skills" ? (
          <div className="mc-mkt__chips" role="tablist" aria-label="分类筛选">
            {CATEGORIES.map((item) => (
              <button
                key={item}
                type="button"
                className="mc-mkt__chip"
                data-active={category === item}
                onClick={() => setCategory(item)}
              >
                {item}
              </button>
            ))}
          </div>
        ) : null}

        {error ? <p className="mc-mkt__error">{error}</p> : null}
        {items === null && !error ? <p className="mc-mkt__empty">加载中…</p> : null}

        {/* ---- MCP 页签：全部为列表行 ---- */}
        {tab === "mcp" ? (
          <>
            {installedItems.length > 0 ? (
              <p className="mc-mkt__section">已安装（{installedItems.length}）</p>
            ) : null}
            <div className="mc-mkt__rows">
              {installedItems.map((entry) => (
                <McpRow
                  key={entry.id}
                  entry={entry}
                  iconUrl={iconUrlOf(entry)}
                  state={mcpStates[entry.id]}
                  busy={isBusy("mcp", entry.id)}
                  onInstall={install}
                  onUninstall={uninstall}
                  githubConnected={githubConnected}
                  onConnectGithub={() => setGithubDialogOpen(true)}
                  onDisconnectGithub={() =>
                    setDisconnectTarget({ platform: "github", label: "GitHub" })
                  }
                  oauthConnected={
                    MCP_ENV_PLATFORMS[(entry.requiresEnv ?? [])[0] ?? ""]
                      ? Boolean(
                          oauthStatus?.[MCP_ENV_PLATFORMS[(entry.requiresEnv ?? [])[0] ?? ""]]
                            ?.connected,
                        )
                      : undefined
                  }
                  oauthPending={
                    Boolean(oauthPlatformOf(entry)) &&
                    oauthFlow?.platform === oauthPlatformOf(entry)
                  }
                  onCancelOauth={cancelOauth}
                  onConnectOauth={connectOauth}
                  onDisconnectOauth={(row) => {
                    const platform = MCP_ENV_PLATFORMS[(row.requiresEnv ?? [])[0] ?? ""];
                    if (platform) {
                      setDisconnectTarget({ platform, label: MCP_PLATFORM_LABELS[platform] });
                    }
                  }}
                />
              ))}
            </div>
            {availableItems.length > 0 ? (
              <p className="mc-mkt__section">可安装（{availableItems.length}）</p>
            ) : null}
            <div className="mc-mkt__rows">
              {availableItems.map((entry) => (
                <McpRow
                  key={entry.id}
                  entry={entry}
                  iconUrl={iconUrlOf(entry)}
                  state={undefined}
                  busy={isBusy("mcp", entry.id)}
                  onInstall={install}
                  onUninstall={uninstall}
                  githubConnected={githubConnected}
                  onConnectGithub={() => setGithubDialogOpen(true)}
                  onDisconnectGithub={() =>
                    setDisconnectTarget({ platform: "github", label: "GitHub" })
                  }
                  oauthConnected={
                    MCP_ENV_PLATFORMS[(entry.requiresEnv ?? [])[0] ?? ""]
                      ? Boolean(
                          oauthStatus?.[MCP_ENV_PLATFORMS[(entry.requiresEnv ?? [])[0] ?? ""]]
                            ?.connected,
                        )
                      : undefined
                  }
                  oauthPending={
                    Boolean(oauthPlatformOf(entry)) &&
                    oauthFlow?.platform === oauthPlatformOf(entry)
                  }
                  onCancelOauth={cancelOauth}
                  onConnectOauth={connectOauth}
                  onDisconnectOauth={(row) => {
                    const platform = MCP_ENV_PLATFORMS[(row.requiresEnv ?? [])[0] ?? ""];
                    if (platform) {
                      setDisconnectTarget({ platform, label: MCP_PLATFORM_LABELS[platform] });
                    }
                  }}
                />
              ))}
            </div>
            {filtered.length === 0 && items !== null ? (
              <p className="mc-mkt__empty">没有匹配的 MCP 服务。</p>
            ) : null}
          </>
        ) : (
          <>
            {/* ---- 已安装分区：插件带启停 Toggle，技能只带卸载 ---- */}
            {tab === "plugins" && pluginDescriptors.length > 0 ? (
              <>
                <p className="mc-mkt__section">已加载插件（{pluginDescriptors.length}）</p>
                <div className="mc-mkt__rows">
                  {pluginDescriptors.map((descriptor) => (
                    <InstalledPluginRow
                      key={descriptor.id}
                      descriptor={descriptor}
                      description={
                        (items ?? []).find((entry) => entry.type === "plugin" && entry.id === descriptor.id)
                          ?.description
                      }
                      iconUrl={icons[`plugin:${descriptor.id}`]}
                      busy={isBusy("plugin", descriptor.id)}
                      onToggle={togglePlugin}
                      onUninstall={(descriptor) => uninstallPlugin(descriptor.id)}
                      onOpen={(descriptor) => setPluginPageId(descriptor.id)}
                    />
                  ))}
                </div>
              </>
            ) : null}

            {tab === "skills" && filtered.length > 0 ? (
              <p className="mc-mkt__section">
                技能（{filtered.length}） · 点击「使用」跳转对话引用，未安装的会自动先装
              </p>
            ) : null}

            {availableItems.length > 0 && tab !== "skills" ? (
              <p className="mc-mkt__section">
                可安装（{availableItems.length}）
                {tab === "plugins" ? " · 插件装到全局，安装后立即生效 · 点击卡片查看详情" : ""}
              </p>
            ) : null}
            <div className="mc-mkt__grid">
              {availableItems.map((entry) => (
                <MarketplaceCard
                  key={entry.id}
                  entry={entry}
                  iconUrl={iconUrlOf(entry)}
                  busy={isBusy(entry.type, entry.id)}
                  onInstall={install}
                  onUse={useSkill}
                  onOpen={(target) => {
                    if (target.type === "skill") setDialogEntry(target);
                    else if (target.type === "plugin") setPluginPageId(target.id);
                  }}
                />
              ))}
            </div>
            {availableItems.length === 0 && filtered.length === 0 && items !== null ? (
              <p className="mc-mkt__empty">没有匹配的{tab === "skills" ? "技能" : "插件"}。</p>
            ) : null}
          </>
        )}
      </div>

      {/* 技能详情弹窗：底部「使用」= 自动安装并跳转对话引用 */}
      <MarketplaceDetailDialog
        entry={dialogEntry}
        iconUrl={dialogEntry ? iconUrlOf(dialogEntry) : undefined}
        busy={dialogEntry ? isBusy(dialogEntry.type, dialogEntry.id) : false}
        onClose={() => setDialogEntry(null)}
        onUse={(target) => {
          setDialogEntry(null);
          useSkill(target);
        }}
      />

      <GithubConnectDialog
        open={githubDialogOpen}
        onClose={() => setGithubDialogOpen(false)}
        onConnected={handleMcpConnected}
      />

      <PlatformOauthDialog
        platform={oauthTarget?.platform ?? null}
        entry={oauthTarget?.entry ?? null}
        status={oauthTarget ? oauthStatus?.[oauthTarget.platform] : undefined}
        open={Boolean(oauthTarget)}
        onClose={() => setOauthTarget(null)}
        onSaved={handleOauthSaved}
      />

      <Dialog
        open={Boolean(disconnectTarget)}
        onClose={() => {
          if (!disconnecting) setDisconnectTarget(null);
        }}
        labelledBy="mc-mcp-disconnect-title"
      >
        <span className="mc-dialog__title" id="mc-mcp-disconnect-title">
          解除 {disconnectTarget?.label ?? ""} 授权
        </span>
        <p className="mc-dialog__desc">
          会删除本机保存的 {disconnectTarget?.label ?? ""} token，并立即断开{" "}
          {disconnectTarget?.label ?? ""} MCP。平台上的授权记录不会自动撤销；如需彻底撤销，请到{" "}
          {disconnectTarget?.label ?? ""} 设置 → 授权应用里移除 MeowCode。
        </p>
        <div className="mc-dialog__footer">
          <Button
            variant="ghost"
            disabled={disconnecting}
            onClick={() => setDisconnectTarget(null)}
          >
            取消
          </Button>
          <Button
            variant="danger"
            disabled={disconnecting}
            onClick={() => void runDisconnect()}
          >
            {disconnecting ? "正在解除…" : "解除授权"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
