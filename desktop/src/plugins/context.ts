import {
  pluginRpc,
  pluginStorageDelete,
  pluginStorageGet,
  pluginStorageSet,
  type PluginDescriptor,
} from "../api";
import type { PluginHostBridge } from "./client-loader";
import { requirePermission } from "./permissions";
import { pluginSlots } from "./slot-registry";
import type { PluginAppState, PluginClientContext, PluginHostActions } from "./types";

/** 定时器归属插件生命周期：卸载时统一清理，避免卸载后回调继续跑。 */
export class PluginTimers {
  private readonly handles = new Set<ReturnType<typeof setTimeout>>();

  setTimeout = (fn: () => void, ms: number): (() => void) => {
    const handle = setTimeout(() => {
      this.handles.delete(handle);
      try {
        fn();
      } catch {
        /* 插件回调异常不污染宿主 */
      }
    }, ms);
    this.handles.add(handle);
    return () => {
      clearTimeout(handle);
      this.handles.delete(handle);
    };
  };

  setInterval = (fn: () => void, ms: number): (() => void) => {
    const handle = setInterval(() => {
      try {
        fn();
      } catch {
        /* 同上：定时器异常留在插件边界内 */
      }
    }, ms);
    this.handles.add(handle);
    return () => {
      clearInterval(handle);
      this.handles.delete(handle);
    };
  };

  dispose(): void {
    for (const handle of this.handles) clearTimeout(handle);
    this.handles.clear();
  }
}

export type PluginContextDeps = {
  descriptor: PluginDescriptor;
  actions: PluginHostActions;
  getState: () => PluginAppState;
  subscribeState: (listener: () => void) => () => void;
};

export type PluginContextBundle = {
  ctx: PluginClientContext;
  timers: PluginTimers;
  host: PluginHostBridge;
};

/** 构造一个插件的受限 ctx：每个能力入口都先过 manifest 权限。 */
export function createPluginContext(deps: PluginContextDeps): PluginContextBundle {
  const { descriptor, actions, getState, subscribeState } = deps;
  const timers = new PluginTimers();
  const prefix = `[plugin:${descriptor.id}]`;

  const ctx: PluginClientContext = {
    plugin: {
      id: descriptor.id,
      name: descriptor.displayName ?? descriptor.manifest?.name ?? descriptor.id,
      version: descriptor.manifest?.version ?? descriptor.version ?? "0.0.0",
      permissions: descriptor.manifest?.permissions ?? [],
    },
    slots: {
      register: (name, entry, component) => {
        requirePermission(descriptor, "ui");
        return pluginSlots.register(descriptor.id, name, entry, component);
      },
    },
    pages: {
      register: (entry, component) => {
        requirePermission(descriptor, "ui");
        return pluginSlots.register(
          descriptor.id,
          "pages",
          { ...entry, key: entry.id },
          component,
        );
      },
    },
    actions: {
      sendPrompt: async (text) => {
        requirePermission(descriptor, "prompt");
        await actions.sendPrompt(text);
      },
      insertComposerText: (text) => {
        requirePermission(descriptor, "prompt");
        actions.insertComposerText(text);
      },
      openPanel: (panelId) => {
        requirePermission(descriptor, "ui");
        actions.openPanel(panelId || descriptor.id);
      },
      toast: (message, kind) => {
        requirePermission(descriptor, "ui");
        actions.toast(message, kind);
      },
      openExternal: async (url) => {
        requirePermission(descriptor, "ui");
        await actions.openExternal(url);
      },
      openPage: (pageId, pluginId) => {
        requirePermission(descriptor, "ui");
        actions.openView(`plugin:${pluginId || descriptor.id}:${pageId}`);
      },
      openView: (view) => {
        requirePermission(descriptor, "ui");
        actions.openView(view);
      },
      showChat: () => {
        requirePermission(descriptor, "ui");
        actions.openView("chat");
      },
    },
    store: {
      getState: () => getState(),
      subscribe: (listener) => subscribeState(listener),
    },
    rpc: {
      call: async (method, args) => {
        requirePermission(descriptor, "rpc");
        return pluginRpc(descriptor.id, method, args, getState().sessionId);
      },
    },
    storage: {
      get: async <T = unknown>(key: string) => {
        requirePermission(descriptor, "storage");
        return pluginStorageGet<T>(descriptor.id, key);
      },
      set: async (key, value) => {
        requirePermission(descriptor, "storage");
        await pluginStorageSet(descriptor.id, key, value);
      },
      delete: async (key) => {
        requirePermission(descriptor, "storage");
        await pluginStorageDelete(descriptor.id, key);
      },
    },
    timers: {
      setTimeout: (fn, ms) => {
        requirePermission(descriptor, "ui");
        return timers.setTimeout(fn, ms);
      },
      setInterval: (fn, ms) => {
        requirePermission(descriptor, "ui");
        return timers.setInterval(fn, ms);
      },
    },
    logger: {
      info: (...args) => console.log(prefix, ...args),
      warn: (...args) => console.warn(prefix, ...args),
      error: (...args) => console.error(prefix, ...args),
    },
  };

  return {
    ctx,
    timers,
    host: {
      call: (method, args) => ctx.rpc.call(method, args),
    },
  };
}
