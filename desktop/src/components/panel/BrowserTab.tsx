import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowLeft, LuArrowRight, LuRotateCw } from "react-icons/lu";
import { normalizeAddress } from "../../panel/address";
import "./BrowserTab.css";

/** lib.dom 的 HTMLWebViewElement 只有 HTMLElement 成员，这里补上要调用的方法 */
type WebviewElement = HTMLWebViewElement & {
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  loadURL: (url: string) => Promise<void> | void;
  getWebContentsId?: () => number;
};

type WebviewNavEvent = Event & { url?: string };
type WebviewTitleEvent = Event & { title?: string };

/**
 * 浏览器页签：自带地址栏（其余页签没有顶部搜索栏），一个页签一个 <webview>。
 * src 只在挂载时作为初始地址；后续导航一律走 loadURL，
 * 避免把 tab.url 绑回 src 导致每次导航二次加载。
 * 新窗口 / 非 http(s) 导航由主进程的 web-contents-created 守卫处理。
 */
export function BrowserTab({
  tabId,
  url,
  agent,
  onMeta,
}: {
  tabId: string;
  /** 初始地址 */
  url: string;
  /** agent 专属页签：webview 就绪后把 webContentsId 绑给主进程 browser host */
  agent?: boolean;
  onMeta: (id: string, meta: { title?: string; url?: string }) => void;
}) {
  const { t } = useTranslation("panel");
  const ref = useRef<WebviewElement | null>(null);
  const initialUrl = useRef(url).current;
  const [address, setAddress] = useState(url);

  const setRef = useCallback((element: HTMLWebViewElement | null) => {
    ref.current = element as WebviewElement | null;
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const onNavigate = (event: Event) => {
      const target = (event as WebviewNavEvent).url;
      if (!target) return;
      setAddress(target);
      onMeta(tabId, { url: target });
    };
    const onTitle = (event: Event) => {
      const title = (event as WebviewTitleEvent).title;
      if (title) onMeta(tabId, { title });
    };

    element.addEventListener("did-navigate", onNavigate);
    element.addEventListener("did-navigate-in-page", onNavigate);
    element.addEventListener("page-title-updated", onTitle);
    return () => {
      element.removeEventListener("did-navigate", onNavigate);
      element.removeEventListener("did-navigate-in-page", onNavigate);
      element.removeEventListener("page-title-updated", onTitle);
    };
  }, [tabId, onMeta]);

  const withElement = (action: (element: WebviewElement) => void) => {
    const element = ref.current;
    if (!element) return;
    try {
      action(element);
    } catch {
      // 未就绪 / 无历史
    }
  };

  /**
   * agent 页签绑定：主进程的 browser host 靠 webContentsId 直接驱动这个 guest。
   * 页面刷新/进程重建后 dom-ready 会再次触发 → 自动重绑；纯浏览器预览里
   * getWebContentsId 不存在，静默跳过（只是无法被 agent 控制）。
   */
  useEffect(() => {
    const element = ref.current;
    if (!element || !agent) return;
    const bind = () => {
      try {
        const webContentsId = element.getWebContentsId?.();
        if (typeof webContentsId === "number") {
          void window.meow.bindBrowserTab({ tabId, webContentsId });
        }
      } catch {
        // webview 未就绪：等 dom-ready 再试
      }
    };
    element.addEventListener("dom-ready", bind);
    bind();
    return () => element.removeEventListener("dom-ready", bind);
  }, [agent, tabId]);

  const submit = () => {
    const value = address.trim();
    if (!value) return;
    withElement((element) => void element.loadURL(normalizeAddress(value)));
  };

  return (
    <div className="mc-browser">
      <div className="mc-browser__bar">
        <button type="button" className="mc-rtp__navbtn" aria-label={t("browser.back")} onClick={() => withElement((el) => el.goBack())}>
          <LuArrowLeft size={14} />
        </button>
        <button type="button" className="mc-rtp__navbtn" aria-label={t("browser.forward")} onClick={() => withElement((el) => el.goForward())}>
          <LuArrowRight size={14} />
        </button>
        <button type="button" className="mc-rtp__navbtn" aria-label={t("browser.reload")} onClick={() => withElement((el) => el.reload())}>
          <LuRotateCw size={13} />
        </button>
        <input
          className="mc-rtp__address"
          value={address}
          placeholder={t("browser.addressPlaceholder")}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
      </div>
      <webview
        ref={setRef}
        className="mc-rtp__webview"
        src={initialUrl}
        partition={agent ? "persist:meow-browser-agent" : "persist:meow-browser"}
        allowpopups
      />
    </div>
  );
}
