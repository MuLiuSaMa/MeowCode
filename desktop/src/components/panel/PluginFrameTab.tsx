import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./PluginFrameTab.css";

/**
 * 插件自带面板：用 iframe 加载插件目录里的 `ui/index.html`。
 *
 * 为什么是 iframe 而不是动态 import：渲染层是预构建产物，无法 import 运行时下载的
 * JSX/TS；把任意第三方代码放进渲染进程和当前 devTools:false 的安全姿态冲突。
 *
 * 沙箱策略：`allow-scripts allow-same-origin allow-forms`
 *  - 不给 allow-top-navigation / allow-popups，插件顶不出去；
 *  - 保留 same-origin 是为了让 iframe 内的 fetch 能直接打本机 server（否则 opaque origin 会撞 CORS）；
 *  - iframe 与宿主窗口本身不同源，拿不到宿主的 localStorage / DOM。
 *
 * 懒加载：右侧面板所有页签常挂载，首次激活才设 src，避免 N 个插件常驻文档。
 */
export function PluginFrameTab({
  pluginId,
  active,
  sessionId,
}: {
  pluginId: string;
  active: boolean;
  sessionId?: string;
}) {
  const { i18n } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [started, setStarted] = useState(false);
  const [src, setSrc] = useState<string | null>(null);

  /** 解析面板 URL：server 未就绪时拿到 null（可点「重试」再取，不能把 null 固化） */
  const resolve = useCallback(() => {
    setSrc(null);
    void window.meow
      ?.pluginUiUrl?.(pluginId)
      ?.then((url) => setSrc(url ?? null))
      .catch(() => setSrc(null));
  }, [pluginId]);

  useEffect(() => {
    if (active) setStarted(true);
  }, [active]);

  // 激活后解析一次；用户点「重试」走同一个 resolve
  useEffect(() => {
    if (started) resolve();
  }, [resolve, started]);

  /** 把主题变量与运行上下文推给 iframe（iframe 是独立 document，拿不到宿主的 CSS 变量） */
  const pushContext = useCallback(() => {
    const frame = frameRef.current?.contentWindow;
    if (!frame) return;
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string) => styles.getPropertyValue(name).trim();
    frame.postMessage(
      {
        ns: "meow-plugin",
        v: 1,
        type: "init",
        pluginId,
        theme: {
          dark: document.documentElement.dataset.theme === "dark",
          bg: read("--bg"),
          fg: read("--fg"),
          surface: read("--surface"),
          border: read("--border"),
          accent: read("--brand"),
        },
        locale: i18n.language,
        ...(sessionId ? { sessionId } : {}),
      },
      "*",
    );
  }, [i18n.language, pluginId, sessionId]);

  useEffect(() => {
    if (!started) return;
    const onMessage = (event: MessageEvent) => {
      // 只认当前 iframe 发来的消息
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { ns?: string; type?: string; url?: string } | null;
      if (!data || data.ns !== "meow-plugin") return;
      if (data.type === "openLink" && typeof data.url === "string" && /^https?:\/\//i.test(data.url)) {
        void window.meow?.openExternal?.(data.url);
      }
      // 尺寸由 iframe 自己撑开（宿主用固定高度 + 内部滚动），这里只保留协议位
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [started]);

  useEffect(() => {
    if (!started) return;
    pushContext();
  }, [pushContext, started]);

  if (!src) {
    return (
      <div className="mc-pluginui mc-pluginui--empty">
        <span>插件面板不可用（server 未就绪）</span>
        <button type="button" className="mc-pluginui__retry" onClick={resolve}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="mc-pluginui" data-hidden={!active}>
      <iframe
        ref={frameRef}
        className="mc-pluginui__frame"
        src={src}
        title={pluginId}
        sandbox="allow-scripts allow-same-origin allow-forms"
        onLoad={pushContext}
      />
    </div>
  );
}
