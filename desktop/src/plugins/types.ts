import type { ComponentType, ReactNode } from "react";
import type { PluginDescriptor, PluginPermission } from "../api";

/** 首版固定的 UI 槽位。新增槽位只改这里和对应宿主组件。 */
export type SlotName =
  | "rail.actions"
  | "pages"
  | "titlebar.actions"
  | "home.widgets"
  | "session.header.actions"
  | "composer.banner"
  | "composer.actions"
  | "message.toolCard"
  | "settings.sections";

/** 注册到 `pages` 的页面条目：id 在插件内唯一，会出现在左侧导航与页面导航里。 */
export type PluginPageEntry = {
  id: string;
  title: string;
  /** data URL / http 图片，或单字符 emoji/文本；缺省用标题首字 */
  icon?: string;
  order?: number;
};

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
};

/** 宿主提供给插件 UI 的受控动作；App 注入具体实现。 */
export type PluginHostActions = {
  sendPrompt: (text: string) => Promise<void>;
  insertComposerText: (text: string) => void;
  openPanel: (pluginId: string) => void;
  toast: (message: string, kind?: "info" | "success" | "error") => void;
  openExternal: (url: string) => Promise<void>;
  /** 切到宿主主视图（chat / settings / plugin:...） */
  openView: (view: string) => void;
  showChat: () => void;
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
  actions: {
    sendPrompt: (text: string) => Promise<void>;
    insertComposerText: (text: string) => void;
    openPanel: (panelId: string) => void;
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
