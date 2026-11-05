import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "./TerminalTab.css";

/**
 * 终端页签：xterm + FitAddon；PTY 在 Electron main（desktop/terminals.cjs）。
 * 常挂载保活（非激活 display:none）；用户终端卸载即 kill，agent 任务终端只断开不 kill。
 */
export function TerminalTab({
  active,
  cwd,
  termId,
}: {
  active: boolean;
  cwd?: string;
  /** agent 后台任务：attach 到已有 PTY，不新建也不在卸载时销毁 */
  termId?: string;
}) {
  const { t } = useTranslation("panel");
  /** 译文只用于退出提示：用 ref 取值，切语言时不重建终端（会杀 PTY） */
  const tRef = useRef(t);
  tRef.current = t;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termIdRef = useRef<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const rootStyle = getComputedStyle(document.documentElement);
    const panelBg = rootStyle.getPropertyValue("--bg-panel").trim() || "#131313";
    const fg = rootStyle.getPropertyValue("--fg").trim() || "#f5f5f5";

    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, Consolas, 'Cascadia Mono', 'Courier New', monospace",
      cursorBlink: true,
      scrollback: 5_000,
      theme: { background: panelBg, foreground: fg, cursor: fg },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    let createdId: string | null = null;
    const ownsSession = !termId;

    const syncSize = () => {
      if (container.clientWidth < 40 || container.clientHeight < 40) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (createdId) void window.meow.termResize(createdId, term.cols, term.rows);
    };

    // 先按容器尺寸初始化 cols/rows，再建 PTY
    try {
      fit.fit();
    } catch {
      // 容器尚未布局，使用默认尺寸
    }
    void (async () => {
      if (termId) {
        const attached = await window.meow.termAttach(termId).catch(() => null);
        if (disposed) return;
        if (!attached) {
          term.writeln(`\x1b[90m${tRef.current("terminal.ended")}\x1b[0m`);
          return;
        }
        createdId = termId;
        termIdRef.current = termId;
        if (attached.data) term.write(attached.data);
        if (attached.exited) {
          term.writeln(`\r\n\x1b[90m${tRef.current("terminal.exited")}\x1b[0m`);
        }
        syncSize();
        return;
      }
      try {
        const { id } = await window.meow.termCreate({ cwd, cols: term.cols, rows: term.rows });
        if (disposed) {
          void window.meow.termKill(id);
          return;
        }
        createdId = id;
        termIdRef.current = id;
        syncSize();
      } catch (error) {
        term.writeln(
          `\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`,
        );
      }
    })();

    const offData = window.meow.onTermData((payload) => {
      if (payload.id === createdId) term.write(payload.data);
    });
    const offExit = window.meow.onTermExit((payload) => {
      if (payload.id === createdId) {
        term.writeln(`\r\n\x1b[90m${tRef.current("terminal.exited")}\x1b[0m`);
      }
    });
    const dataSub = term.onData((data) => {
      if (createdId) void window.meow.termWrite(createdId, data);
    });

    let resizeTimer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        syncSize();
      }, 120);
    });
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      if (resizeTimer) window.clearTimeout(resizeTimer);
      offData();
      offExit();
      dataSub.dispose();
      if (createdId && ownsSession) void window.meow.termKill(createdId);
      termIdRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [cwd, termId]);

  // 页签激活时（含从隐藏恢复）补一次 fit 并聚焦
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      const fit = fitRef.current;
      const term = termRef.current;
      const container = containerRef.current;
      if (!fit || !term || !container || container.clientWidth < 40) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const termId = termIdRef.current;
      if (termId) void window.meow.termResize(termId, term.cols, term.rows);
      term.focus();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [active]);

  return <div className="mc-rtp__term" ref={containerRef} />;
}
