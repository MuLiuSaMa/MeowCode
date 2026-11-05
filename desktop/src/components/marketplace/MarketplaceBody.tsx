import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuImport, LuRefreshCw, LuUpload } from "react-icons/lu";
import {
  installMarketplaceItem,
  installCommunityMarketplaceItem,
  installThirdPartySkill,
  listMarketplace,
  listCommunityMarketplace,
  listThirdPartySkills,
  listPlugins,
  setPluginsState,
  uninstallMarketplaceItem,
  MCP_ENV_PLATFORMS,
  type MarketplaceEntryLike,
  type OauthPlatform,
  type OauthPlatformStatus,
  type PluginsOverview,
  type PluginDescriptor,
  type ThirdPartySource,
} from "../../api";
import { CommunitySubmitDialog } from "./CommunitySubmitDialog";
import { GithubConnectDialog } from "./GithubConnectDialog";
import { ManualImportDialog } from "./ManualImportDialog";
import { ManualMcpDialog } from "./ManualMcpDialog";
import { ManualTokenDialog } from "./ManualTokenDialog";
import { MinePage } from "./MinePage";
import { PlatformOauthDialog } from "./PlatformOauthDialog";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { MarketplaceCard } from "./MarketplaceCard";
import { MarketplaceDetailDialog } from "./MarketplaceDetailDialog";
import { PluginDetailPage } from "./PluginDetailPage";
import { InstalledPluginRow, McpRow } from "./McpRow";
import type { MarketTab } from "./MarketplaceNav";
import {
  CATEGORY_FILTERS,
  categoryValue,
  type MarketplaceCategoryFilter,
} from "./marketplace-categories";
import "./marketplace.css";

const TAB_TYPE = { plugins: "plugin", skills: "skill", mcp: "mcp" } as const;

/** 内置插件不在市场索引里：从 descriptor 合成一个市场条目，详情页照常渲染 */
function builtinEntry(descriptor: PluginDescriptor): MarketplaceEntryLike {
  return {
    id: descriptor.id,
    type: "plugin",
    name: descriptor.displayName ?? descriptor.id,
    description: descriptor.description ?? "",
    category: categoryValue("builtin") ?? "",
    source: "builtin",
    tags: ["claude-code", "hooks"],
    version: "1.0",
    installed: true,
  };
}

/** 数据通道：官方 = 打包内置索引；第三方 = ClawHub/SkillHub 聚合；社区 = GitCode 收录仓库 */
type MarketChannel = "official" | "thirdparty" | "community" | "mine";

/** 市场条目对应的 OAuth 平台（Gitee / GitCode） */
function oauthPlatformOf(entry: MarketplaceEntryLike): OauthPlatform | undefined {
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
  onOpenPluginPanel,
}: {
  tab: MarketTab;
  onUseSkill: (entry: MarketplaceEntryLike, iconUrl?: string) => void;
  /** 打开插件自带的面板页签（仅带 ui/index.html 的插件） */
  onOpenPluginPanel?: (pluginId: string, title: string) => void;
}) {
  const { t } = useTranslation("marketplace");
  const [channel, setChannel] = useState<MarketChannel>("official");
  const [items, setItems] = useState<MarketplaceEntryLike[] | null>(null);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [overview, setOverview] = useState<PluginsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<MarketplaceCategoryFilter>("all");
  /** 第三方通道：源子筛选 + 各源健康状态 + 防抖后的搜索词（搜索走服务端） */
  const [tpSource, setTpSource] = useState<"all" | ThirdPartySource>("all");
  const [tpSources, setTpSources] = useState<Record<ThirdPartySource, "ok" | "failed"> | null>(null);
  const [tpQuery, setTpQuery] = useState("");
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  /** 社区插件安装前的风险确认（源码在 agent 进程内执行） */
  const [pluginConfirm, setPluginConfirm] = useState<MarketplaceEntryLike | null>(null);
  /** 社区条目提交弹窗（应用内 fork → 分支 → 上传 → PR） */
  const [submitOpen, setSubmitOpen] = useState(false);
  /** 手动导入弹窗（skill/plugin 按页签，mcp 走表单）：条目进「我的」通道 */
  const [importOpen, setImportOpen] = useState(false);
  /** GitCode 社区登录名（判定「我的条目」显示删除入口） */
  const [communityLogin, setCommunityLogin] = useState<string | null>(null);
  /** 删除确认/执行弹窗 */
  const [deleteTarget, setDeleteTarget] = useState<MarketplaceEntryLike | null>(null);
  const [deletePhase, setDeletePhase] = useState<"confirm" | "running" | "done">("confirm");
  const [deleteMessage, setDeleteMessage] = useState("");
  const [deletePrUrl, setDeletePrUrl] = useState("");
  /** 任一条目操作中：仅用于全局刷新/弹窗禁用，卡片按钮按条目独立 busy */
  const busy = busyKeys.size > 0;
  const isBusy = useCallback(
    (type: MarketplaceEntryLike["type"], id: string) => busyKeys.has(`${type}:${id}`),
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
  const [dialogEntry, setDialogEntry] = useState<MarketplaceEntryLike | null>(null);
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
    { platform: OauthPlatform; entry: MarketplaceEntryLike } | null
  >(null);
  const [manualTokenEntry, setManualTokenEntry] = useState<MarketplaceEntryLike | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<
    | { platform: "github" | OauthPlatform; label: string }
    | { env: string; label: string }
    | null
  >(null);
  const [disconnecting, setDisconnecting] = useState(false);
  /** 第三方通道翻页游标（各源下一页；null = 没有更多或非第三方通道） */
  const [tpCursors, setTpCursors] = useState<Partial<Record<ThirdPartySource, string>> | null>(null);

  /**
   * 边界归一化：社区收录（GitCode 仓库直读）与手动导入的条目可能缺 tags/description
   * 甚至给非字符串值，类型标了 string[] 但数据不保证——不补齐的话搜索框一输入就崩白屏
   */
  const normalizeEntries = useCallback(
    (entries: MarketplaceEntryLike[]): MarketplaceEntryLike[] =>
      entries.map((entry) => ({
        ...entry,
        id: typeof entry.id === "string" ? entry.id : String(entry.id ?? ""),
        name: typeof entry.name === "string" ? entry.name : "",
        description: typeof entry.description === "string" ? entry.description : "",
        tags: Array.isArray(entry.tags) ? entry.tags.map((tag) => String(tag)) : [],
      })),
    [],
  );

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      setRefreshing(true);
      try {
        // 三通道返回形状归一化：社区/官方无源健康状态与翻页游标
        const [marketResult, pluginsResult, authResult, oauthResult] = await Promise.all([
          channel === "community"
            ? listCommunityMarketplace(force).then((r) => ({
                items: r.items as MarketplaceEntryLike[],
                icons: r.icons,
                sources: null as Record<ThirdPartySource, "ok" | "failed"> | null,
                nextCursors: null as Partial<Record<ThirdPartySource, string>> | null,
              }))
            : channel === "thirdparty"
              ? listThirdPartySkills({
                  ...(tpQuery.trim() ? { query: tpQuery.trim() } : {}),
                  ...(tpSource !== "all" ? { source: tpSource } : {}),
                  ...(force ? { refresh: true } : {}),
                }).then((r) => ({
                  items: r.items as MarketplaceEntryLike[],
                  icons: r.icons,
                  sources: r.sources,
                  nextCursors: r.nextCursors,
                }))
              : listMarketplace().then((r) => ({
                  items: r.items as MarketplaceEntryLike[],
                  icons: r.icons,
                  sources: null as Record<ThirdPartySource, "ok" | "failed"> | null,
                  nextCursors: null as Partial<Record<ThirdPartySource, string>> | null,
                })),
          listPlugins(),
          window.meow.githubAuthStatus
            ? window.meow.githubAuthStatus().catch(() => null)
            : Promise.resolve(null),
          window.meow.oauthStatus
            ? window.meow.oauthStatus().catch(() => null)
            : Promise.resolve(null),
        ]);
        if (marketResult.sources) setTpSources(marketResult.sources);
        setTpCursors(
          marketResult.nextCursors && Object.keys(marketResult.nextCursors).length
            ? marketResult.nextCursors
            : null,
        );
        setIcons(marketResult.icons ?? {});
        setItems(normalizeEntries(marketResult.items ?? []));
        setOverview(pluginsResult);
        setGithubConnected(Boolean(authResult?.connected));
        setOauthStatus(oauthResult);
        if (channel === "community") {
          try {
            const user = await window.meow.communityUser?.();
            setCommunityLogin(user?.loggedIn ? user.login : null);
          } catch {
            setCommunityLogin(null);
          }
        } else {
          setCommunityLogin(null);
        }
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRefreshing(false);
      }
    },
    [channel, tpQuery, tpSource, normalizeEntries],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 切通道立即清空列表：旧通道内容不留屏，加载中就显示加载
  useEffect(() => {
    setItems(null);
    setTpSources(null);
    setTpCursors(null);
  }, [channel]);

  /** 第三方通道加载更多：带各源游标取下一页，按 id 去重后追加 */
  const loadMoreThirdParty = useCallback(async (): Promise<void> => {
    if (!tpCursors || refreshing) return;
    setRefreshing(true);
    try {
      const result = await listThirdPartySkills({
        ...(tpQuery.trim() ? { query: tpQuery.trim() } : {}),
        ...(tpSource !== "all" ? { source: tpSource } : {}),
        cursors: tpCursors,
      });
      setTpSources(result.sources);
      setTpCursors(
        Object.keys(result.nextCursors).length ? result.nextCursors : null,
      );
      setIcons((prev) => ({ ...prev, ...result.icons }));
      setItems((prev) => {
        const known = new Set((prev ?? []).map((entry) => entry.id));
        return [
          ...(prev ?? []),
          ...normalizeEntries(result.items).filter((entry) => !known.has(entry.id)),
        ];
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, [tpCursors, tpQuery, tpSource, refreshing, normalizeEntries]);

  // 第三方通道搜索走服务端：输入防抖 800ms 后才真正发请求
  useEffect(() => {
    if (channel !== "thirdparty") return;
    const timer = window.setTimeout(() => setTpQuery(query), 800);
    return () => window.clearTimeout(timer);
  }, [channel, query]);

  // 第三方通道只在技能页存在：切走页签时回落到官方，避免通道与页签错位
  useEffect(() => {
    if (channel === "thirdparty" && tab !== "skills") setChannel("official");
  }, [channel, tab]);

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

  /** 实际安装调用按条目通道分流（官方 /marketplace/install vs 社区 /marketplace/community/install vs 第三方 /marketplace/thirdparty/install） */
  const installApi = useCallback(
    (entry: MarketplaceEntryLike) =>
      entry.channel === "community"
        ? installCommunityMarketplaceItem(entry.id, entry.type)
        : entry.channel === "thirdparty"
          ? installThirdPartySkill(entry.id)
          : installMarketplaceItem(entry.id, entry.type),
    [],
  );

  const install = useCallback(
    (entry: MarketplaceEntryLike) => {
      setError(null);
      // 社区插件是 TypeScript 源码，装完即在 agent 进程内执行：安装前强制确认
      if (entry.channel === "community" && entry.type === "plugin") {
        setPluginConfirm(entry);
        return;
      }
      void run(`${entry.type}:${entry.id}`, () => installApi(entry));
    },
    [installApi, run],
  );

  const uninstall = useCallback(
    (entry: MarketplaceEntryLike) => {
      setError(null);
      // 社区条目写的是官方同格式安装标记：卸载统一走官方接口
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
    async (row: MarketplaceEntryLike) => {
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
          setError(t("body.browserOpenFailed", { reason: openError }));
        }
      } catch (err) {
        setOauthFlow(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [oauthFlow, t],
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
        setError(result.message || t("oauth.authFailed"));
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
  }, [oauthFlow, handleMcpConnected, t]);

  const runDisconnect = useCallback(async () => {
    if (!disconnectTarget) return;
    setDisconnecting(true);
    try {
      let result: { warning?: string };
      if ("env" in disconnectTarget) {
        result = await window.meow.clearMcpToken({ name: disconnectTarget.env });
      } else if (disconnectTarget.platform === "github") {
        result = await window.meow.githubDisconnect();
        setGithubConnected(false);
      } else {
        result = await window.meow.oauthDisconnect({ platform: disconnectTarget.platform });
      }
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

  const handleManualTokenSaved = useCallback(
    (warning?: string) => {
      setManualTokenEntry(null);
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
    (entry: MarketplaceEntryLike): string | undefined => icons[`${entry.type}:${entry.id}`],
    [icons],
  );

  /** 「我的条目」判定：作者本人或仓库主（主进程同样会校验） */
  const canDeleteEntry = useCallback(
    (entry: MarketplaceEntryLike) =>
      channel === "community" &&
      Boolean(communityLogin) &&
      (!entry.author ||
        entry.author.toLowerCase() === communityLogin?.toLowerCase() ||
        communityLogin?.toLowerCase() === "muliuisama"),
    [channel, communityLogin],
  );

  /** 社区删除：确认弹窗点下去后走 fork → 删文件分支 → 删除 PR */
  const runDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeletePhase("running");
    setDeleteMessage(t("body.deleteRunning"));
    try {
      const result = await window.meow.communityDelete({
        id: deleteTarget.id,
        type: deleteTarget.type,
        name: deleteTarget.name,
        author: deleteTarget.author,
      });
      if (result.ok && result.prUrl) {
        setDeletePrUrl(result.prUrl);
        setDeleteMessage(t("body.deletePrCreated"));
        setDeletePhase("done");
        window.setTimeout(() => void refresh(true), 1500);
      } else {
        setDeleteMessage(result.message ?? t("body.deleteFailed"));
        setDeletePhase("confirm");
      }
    } catch (err) {
      setDeleteMessage(err instanceof Error ? err.message : String(err));
      setDeletePhase("confirm");
    }
  }, [deleteTarget, refresh, t]);

  /** 使用技能：未安装先装（本地复制，快），再跳转对话引用（带图标给 chip） */
  const useSkill = useCallback(
    (entry: MarketplaceEntryLike) => {
      setError(null);
      const iconUrl = iconUrlOf(entry);
      if (entry.installed) {
        onUseSkill(entry, iconUrl);
        return;
      }
      const key = `skill:${entry.id}`;
      markBusy(key, true);
      void installApi(entry)
        .then(() => refresh())
        .then(() => onUseSkill({ ...entry, installed: true }, iconUrl))
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => markBusy(key, false));
    },
    [iconUrlOf, installApi, markBusy, onUseSkill, refresh],
  );

  const tabItems = useMemo(
    () => (items ?? []).filter((entry) => entry.type === TAB_TYPE[tab]),
    [items, tab],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tabItems.filter((entry) => {
      // 分类筛选只属于技能页（第三方通道有自己的源筛选，不套用类目）；
      // 切到插件/MCP 后不再套用，避免内容被过滤成空
      if (
        tab === "skills" &&
        channel !== "thirdparty" &&
        category !== "all" &&
        entry.category !== categoryValue(category)
      )
        return false;
      if (!q) return true;
      const tags = Array.isArray(entry.tags) ? entry.tags : [];
      return (
        (entry.name ?? "").toLowerCase().includes(q) ||
        (entry.id ?? "").toLowerCase().includes(q) ||
        (entry.description ?? "").toLowerCase().includes(q) ||
        tags.some((tag) => String(tag).toLowerCase().includes(q))
      );
    });
  }, [tabItems, query, category, channel]);

  const installedItems = useMemo(() => filtered.filter((entry) => entry.installed), [filtered]);
  /**
   * 全量显示卡片：skills 页签（使用=自动装+跳转引用）、社区插件页签（已安装的同样列出，
   * 才能看到「更新」按钮）；官方 plugins/mcp 只显示未安装的（已安装走各自的行/分区）。
   */
  const availableItems = useMemo(
    () =>
      tab === "skills" || (tab === "plugins" && channel === "community")
        ? filtered
        : filtered.filter((entry) => !entry.installed),
    [filtered, tab, channel],
  );

  /** 已加载的插件 descriptor（含用户手放的非市场插件） */
  const pluginDescriptors = useMemo(() => {
    if (tab !== "plugins") return [];
    const q = query.trim().toLowerCase();
    return (overview?.plugins ?? []).filter((p) => {
      // 已加载插件不在市场索引里，没有分类可言，只按关键词过滤
      if (!q) return true;
      return (p.id ?? "").toLowerCase().includes(q) || (p.toolNames ?? []).some((t) => String(t).toLowerCase().includes(q));
    });
  }, [tab, overview, query]);

  const mcpStates = overview?.mcp ?? {};
  const pluginPageEntry = useMemo(() => {
    if (!pluginPageId) return null;
    const found = (items ?? []).find((entry) => entry.type === "plugin" && entry.id === pluginPageId);
    if (found) return found;
    // 市场索引里没有（内置插件）：从已加载 descriptor 合成条目
    const builtinDescriptor = (overview?.plugins ?? []).find(
      (p) => p.id === pluginPageId && p.source === "builtin",
    );
    return builtinDescriptor ? builtinEntry(builtinDescriptor) : null;
  }, [items, pluginPageId, overview]);

  // 官方/第三方/社区/我的通道 chips：mine 早退渲染也要显示，提出来共用
  const channelChips = (
    <div className="mc-mkt__channels" role="tablist" aria-label={t("body.channelAriaLabel")}>
      <button
        type="button"
        className="mc-mkt__chip"
        data-active={channel === "official"}
        onClick={() => setChannel("official")}
      >
        {t("channel.official")}
      </button>
      {tab === "skills" ? (
        <button
          type="button"
          className="mc-mkt__chip"
          data-active={channel === "thirdparty"}
          onClick={() => setChannel("thirdparty")}
        >
          {t("channel.thirdParty")}
        </button>
      ) : null}
      <button
        type="button"
        className="mc-mkt__chip"
        data-active={channel === "community"}
        onClick={() => setChannel("community")}
      >
        {t("channel.community")}
      </button>
      <button
        type="button"
        className="mc-mkt__chip"
        data-active={channel === "mine"}
        onClick={() => setChannel("mine")}
      >
        {t("channel.mine")}
      </button>
    </div>
  );

  // ---- 「我的」通道：手动条目管理，数据源独立于市场索引 ----
  if (channel === "mine") {
    return (
      <div className="mc-mkt__body">
        <div className="mc-mkt__inner">
          {channelChips}
          <MinePage tab={tab} />
        </div>
      </div>
    );
  }

  // ---- 插件详情页（覆盖整个主体）----
  if (tab === "plugins" && pluginPageEntry) {
    const pageDescriptor = (overview?.plugins ?? []).find((p) => p.id === pluginPageEntry.id);
    return (
      <PluginDetailPage
        entry={pluginPageEntry}
        iconUrl={pageDescriptor?.iconUrl ?? iconUrlOf(pluginPageEntry)}
        descriptor={pageDescriptor}
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
            placeholder={
              tab === "mcp"
                ? t("body.search.mcp")
                : tab === "skills"
                  ? t("body.search.skills")
                  : t("body.search.plugins")
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {channel === "community" ? (
            <button type="button" className="mc-mkt__reload" onClick={() => setSubmitOpen(true)}>
              <LuUpload size={13} />
              {t("body.submitEntry")}
            </button>
          ) : null}
          <button type="button" className="mc-mkt__reload" onClick={() => setImportOpen(true)}>
            <LuImport size={13} />
            {t("actions.import")}
          </button>
          <button
            type="button"
            className="mc-mkt__reload"
            onClick={() => void refresh(channel === "community")}
            disabled={refreshing || busy}
            title={channel === "community" ? t("body.forceRefreshTitle") : undefined}
          >
            <LuRefreshCw size={13} className={refreshing ? "mc-mkt__spin" : undefined} />
            {t("actions.refresh")}
          </button>
        </div>

        {/* 官方/社区/我的通道切换：三个页签通用 */}
        {channelChips}

        {tab === "skills" && channel === "thirdparty" ? (
          <div className="mc-mkt__chips" role="tablist" aria-label={t("body.sourceAriaLabel")}>
            {(["all", "clawhub", "skillhub"] as const).map((item) => (
              <button
                key={item}
                type="button"
                className="mc-mkt__chip"
                data-active={tpSource === item}
                onClick={() => setTpSource(item)}
              >
                {t(`sources.${item}`)}
              </button>
            ))}
          </div>
        ) : tab === "skills" ? (
          <div className="mc-mkt__chips" role="tablist" aria-label={t("body.categoryAriaLabel")}>
            {CATEGORY_FILTERS.map((item) => (
              <button
                key={item}
                type="button"
                className="mc-mkt__chip"
                data-active={category === item}
                onClick={() => setCategory(item)}
              >
                {t(`categories.${item}`)}
              </button>
            ))}
          </div>
        ) : null}

        {error ? <p className="mc-mkt__error">{error}</p> : null}
        {/* 第三方单源失败：列表照常显示成功源，失败源给重试入口 */}
        {channel === "thirdparty" && tpSources
          ? (["clawhub", "skillhub"] as const)
              .filter((item) => tpSources[item] === "failed")
              .map((item) => (
                <div key={item} className="mc-mkt__tpfail">
                  <span>{t("body.thirdPartySourceFailed", { source: t(`sources.${item}`) })}</span>
                  <button type="button" className="mc-mkt__ghost" onClick={() => void refresh(true)}>
                    {t("actions.retry")}
                  </button>
                </div>
              ))
          : null}
        {items === null && !error ? <p className="mc-mkt__empty">{t("actions.loading")}</p> : null}

        {/* ---- MCP 页签：全部为列表行 ---- */}
        {tab === "mcp" ? (
          <>
            {installedItems.length > 0 ? (
              <p className="mc-mkt__section">
                {t("body.section.installed", { count: installedItems.length })}
              </p>
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
                  onSetManualToken={setManualTokenEntry}
                  onDisconnectManualToken={(row) => {
                    const env = (row.requiresEnv ?? [])[0];
                    if (env) setDisconnectTarget({ env, label: row.name });
                  }}
                  onDisconnectOauth={(row) => {
                    const platform = MCP_ENV_PLATFORMS[(row.requiresEnv ?? [])[0] ?? ""];
                    if (platform) {
                      setDisconnectTarget({ platform, label: t(`platforms.${platform}`) });
                    }
                  }}
                  onDelete={(row) => {
                    setDeleteTarget(row);
                    setDeletePhase("confirm");
                    setDeleteMessage("");
                    setDeletePrUrl("");
                  }}
                  canDelete={canDeleteEntry(entry)}
                />
              ))}
            </div>
            {availableItems.length > 0 ? (
              <p className="mc-mkt__section">
                {t("body.section.installable", { count: availableItems.length })}
              </p>
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
                  onSetManualToken={setManualTokenEntry}
                  onDisconnectManualToken={(row) => {
                    const env = (row.requiresEnv ?? [])[0];
                    if (env) setDisconnectTarget({ env, label: row.name });
                  }}
                  onDisconnectOauth={(row) => {
                    const platform = MCP_ENV_PLATFORMS[(row.requiresEnv ?? [])[0] ?? ""];
                    if (platform) {
                      setDisconnectTarget({ platform, label: t(`platforms.${platform}`) });
                    }
                  }}
                  onDelete={(row) => {
                    setDeleteTarget(row);
                    setDeletePhase("confirm");
                    setDeleteMessage("");
                    setDeletePrUrl("");
                  }}
                  canDelete={canDeleteEntry(entry)}
                />
              ))}
            </div>
            {filtered.length === 0 && items !== null ? (
              <p className="mc-mkt__empty">
                {t(channel === "community" ? "body.empty.mcpCommunity" : "body.empty.mcpOfficial")}
              </p>
            ) : null}
          </>
        ) : (
          <>
            {/* ---- 已加载分区：仅官方通道（本机加载的插件与社区条目无关）---- */}
            {tab === "plugins" && channel === "official" && pluginDescriptors.length > 0 ? (
              <>
                <p className="mc-mkt__section">
                  {t("body.section.loadedPlugins", { count: pluginDescriptors.length })}
                </p>
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
                      onOpenPanel={
                        onOpenPluginPanel
                          ? (descriptor) =>
                              onOpenPluginPanel(
                                descriptor.id,
                                descriptor.ui?.panel.title ?? descriptor.displayName ?? descriptor.id,
                              )
                          : undefined
                      }
                    />
                  ))}
                </div>
              </>
            ) : null}

            {tab === "skills" && filtered.length > 0 ? (
              <p className="mc-mkt__section">
                {t("body.section.skills", { count: filtered.length })}
              </p>
            ) : null}

            {availableItems.length > 0 && tab !== "skills" ? (
              <p className="mc-mkt__section">
                {t(
                  channel === "community"
                    ? "body.section.communityPlugins"
                    : "body.section.pluginsInstallable",
                  { count: availableItems.length },
                )}
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
                  onDelete={(target) => {
                    setDeleteTarget(target);
                    setDeletePhase("confirm");
                    setDeleteMessage("");
                    setDeletePrUrl("");
                  }}
                  canDelete={canDeleteEntry(entry)}
                  onOpen={(target) => {
                    if (target.type === "skill") setDialogEntry(target);
                    else if (target.type === "plugin") setPluginPageId(target.id);
                  }}
                />
              ))}
            </div>
            {availableItems.length === 0 && filtered.length === 0 && items !== null ? (
              <p className="mc-mkt__empty">
                {tab === "skills"
                  ? t(
                      channel === "thirdparty"
                        ? "body.empty.skillThirdParty"
                        : channel === "community"
                          ? "body.empty.skillCommunity"
                          : "body.empty.skillOfficial",
                    )
                  : t(
                      channel === "community"
                        ? "body.empty.pluginCommunity"
                        : "body.empty.pluginOfficial",
                    )}
              </p>
            ) : null}

            {/* 第三方通道翻页：还有下一页游标就给「加载更多」 */}
            {channel === "thirdparty" && tpCursors ? (
              <button
                type="button"
                className="mc-mkt__reload mc-mkt__loadmore"
                disabled={refreshing || busy}
                onClick={() => void loadMoreThirdParty()}
              >
                <LuRefreshCw size={13} className={refreshing ? "mc-mkt__spin" : undefined} />
                {t("actions.loadMore")}
              </button>
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

      {/* 社区插件风险确认：源码装完即在 agent 进程内执行，必须用户点头 */}
      <Dialog
        open={pluginConfirm !== null}
        onClose={() => {
          if (!isBusy("plugin", pluginConfirm?.id ?? "")) setPluginConfirm(null);
        }}
        labelledBy="mc-community-plugin-confirm-title"
      >
        <span className="mc-dialog__title" id="mc-community-plugin-confirm-title">
          {t("body.pluginConfirm.title", { name: pluginConfirm?.name ?? "" })}
        </span>
        <p className="mc-dialog__desc">
          {t("body.pluginConfirm.desc")}
          {pluginConfirm?.author ? (
            <>
              <br />
              {t("card.authorTitle", { author: pluginConfirm.author })}
              {pluginConfirm.homepage ? (
                <>
                  {" · "}
                  <a href={pluginConfirm.homepage} target="_blank" rel="noreferrer">
                    {t("body.pluginConfirm.homepage")}
                  </a>
                </>
              ) : null}
            </>
          ) : null}
          <br />
          {t("body.pluginConfirm.checkSource")}
        </p>
        <div className="mc-dialog__footer">
          <Button variant="ghost" onClick={() => setPluginConfirm(null)}>
            {t("actions.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              const entry = pluginConfirm;
              setPluginConfirm(null);
              if (entry) {
                void run(`${entry.type}:${entry.id}`, () => installApi(entry));
              }
            }}
          >
            {t("body.pluginConfirm.accept")}
          </Button>
        </div>
      </Dialog>

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

      <ManualTokenDialog
        entry={manualTokenEntry}
        open={Boolean(manualTokenEntry)}
        onClose={() => setManualTokenEntry(null)}
        onSaved={handleManualTokenSaved}
      />

      {/* 社区条目提交：类型跟随当前页签 */}
      <CommunitySubmitDialog
        open={submitOpen}
        defaultType={tab === "mcp" ? "mcp" : tab === "plugins" ? "plugin" : "skill"}
        onClose={() => {
          setSubmitOpen(false);
          if (channel === "community") void refresh(true);
        }}
      />

      {/* 社区条目删除：确认 → 执行（fork 删文件分支 → 删除 PR）→ 结果 */}
      <Dialog
        open={deleteTarget !== null}
        onClose={() => {
          if (deletePhase !== "running") setDeleteTarget(null);
        }}
        labelledBy="mc-community-delete-title"
      >
        {deletePhase === "done" ? (
          <>
            <span className="mc-dialog__title" id="mc-community-delete-title">
              {t("body.delete.doneTitle")}
            </span>
            <p className="mc-dialog__desc">{deleteMessage}</p>
            {deletePrUrl ? (
              <p className="mc-dialog__desc">
                <a href={deletePrUrl} target="_blank" rel="noreferrer">
                  {deletePrUrl}
                </a>
              </p>
            ) : null}
            <div className="mc-dialog__footer">
              <Button variant="primary" onClick={() => setDeleteTarget(null)}>
                {t("actions.done")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="mc-dialog__title" id="mc-community-delete-title">
              {t("body.delete.title", { name: deleteTarget?.name ?? "" })}
            </span>
            <p className="mc-dialog__desc">{t("body.delete.desc")}</p>
            {deleteMessage ? <p className="mc-dialog__desc">{deleteMessage}</p> : null}
            <div className="mc-dialog__footer">
              <Button variant="ghost" disabled={deletePhase === "running"} onClick={() => setDeleteTarget(null)}>
                {t("actions.cancel")}
              </Button>
              <Button variant="danger" disabled={deletePhase === "running"} onClick={() => void runDelete()}>
                {deletePhase === "running" ? t("actions.submitting") : t("body.delete.action")}
              </Button>
            </div>
          </>
        )}
      </Dialog>

      <Dialog
        open={Boolean(disconnectTarget)}
        onClose={() => {
          if (!disconnecting) setDisconnectTarget(null);
        }}
        labelledBy="mc-mcp-disconnect-title"
      >
        <span className="mc-dialog__title" id="mc-mcp-disconnect-title">
          {t("body.disconnect.title", { platform: disconnectTarget?.label ?? "" })}
        </span>
        <p className="mc-dialog__desc">
          {t("body.disconnect.desc", { platform: disconnectTarget?.label ?? "" })}
          {disconnectTarget && "env" in disconnectTarget
            ? t("body.disconnect.envHint")
            : t("body.disconnect.platformHint", { platform: disconnectTarget?.label ?? "" })}
        </p>
        <div className="mc-dialog__footer">
          <Button
            variant="ghost"
            disabled={disconnecting}
            onClick={() => setDisconnectTarget(null)}
          >
            {t("actions.cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={disconnecting}
            onClick={() => void runDisconnect()}
          >
            {disconnecting ? t("actions.disconnecting") : t("actions.disconnect")}
          </Button>
        </div>
      </Dialog>

      {/* 手动导入：skill/plugin 按当前页签选类型，mcp 走表单/JSON；条目进「我的」通道 */}
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
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onSaved={() => {
            setImportOpen(false);
            void refresh();
            window.setTimeout(() => void refresh(), 1200);
          }}
        />
      ) : null}
    </div>
  );
}
