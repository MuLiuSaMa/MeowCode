import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LuArrowDownToLine,
  LuArrowUpFromLine,
  LuCpu,
  LuDatabase,
  LuEllipsis,
  LuFolder,
  LuFolderOpen,
  LuGauge,
  LuHash,
  LuHourglass,
  LuListChecks,
  LuMessageSquare,
  LuPercent,
  LuSearch,
  LuSquare,
  LuTerminal,
  LuTimer,
  LuUsers,
} from "react-icons/lu";
import type { ProviderSettings, TurnMetrics } from "../../api";
import type { SideTabOpen } from "../../panel/useSideTabs";

/** 工具卡片：点击开页签；hovering 浮出「…」菜单 */
const CARDS: Array<{
  kind: "workspace" | "sidechat" | "terminal" | "review" | "subagents";
  label: string;
  shortcut?: string;
  icon: ReactNode;
}> = [
  { kind: "workspace", label: "文件", shortcut: "Ctrl+P", icon: <LuFolder size={15} /> },
  { kind: "sidechat", label: "侧边聊天", shortcut: "Ctrl+Alt+S", icon: <LuMessageSquare size={15} /> },
  { kind: "terminal", label: "终端", shortcut: "Ctrl+`", icon: <LuTerminal size={15} /> },
  { kind: "review", label: "审阅", icon: <LuListChecks size={15} /> },
  { kind: "subagents", label: "子 Agent", icon: <LuUsers size={15} /> },
];

function Field({ icon, label, value, mono }: { icon: ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="mc-rtp__field">
      <span className="mc-rtp__fieldlabel">
        {icon}
        {label}
      </span>
      <span className={["mc-rtp__fieldvalue", mono ? "mc-mono" : ""].filter(Boolean).join(" ")}>{value}</span>
    </div>
  );
}

function formatTokenValue(value: number | null | undefined): string {
  return typeof value === "number" ? `${value.toLocaleString("zh-CN")} tok` : "—";
}

function formatDuration(value: number | null | undefined): string {
  if (typeof value !== "number") return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

function formatSpeed(value: number | null | undefined): string {
  return typeof value === "number" ? `${value.toFixed(1)} tok/s` : "—";
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number") return "—";
  if (value >= 1) return "100.0%";
  // 非满命中不四舍五入成 100.0%（参考 DSH）
  return `${Math.min(value * 100, 99.9).toFixed(1)}%`;
}

export function HomeTab({
  onOpen,
  onOpenPalette,
  onOpenWorkspace,
  workspace,
  session,
  metrics,
  provider,
  toolCount,
}: {
  onOpen: (request: SideTabOpen) => void;
  /** 文件卡片：打开快开面板（Ctrl+P 同款） */
  onOpenPalette: () => void;
  /** 在资源管理器中打开工作区（文件卡片「…」菜单） */
  onOpenWorkspace: (cwd: string) => void;
  workspace?: string;
  session: { id: string; cwd: string } | null;
  /** 最近一次 AI 回合的响应统计 */
  metrics: TurnMetrics | null;
  provider?: ProviderSettings;
  toolCount: number;
}) {
  /** 「…」菜单展开的卡片 kind */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuFor) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if ((event.target as HTMLElement).closest?.(".mc-rtp__cardmenu")) return;
      setMenuFor(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuFor(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuFor]);

  /** 未命中缓存的输入 = 总输入 - 缓存读取；服务商未报告缓存明细时按全部未缓存显示。 */
  const uncachedInputTokens =
    typeof metrics?.inputTokens === "number"
      ? Math.max(0, metrics.inputTokens - (metrics.cacheReadTokens ?? 0))
      : null;

  return (
    <div className="mc-rtp__home">
      <p className="mc-rtp__section">工具</p>
      <div className="mc-rtp__grid">
        {CARDS.map((card) => (
          <div className="mc-rtp__cardwrap" key={card.kind}>
            <button
              type="button"
              className="mc-rtp__card"
              onClick={() => onOpen({ kind: card.kind })}
            >
              <span className="mc-rtp__cardicon">{card.icon}</span>
              <span className="mc-rtp__cardlabel mc-truncate">{card.label}</span>
              {card.shortcut ? <span className="mc-rtp__cardkbd">{card.shortcut}</span> : null}
            </button>
            {card.kind === "workspace" ? (
              <button
                type="button"
                className="mc-rtp__cardmenu"
                aria-label="文件菜单"
                data-open={menuFor === card.kind}
                onClick={() => setMenuFor(menuFor === card.kind ? null : card.kind)}
              >
                <LuEllipsis size={14} />
              </button>
            ) : null}

            {menuFor === card.kind ? (
              <div className="mc-rtp__cmenu" ref={menuRef} role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="mc-rtp__cmenuitem"
                  onClick={() => {
                    setMenuFor(null);
                    onOpenPalette();
                  }}
                >
                  <LuSearch size={14} />
                  快速打开（Ctrl+P）
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="mc-rtp__cmenuitem"
                  disabled={!workspace}
                  onClick={() => {
                    setMenuFor(null);
                    if (workspace) onOpenWorkspace(workspace);
                  }}
                >
                  <LuFolderOpen size={14} />
                  在文件管理器中打开
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <p className="mc-rtp__section">会话信息</p>
      <div className="mc-rtp__fields">
        <Field icon={<LuFolder size={13} />} label="工作区" value={session?.cwd ?? "—"} mono />
        <Field icon={<LuCpu size={13} />} label="服务商" value={provider?.name ?? "—"} />
        <Field icon={<LuCpu size={13} />} label="模型" value={provider?.model ?? "—"} mono />
        <Field icon={<LuHash size={13} />} label="会话 ID" value={session?.id ?? "—"} mono />
        <Field icon={<LuSquare size={13} />} label="工具调用" value={String(toolCount)} />
        <Field
          icon={<LuArrowDownToLine size={13} />}
          label="未缓存输入"
          value={formatTokenValue(uncachedInputTokens)}
          mono
        />
        <Field
          icon={<LuDatabase size={13} />}
          label="缓存读取"
          value={formatTokenValue(metrics?.cacheReadTokens)}
          mono
        />
        <Field
          icon={<LuDatabase size={13} />}
          label="缓存写入"
          value={formatTokenValue(metrics?.cacheWriteTokens)}
          mono
        />
        <Field
          icon={<LuArrowUpFromLine size={13} />}
          label="输出"
          value={formatTokenValue(metrics?.outputTokens)}
          mono
        />
        <Field
          icon={<LuPercent size={13} />}
          label="缓存命中率（会话）"
          value={formatPercent(metrics?.cacheHitRate)}
          mono
        />
        <Field
          icon={<LuGauge size={13} />}
          label="生成速度"
          value={formatSpeed(metrics?.tokensPerSecond)}
          mono
        />
        <Field
          icon={<LuTimer size={13} />}
          label="响应时间"
          value={formatDuration(metrics?.responseMs)}
          mono
        />
        <Field
          icon={<LuHourglass size={13} />}
          label="首字延迟"
          value={formatDuration(metrics?.firstTokenMs)}
          mono
        />
      </div>
    </div>
  );
}
