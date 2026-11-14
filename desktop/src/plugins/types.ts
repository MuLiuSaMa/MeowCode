import type { ComponentType, ReactNode } from "react";
import type { PluginDescriptor, PluginPermission } from "../api";
import type { PluginSlotName } from "../../../src/plugins/ui-slots";

/** 槽位名来自 src/plugins/ui-slots.ts 的单一目录，宿主与 Agent 速查共用。 */
export type SlotName = PluginSlotName;

/** 注册到 `pages` / `rightpanel.tabs` 的条目：id 在插件内唯一。 */
export type PluginPageEntry = {
  id: string;
  title: string;
  /** data URL / http 图片，或单字符 emoji/文本；缺省用标题首字 */
  icon?: string;
  order?: number;
};

export type PluginTabEntry = PluginPageEntry;

/** 贡献项元数据：id 在插件内唯一；toolCard 用 key 命中工具名。 */
export type SlotEntry = {
  id: string;
  order?: number;
  key?: string;
  title?: string;
  icon?: string;
};

export type SlotContribution = {
  pluginId: string;
  slot: SlotName;
  entry: SlotEntry;
  component: ComponentType<Record<string, unknown>>;
  /** 注册顺序，order 相同时用它稳定排序 */
  seq: number;
};

export type PluginAppState = {
  sessionId?: string;
  workspace?: string;
  theme: "light" | "dark";
  locale: string;
  /** 当前主视图：chat / settings / plugin:<pluginId>:<pageId> … */
  view: string;
  /** 当前会话是否有回合在跑 */
  running: boolean;
  /** 当前聊天模式（default / plan / …） */
  mode: string;
};

export type PluginWindowControl = {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onStateChange: (listener: (state: { isMaximized: boolean }) => void) => () => void;
};

/** 宿主提供给插件 UI 的受控动作；App 注入具体实现。 */
export type PluginHostActions = {
  sendPrompt: (text: string) => Promise<void>;
  stopTurn: () => void;
  insertComposerText: (text: string) => void;
  openPanel: (pluginId: string) => void;
  openFile: (path: string) => void;
  /** 打开插件注册的右侧检查器页签 */
  openPluginTab: (request: {
    pluginId: string;
    tabId: string;
    title: string;
    icon?: string;
  }) => void;
  toast: (message: string, kind?: "info" | "success" | "error") => void;
  openExternal: (url: string) => Promise<void>;
  /** 切到宿主主视图（chat / settings / plugin:...） */
  openView: (view: string) => void;
  showChat: () => void;
  window: PluginWindowControl;
};

export type PluginClientContext = {
  plugin: {
    id: string;
    name: string;
    version: string;
    permissions: PluginPermission[];
  };
  slots: {
    register: (
      name: SlotName,
      entry: SlotEntry,
      component: ComponentType<Record<string, unknown>>,
    ) => () => void;
  };
  /** 页面注册：自动出现在左侧导航与页面导航，打开后占满主内容区。 */
  pages: {
    register: (
      entry: PluginPageEntry,
      component: ComponentType<Record<string, unknown>>,
    ) => () => void;
  };
  /** 右侧检查器页签注册：用 actions.openTab 打开。 */
  tabs: {
    register: (
      entry: PluginTabEntry,
      component: ComponentType<Record<string, unknown>>,
    ) => () => void;
  };
  actions: {
    sendPrompt: (text: string) => Promise<void>;
    stopTurn: () => void;
    insertComposerText: (text: string) => void;
    openPanel: (panelId: string) => void;
    openFile: (path: string) => void;
    /** 打开自己的（或指定插件的）右侧检查器页签 */
    openTab: (tabId: string, pluginId?: string) => void;
    toast: (message: string, kind?: "info" | "success" | "error") => void;
    openExternal: (url: string) => Promise<void>;
    /** 打开页面（pageId 是 pages.register 的 id；pluginId 缺省为自己，可跨插件跳转） */
    openPage: (pageId: string, pluginId?: string) => void;
    /** 切到宿主内置视图 */
    openView: (view: "chat" | "settings" | "plugins" | "git" | "automation" | "architecture") => void;
    /** 回到对话主视图 */
    showChat: () => void;
  };
  store: {
    getState: () => PluginAppState;
    subscribe: (listener: () => void) => () => void;
  };
  hooks: {
    /** 在插件组件里订阅宿主状态（React hook）。 */
    useAppState: () => PluginAppState;
  };
  window: PluginWindowControl;
  rpc: {
    call: (method: string, args?: unknown) => Promise<unknown>;
  };
  storage: {
    get: <T = unknown>(key: string) => Promise<T | undefined>;
    set: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  timers: {
    setTimeout: (fn: () => void, ms: number) => () => void;
    setInterval: (fn: () => void, ms: number) => () => void;
  };
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

/** `ui/client.js` 的返回值：对象形式或函数形式。 */
export type PluginClientModule =
  | { apply: (ctx: PluginClientContext) => unknown }
  | ((ctx: PluginClientContext) => unknown);

export type PluginHandle = {
  pluginId: string;
  dispose: () => void;
};

export type PluginRuntimeError = {
  pluginId: string;
  message: string;
};

export type PluginRuntimeProps = {
  actions: PluginHostActions;
  state: PluginAppState;
  children: ReactNode;
};

export type PluginConsentRequest = {
  descriptor: PluginDescriptor;
  permissions: PluginPermission[];
};
