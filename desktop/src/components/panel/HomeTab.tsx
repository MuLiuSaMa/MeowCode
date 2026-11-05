import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  LuArrowDownToLine,
  LuArrowUpFromLine,
  LuCpu,
  LuDatabase,
  LuEllipsis,
  LuFile,
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
import { formatNumber } from "../../i18n/format";

/** 工具卡片：点击开页签（search 例外，开检索弹窗）；hovering 浮出「…」菜单。表里只存 key，标题在组件里查表。 */
const CARDS: Array<{
  kind: "workspace" | "search" | "sidechat" | "terminal" | "review" | "subagents";
  labelKey: string;
  shortcut?: string;
  icon: ReactNode;
}> = [
  { kind: "workspace", labelKey: "home.card.workspace", shortcut: "Ctrl+P", icon: <LuFile size={15} /> },
  { kind: "search", labelKey: "home.card.search", shortcut: "Ctrl+K", icon: <LuSearch size={15} /> },
  { kind: "sidechat", labelKey: "home.card.sidechat", shortcut: "Ctrl+Alt+S", icon: <LuMessageSquare size={15} /> },
  { kind: "terminal", labelKey: "home.card.terminal", shortcut: "Ctrl+`", icon: <LuTerminal size={15} /> },
  { kind: "review", labelKey: "home.card.review", icon: <LuListChecks size={15} /> },
  { kind: "subagents", labelKey: "home.card.subagents", icon: <LuUsers size={15} /> },
];

function Field({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="mc-rtp__field">
      <span className="mc-rtp__fieldlabel">
        {icon}
        {label}
      </span>
      <span className="mc-rtp__fieldvalue">{value}</span>
    </div>
  );
}

function formatTokenValue(
  value: number | null | undefined,
  format: (tokens: string) => string,
): string {
  return typeof value === "number" ? format(formatNumber(value)) : "—";
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
  onOpenSearch,
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
  /** 搜索卡片：打开会话全文检索弹窗（Ctrl+K 同款） */
  onOpenSearch: () => void;
  workspace?: string;
  session: { id: string; cwd: string } | null;
  /** 最近一次 AI 回合的响应统计 */
  metrics: TurnMetrics | null;
  provider?: ProviderSettings;
  toolCount: number;
}) {
  const { t } = useTranslation("panel");
  /** 「…」菜单展开的卡片 kind */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tokenValue = (value: number | null | undefined) =>
    formatTokenValue(value, (tokens) => t("home.tokenValue", { value: tokens }));

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

  /** 未命中缓存的输入 = 总输入 - 缓存读取；服务商未报告缓存明细时显示「未报告」，不伪装成 0。 */
  const uncachedInputTokens =
    typeof metrics?.inputTokens === "number"
      ? Math.max(0, metrics.inputTokens - (metrics.cacheReadTokens ?? 0))
      : null;
  return (
    <div className="mc-rtp__home">
      <p className="mc-rtp__section">{t("home.toolsSection")}</p>
      <div className="mc-rtp__grid">
        {CARDS.map((card) => (
          <div className="mc-rtp__cardwrap" key={card.kind}>
            <button
              type="button"
              className="mc-rtp__card"
              onClick={() =>
                card.kind === "search" ? onOpenSearch() : onOpen({ kind: card.kind })
              }
            >
              <span className="mc-rtp__cardicon">{card.icon}</span>
              <span className="mc-rtp__cardlabel mc-truncate">{t(card.labelKey)}</span>
              {card.shortcut ? <span className="mc-rtp__cardkbd">{card.shortcut}</span> : null}
            </button>
            {card.kind === "workspace" ? (
              <button
                type="button"
                className="mc-rtp__cardmenu"
                aria-label={t("home.fileMenu")}
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
                  {t("home.quickOpen")}
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
                  {t("home.revealInExplorer")}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <p className="mc-rtp__section">{t("home.sessionSection")}</p>
      <div className="mc-rtp__fields">
        <Field icon={<LuFolder size={13} />} label={t("home.field.workspace")} value={session?.cwd ?? "—"} />
        <Field icon={<LuCpu size={13} />} label={t("home.field.provider")} value={provider?.name ?? "—"} />
        <Field icon={<LuCpu size={13} />} label={t("home.field.model")} value={provider?.model ?? "—"} />
        <Field icon={<LuHash size={13} />} label={t("home.field.sessionId")} value={session?.id ?? "—"} />
        <Field icon={<LuSquare size={13} />} label={t("home.field.toolCalls")} value={String(toolCount)} />
        <Field
          icon={<LuArrowDownToLine size={13} />}
          label={t("home.field.uncachedInput")}
          value={
            metrics?.inputTokens != null && metrics.cacheReadTokens == null
              ? t("home.notReported")
              : tokenValue(uncachedInputTokens)
          }
        />
        <Field
          icon={<LuDatabase size={13} />}
          label={t("home.field.cacheRead")}
          value={
            metrics?.inputTokens != null && metrics.cacheReadTokens == null
              ? t("home.notReported")
              : tokenValue(metrics?.cacheReadTokens)
          }
        />
        <Field
          icon={<LuDatabase size={13} />}
          label={t("home.field.cacheWrite")}
          value={tokenValue(metrics?.cacheWriteTokens)}
        />
        <Field
          icon={<LuArrowUpFromLine size={13} />}
          label={t("home.field.output")}
          value={tokenValue(metrics?.outputTokens)}
        />
        <Field
          icon={<LuPercent size={13} />}
          label={t("home.field.cacheHitRate")}
          value={formatPercent(metrics?.cacheHitRate)}
        />
        <Field
          icon={<LuGauge size={13} />}
          label={t("home.field.speed")}
          value={formatSpeed(metrics?.tokensPerSecond)}
        />
        <Field
          icon={<LuTimer size={13} />}
          label={t("home.field.response")}
          value={formatDuration(metrics?.responseMs)}
        />
        <Field
          icon={<LuHourglass size={13} />}
          label={t("home.field.firstToken")}
          value={formatDuration(metrics?.firstTokenMs)}
        />
      </div>
    </div>
  );
}
