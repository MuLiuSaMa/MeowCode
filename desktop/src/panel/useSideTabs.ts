import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

/**
 * 右侧面板（RightPanel）的页签状态。
 * 借鉴 ZCode 的 side pane 页签模型，但只保留本应用需要的形态：
 * home 恒在且不可关；browser 恒新增；file 按路径去重；review/sidechat/terminal 单例。
 * 页签内容由 RightPanel 常挂载渲染（非激活 display:none），保证 webview / 终端保活。
 */

export type SideTab =
  | { id: "home"; kind: "home"; title: string }
  | { id: string; kind: "browser"; title: string; url: string; agent?: boolean }
  | { id: string; kind: "workspace"; title: string; path?: string }
  | { id: string; kind: "review" | "sidechat" | "plan" | "subagents"; title: string }
  | { id: string; kind: "terminal"; title: string; termId?: string }
  | { id: string; kind: "plugin"; title: string; pluginId: string }
  | {
      id: string;
      kind: "subagent";
      title: string;
      agentId: string;
      parentSessionId: string;
      callId?: string;
      description?: string;
    };

export type SideTabOpen =
  | { kind: "browser"; url: string; title?: string }
  | { kind: "plugin"; pluginId: string; title: string }
  | { kind: "workspace" | "review" | "sidechat" | "terminal" | "plan" | "subagents" };

export type SubagentTabOpen = {
  agentId: string;
  parentSessionId: string;
  callId?: string;
  description: string;
};

/**
 * 单例页签的标题只存 key：在 hook 里按当前语言查表后再交给渲染，
 * 切语言即时刷新。用户数据（路径、网址、子 Agent 描述）仍存在 title 里。
 */
const SINGLETON_TITLE_KEYS: Record<
  "workspace" | "review" | "sidechat" | "terminal" | "plan" | "subagents",
  string
> = {
  workspace: "tabs.workspace",
  review: "tabs.review",
  sidechat: "tabs.sidechat",
  terminal: "tabs.terminal",
  plan: "tabs.plan",
  subagents: "tabs.subagents",
};

const HOME_TAB: SideTab = { id: "home", kind: "home", title: "" };

let tabSeq = 0;
function nextTabId(kind: string): string {
  tabSeq += 1;
  return `${kind}-${tabSeq}`;
}

function subagentTab(request: SubagentTabOpen) {
  const description = request.description;
  return {
    id: `subagent-${request.agentId}`,
    kind: "subagent" as const,
    // 描述是用户数据；为空时由标题表补「子 Agent」
    title: description,
    agentId: request.agentId,
    parentSessionId: request.parentSessionId,
    ...(request.callId ? { callId: request.callId } : {}),
    description,
  };
}

/** 查表补标题：单例页签按 kind 取 key，子 Agent 无描述时用兜底文案。 */
function resolveTitle(tab: SideTab, t: TFunction<"panel">): SideTab {
  if (tab.kind === "browser") return tab;
  if (tab.kind === "subagent") return tab.title ? tab : { ...tab, title: t("tabs.subagent") };
  if (tab.kind === "home") return { ...tab, title: t("tabs.home") };
  // 插件页签的标题是插件名（用户数据），不参与 i18n
  if (tab.kind === "plugin") return tab;
  // 后台任务终端用命令作为标题
  if (tab.kind === "terminal" && tab.termId) return tab;
  return { ...tab, title: t(SINGLETON_TITLE_KEYS[tab.kind]) };
}

/** 用户数据的页签保留 title；其余页签的 title 由 key 现算，恢复时清掉旧译文。 */
function isDataTitleTab(tab: SideTab): boolean {
  return (
    tab.kind === "browser" ||
    tab.kind === "subagent" ||
    tab.kind === "plugin" ||
    (tab.kind === "terminal" && Boolean(tab.termId))
  );
}

export function useSideTabs() {
  const { t } = useTranslation("panel");
  const [tabs, setTabs] = useState<SideTab[]>([HOME_TAB]);
  const [activeId, setActiveId] = useState<string>("home");
  /** 文件快开面板开关（Ctrl+P） */
  const [paletteOpen, setPaletteOpen] = useState(false);

  /** 启动时用 ui-state 恢复页签；home 恒在且不可关。 */
  const hydrate = useCallback((restored: SideTab[], restoredActiveId?: string) => {
    const seen = new Set<string>();
    const unique: SideTab[] = [];
    for (const tab of restored) {
      if (!tab || tab.id === "home" || seen.has(tab.id)) continue;
      // PTY 不跨应用重启：昨天的后台任务终端恢复出来只剩空壳
      if (tab.kind === "terminal" && tab.termId) continue;
      seen.add(tab.id);
      // 持久化的是上次的译文：非用户数据的页签清掉，渲染时按当前语言重算
      unique.push(isDataTitleTab(tab) ? tab : { ...tab, title: "" });
    }
    setTabs([HOME_TAB, ...unique]);
    const nextActive =
      restoredActiveId &&
      (restoredActiveId === "home" || unique.some((tab) => tab.id === restoredActiveId))
        ? restoredActiveId
        : (unique[0]?.id ?? "home");
    setActiveId(nextActive);
    for (const tab of unique) {
      const numeric = Number(tab.id.split("-").pop());
      if (Number.isFinite(numeric) && numeric > tabSeq) tabSeq = numeric;
    }
  }, []);

  const activate = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const open = useCallback(
    (request: SideTabOpen) => {
      if (request.kind === "browser") {
        const tab: SideTab = {
          id: nextTabId("browser"),
          kind: "browser",
          title: request.title ?? request.url,
          url: request.url,
        };
        setTabs((current) => [...current, tab]);
        setActiveId(tab.id);
        return;
      }
      if (request.kind === "plugin") {
        // 一个插件一个页签：按 pluginId 复用
        const existingPlugin = tabs.find(
          (tab) => tab.kind === "plugin" && tab.pluginId === request.pluginId,
        );
        if (existingPlugin) {
          setActiveId(existingPlugin.id);
          return;
        }
        const pluginTab: SideTab = {
          id: nextTabId("plugin"),
          kind: "plugin",
          title: request.title,
          pluginId: request.pluginId,
        };
        setTabs((current) => [...current, pluginTab]);
        setActiveId(pluginTab.id);
        return;
      }
      const existing = tabs.find((tab) => tab.kind === request.kind);
      if (existing) {
        setActiveId(existing.id);
        return;
      }
      const tab: SideTab = {
        id: nextTabId(request.kind),
        kind: request.kind,
        title: "",
      };
      setTabs((current) => [...current, tab]);
      setActiveId(tab.id);
    },
    [tabs],
  );

  /** 在「文件」页签里选中某个文件（页签不存在则先建） */
  const openFile = useCallback(
    (path: string) => {
      const existing = tabs.find((tab) => tab.kind === "workspace");
      if (existing) {
        setTabs((current) =>
          current.map((tab) => (tab.id === existing.id ? { ...tab, path } : tab)),
        );
        setActiveId(existing.id);
        return;
      }
      const tab: SideTab = {
        id: nextTabId("workspace"),
        kind: "workspace",
        title: "",
        path,
      };
      setTabs((current) => [...current, tab]);
      setActiveId(tab.id);
    },
    [tabs],
  );

  /**
   * 事件驱动的自动展开：单例页签不存在才新建并激活；已存在什么都不做（不抢当前页签）。
   * 返回是否新建了页签（调用方据此决定是否展开检查器）。
   * id 用确定性值，避免 StrictMode 双跑时两次调用生成不同 id 导致激活到不存在的页签。
   */
  const openIfAbsent = useCallback(
    (kind: "review" | "plan"): boolean => {
      if (tabs.some((tab) => tab.kind === kind)) return false;
      const tab: SideTab = { id: `${kind}-auto`, kind, title: "" };
      setTabs((current) => (current.some((item) => item.kind === kind) ? current : [...current, tab]));
      setActiveId(tab.id);
      return true;
    },
    [tabs],
  );

  /** 子 Agent 页签：一个 agentId 一个只读页签，重复点击只激活并同步最新描述。 */
  const openSubagent = useCallback((request: SubagentTabOpen) => {
    const id = `subagent-${request.agentId}`;
    setTabs((current) => {
      const existing = current.find((tab) => tab.id === id);
      if (existing) {
        return current.map((tab) =>
          tab.id === id
            ? { ...tab, title: request.description || tab.title, description: request.description }
            : tab,
        );
      }
      return [...current, subagentTab(request)];
    });
    setActiveId(id);
  }, []);

  /**
   * 派发时预创建页签：不激活、不抢焦点，只是让用户在等待子 Agent 首字时
   * 就能在页签栏看到它并点开查看「等待模型响应」。
   */
  const prepareSubagent = useCallback((request: SubagentTabOpen) => {
    const id = `subagent-${request.agentId}`;
    setTabs((current) => {
      const existing = current.find((tab) => tab.id === id);
      if (existing) {
        return current.map((tab) =>
          tab.id === id
            ? { ...tab, title: request.description || tab.title, description: request.description }
            : tab,
        );
      }
      return [...current, subagentTab(request)];
    });
  }, []);

  /** 派发时预创建「子 Agent」目录页签；不激活，避免打断当前阅读。 */
  const prepareSubagentsDirectory = useCallback(() => {
    setTabs((current) =>
      current.some((tab) => tab.kind === "subagents")
        ? current
        : [
            ...current,
            { id: "subagents", kind: "subagents" as const, title: "" },
          ],
    );
  }, []);

  /** agent 专属浏览器页签：有就复用（激活并返回 id），没有才新建；用户手动开的页签不受影响 */
  const ensureAgentBrowserTab = useCallback(
    (url: string): string => {
      const existing = tabs.find((tab) => tab.kind === "browser" && tab.agent);
      if (existing) {
        setActiveId(existing.id);
        return existing.id;
      }
      const tab: SideTab = {
        id: nextTabId("browser"),
        kind: "browser",
        title: url,
        url,
        agent: true,
      };
      setTabs((current) => [...current, tab]);
      setActiveId(tab.id);
      return tab.id;
    },
    [tabs],
  );

  /** 后台任务终端：按 termId 去重；已存在时只激活并刷新标题（不抢用户手动开的终端）。 */
  const openJobTerminal = useCallback((termId: string, command: string) => {
    const id = `terminal-${termId}`;
    const title = command.length > 64 ? `${command.slice(0, 61)}…` : command;
    setTabs((current) => {
      if (current.some((tab) => tab.id === id)) {
        return current.map((tab) =>
          tab.id === id ? { ...tab, title: title || tab.title } : tab,
        );
      }
      return [...current, { id, kind: "terminal", title, termId }];
    });
    setActiveId(id);
  }, []);

  const close = useCallback(
    (id: string) => {
      if (id === "home") return;
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return;
      setTabs((current) => current.filter((tab) => tab.id !== id));
      if (activeId === id) {
        setActiveId(tabs[index - 1]?.id ?? "home");
      }
    },
    [tabs, activeId],
  );

  /** 浏览器页签的标题 / 地址回写 */
  const patchTab = useCallback((id: string, patch: { title?: string; url?: string }) => {
    setTabs((current) =>
      current.map((tab) => (tab.id === id ? ({ ...tab, ...patch } as SideTab) : tab)),
    );
  }, []);

  /** 对外暴露的页签：标题按当前语言查表现算，切语言即时刷新 */
  const titledTabs = useMemo(() => tabs.map((tab) => resolveTitle(tab, t)), [tabs, t]);
  const activeTab = titledTabs.find((tab) => tab.id === activeId) ?? titledTabs[0];

  return useMemo(
    () => ({
      tabs: titledTabs,
      activeId,
      activeTab,
      paletteOpen,
      setPaletteOpen,
      open,
      openFile,
      openIfAbsent,
      openSubagent,
      prepareSubagent,
      prepareSubagentsDirectory,
      ensureAgentBrowserTab,
      openJobTerminal,
      close,
      activate,
      patchTab,
      hydrate,
    }),
    [
      titledTabs,
      activeId,
      activeTab,
      paletteOpen,
      open,
      openFile,
      openIfAbsent,
      openSubagent,
      prepareSubagent,
      prepareSubagentsDirectory,
      ensureAgentBrowserTab,
      openJobTerminal,
      close,
      activate,
      patchTab,
      hydrate,
    ],
  );
}
