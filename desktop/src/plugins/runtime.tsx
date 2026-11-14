import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { listPlugins, type PluginDescriptor, type Settings } from "../api";
import { invalidatePluginIconMap } from "../data/pluginIcons";
import {
  PluginStyles,
  applyPluginClient,
  evaluatePluginClient,
  fetchPluginClientSource,
  type PluginClientDisposer,
} from "./client-loader";
import { createPluginContext, type PluginTimers } from "./context";
import { reportPluginError, reportPluginLoadError } from "./errors";
import { shouldReloadPlugin } from "./reload";
import { pluginSlots } from "./slot-registry";
import type {
  PluginAppState,
  PluginConsentRequest,
  PluginHostActions,
  SlotName,
} from "./types";
import { PluginConsentDialog } from "./PluginConsentDialog";

type LoadedPlugin = {
  dispose: () => void;
  /** 客户端脚本指纹：变了要 dispose 旧实例、重新 apply */
  rev?: string;
};

type PluginRuntimeValue = {
  pendingConsent: PluginConsentRequest[];
  loading: boolean;
  reload: () => Promise<void>;
};

const PluginRuntimeContext = createContext<PluginRuntimeValue | null>(null);

/** 槽位订阅：registry 变更时重渲染；同内容返回同一数组引用。 */
export function usePluginSlot(name: SlotName, key?: string) {
  return useSyncExternalStore(
    pluginSlots.subscribe,
    () => pluginSlots.get(name, key),
    () => pluginSlots.get(name, key),
  );
}

export function usePluginRuntime(): PluginRuntimeValue | null {
  return useContext(PluginRuntimeContext);
}

type ApprovalRecord = NonNullable<NonNullable<Settings["plugins"]>["approvals"]>[string];

function sameApproval(record: ApprovalRecord | undefined, descriptor: PluginDescriptor): boolean {
  if (!record || record.declined) return false;
  const version = descriptor.manifest?.version ?? descriptor.version ?? "0.0.0";
  if (record.version !== version) return false;
  const declared = descriptor.manifest?.permissions ?? [];
  return declared.every((permission) => record.permissions.includes(permission));
}

/** 读取/写回 settings.plugins.approvals；写失败只影响下次授权记忆。 */
async function readApprovals(): Promise<Record<string, ApprovalRecord>> {
  try {
    const settings = await window.meow?.getSettings?.();
    return settings?.plugins?.approvals ?? {};
  } catch {
    return {};
  }
}

async function writeApproval(pluginId: string, record: ApprovalRecord): Promise<void> {
  try {
    // 轻量偏好通道只写盘：saveSettings 会重启 agent server，把运行中的回合杀掉
    await window.meow?.savePreferences?.({ pluginApprovals: { [pluginId]: record } });
  } catch {
    /* 授权记忆写失败不影响本次加载 */
  }
}

export function PluginRuntimeProvider({
  actions,
  state,
  children,
}: {
  actions: PluginHostActions;
  state: PluginAppState;
  children: ReactNode;
}) {
  const [pendingConsent, setPendingConsent] = useState<PluginConsentRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(new Map<string, LoadedPlugin>());
  const stateRef = useRef(state);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const stateListeners = useRef(new Set<() => void>());
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  /** 传给插件的是稳定对象：内部转发到最新 actions，避免重渲染后拿到旧回调。 */
  const stableActions = useMemo<PluginHostActions>(
    () => ({
      sendPrompt: (text) => actionsRef.current.sendPrompt(text),
      stopTurn: () => actionsRef.current.stopTurn(),
      insertComposerText: (text) => actionsRef.current.insertComposerText(text),
      openPanel: (pluginId) => actionsRef.current.openPanel(pluginId),
      openFile: (path) => actionsRef.current.openFile(path),
      openPluginTab: (request) => actionsRef.current.openPluginTab(request),
      toast: (message, kind) => actionsRef.current.toast(message, kind),
      openExternal: (url) => actionsRef.current.openExternal(url),
      openView: (view) => actionsRef.current.openView(view),
      showChat: () => actionsRef.current.showChat(),
      window: {
        minimize: () => actionsRef.current.window.minimize(),
        toggleMaximize: () => actionsRef.current.window.toggleMaximize(),
        close: () => actionsRef.current.window.close(),
        isMaximized: () => actionsRef.current.window.isMaximized(),
        onStateChange: (listener) => actionsRef.current.window.onStateChange(listener),
      },
    }),
    [],
  );

  const getState = useCallback(() => stateRef.current, []);
  const subscribeState = useCallback((listener: () => void) => {
    stateListeners.current.add(listener);
    return () => stateListeners.current.delete(listener);
  }, []);

  const disposePlugin = useCallback((pluginId: string) => {
    const loaded = loadedRef.current.get(pluginId);
    if (loaded) {
      loaded.dispose();
      loadedRef.current.delete(pluginId);
    }
    pluginSlots.clearPlugin(pluginId);
  }, []);

  const loadDescriptor = useCallback(
    async (descriptor: PluginDescriptor): Promise<void> => {
      const rev = descriptor.ui?.client?.rev;
      const existing = loadedRef.current.get(descriptor.id);
      // 脚本没变就保留运行状态；改过 client.js（rev 变化）则先卸载旧实例再重新加载
      if (!shouldReloadPlugin(existing, descriptor)) return;
      if (existing) {
        existing.dispose();
        loadedRef.current.delete(descriptor.id);
        pluginSlots.clearPlugin(descriptor.id);
      }
      const styles = new PluginStyles(descriptor.id);
      let timers: PluginTimers | null = null;
      let disposeApply: PluginClientDisposer = () => {};
      try {
        const source = await fetchPluginClientSource(descriptor);
        const bundle = createPluginContext({
          descriptor,
          actions: stableActions,
          getState,
          subscribeState,
        });
        timers = bundle.timers;
        const module = await evaluatePluginClient(source, {
          ctx: bundle.ctx,
          styles,
          host: bundle.host,
          pluginId: descriptor.id,
        });
        disposeApply = await applyPluginClient(module, bundle.ctx);
        loadedRef.current.set(descriptor.id, {
          rev,
          dispose: () => {
            disposeApply();
            timers?.dispose();
            styles.dispose();
          },
        });
      } catch (error) {
        styles.dispose();
        timers?.dispose();
        pluginSlots.clearPlugin(descriptor.id);
        reportPluginLoadError(descriptor.id, error);
      }
    },
    [stableActions, getState, subscribeState],
  );

  const doRefresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      // 安全模式：外壳级槽位可把整个 UI 换掉；保留一条不加载任何界面插件的退路
      const safeUi = (() => {
        try {
          return window.localStorage.getItem("meowcode.safeUiPlugins") === "1";
        } catch {
          return false;
        }
      })();
      if (safeUi) {
        for (const pluginId of [...loadedRef.current.keys()]) disposePlugin(pluginId);
        setPendingConsent([]);
        return;
      }
      const overview = await listPlugins();
      const targets = overview.plugins.filter((item) => item.enabled && item.ui?.client);
      const approvals = await readApprovals();
      const pending: PluginConsentRequest[] = [];

      for (const descriptor of targets) {
        const approved =
          descriptor.source === "builtin" ||
          descriptor.aiAuthored === true ||
          sameApproval(approvals[descriptor.id], descriptor);
        if (!approved && !approvals[descriptor.id]?.declined) {
          pending.push({
            descriptor,
            permissions: descriptor.manifest?.permissions ?? [],
          });
          continue;
        }
        if (approved) await loadDescriptor(descriptor);
        else disposePlugin(descriptor.id);
      }

      const alive = new Set(targets.map((item) => item.id));
      for (const pluginId of [...loadedRef.current.keys()]) {
        if (!alive.has(pluginId)) disposePlugin(pluginId);
      }
      setPendingConsent(pending);
    } catch (error) {
      console.warn("[plugins] ui reload failed:", error);
    } finally {
      setLoading(false);
    }
  }, [disposePlugin, loadDescriptor]);

  /**
   * 串行化：StrictMode 首屏会跑两次 effect，plugins_changed 也可能与首轮重叠；
   * 两轮并发 refresh 都看到「未加载」就会 apply 两次，页面/按钮出现双份。
   */
  const refreshChainRef = useRef<Promise<void>>(Promise.resolve());
  const refresh = useCallback((): Promise<void> => {
    const run = refreshChainRef.current.then(doRefresh);
    refreshChainRef.current = run.catch(() => undefined);
    return run;
  }, [doRefresh]);

  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
    const off = window.meow?.onEvent?.((event) => {
      if (event.type === "plugins_changed") {
        invalidatePluginIconMap();
        void refreshRef.current();
      }
    });
    return () => {
      off?.();
      for (const pluginId of [...loadedRef.current.keys()]) disposePlugin(pluginId);
    };
    // actions/state 由 App 注入，重挂载时重新加载插件 UI
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    stateRef.current = state;
    for (const listener of stateListeners.current) listener();
  }, [
    state.sessionId,
    state.workspace,
    state.theme,
    state.locale,
    state.view,
    state.running,
    state.mode,
  ]);

  const approve = useCallback(
    async (request: PluginConsentRequest) => {
      const version = request.descriptor.manifest?.version ?? request.descriptor.version ?? "0.0.0";
      await writeApproval(request.descriptor.id, {
        version,
        permissions: request.permissions,
        approvedAt: new Date().toISOString(),
      });
      setPendingConsent((current) => current.filter((item) => item.descriptor.id !== request.descriptor.id));
      await loadDescriptor(request.descriptor);
    },
    [loadDescriptor],
  );

  const decline = useCallback(async (request: PluginConsentRequest) => {
    const version = request.descriptor.manifest?.version ?? request.descriptor.version ?? "0.0.0";
    await writeApproval(request.descriptor.id, {
      version,
      permissions: [],
      approvedAt: new Date().toISOString(),
      declined: true,
    });
    setPendingConsent((current) => current.filter((item) => item.descriptor.id !== request.descriptor.id));
  }, []);

  return (
    <PluginRuntimeContext.Provider value={{ pendingConsent, loading, reload: refresh }}>
      {children}
      <PluginConsentDialog requests={pendingConsent} onApprove={approve} onDecline={decline} />
    </PluginRuntimeContext.Provider>
  );
}

export { reportPluginError };
