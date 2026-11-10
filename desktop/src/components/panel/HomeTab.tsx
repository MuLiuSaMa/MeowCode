import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  LuCpu,
  LuEllipsis,
  LuFile,
  LuFolder,
  LuFolderOpen,
  LuGauge,
  LuHash,
  LuHourglass,
  LuListChecks,
  LuMessageSquare,
  LuSearch,
  LuSquare,
  LuTerminal,
  LuTimer,
  LuUsers,
} from "react-icons/lu";
import { PluginSlot } from "../../plugins/PluginSlot";
import type { ProviderSettings, SpeedSample, TurnMetrics } from "../../api";
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

/** 单次模型调用的生成速度（output token / 秒）。 */
function speedOf(sample: SpeedSample): number {
  return Math.max(0, sample.tokensPerSecond);
}

/** 纵轴上限：取 1 位有效数字向上取整，刻度落在整齐的量级上。 */
function niceSpeedMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / exponent) * exponent;
}

/** 环形命中率：SVG 尺寸固定，外层卡片负责随面板宽度换行。 */
function HitRing({ value }: { value: number | null }) {
  const size = 62;
  const stroke = 5.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = value == null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--surface)"
        strokeWidth={stroke}
      />
      {ratio > 0 ? (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--mc-stat-read)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${ratio * circumference} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dasharray var(--dur) var(--ease)" }}
        />
      ) : null}
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={12.5}
        fontWeight={600}
        fill="var(--fg)"
      >
        {formatPercent(value)}
      </text>
    </svg>
  );
}

const CURVE_HEIGHT = 96;
const CURVE_PAD = { top: 10, right: 8, bottom: 12, left: 30 };

/** 水平切线的三次贝塞尔：点少时也不会出现尖角，视觉上更像「曲线」。 */
function curvePath(points: Array<{ x: number; y: number }>): string {
  if (!points.length) return "";
  const [first, ...rest] = points;
  let path = `M${first.x.toFixed(1)} ${first.y.toFixed(1)}`;
  let previous = first;
  for (const point of rest) {
    const midX = ((previous.x + point.x) / 2).toFixed(1);
    path += ` C${midX} ${previous.y.toFixed(1)} ${midX} ${point.y.toFixed(1)} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    previous = point;
  }
  return path;
}

/**
 * 实时生成速度曲线：每次模型调用一个点，流中按 roundId 原地替换。
 *
 * 宽度用 ResizeObserver 实测后按像素出图：面板宽度可拖拽（最小 240px），
 * 固定 viewBox 拉伸会把圆点与描边一起拉扁。纵轴按本次窗口的最大速度自适应。
 */
function SpeedCurve({ samples, label }: { samples: SpeedSample[]; label: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const gradientId = `mc-hit-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const values = samples.map(speedOf);
  const scaleMax = niceSpeedMax(Math.max(...values, 1));
  const innerWidth = Math.max(0, width - CURVE_PAD.left - CURVE_PAD.right);
  const innerHeight = CURVE_HEIGHT - CURVE_PAD.top - CURVE_PAD.bottom;
  const points = values.map((value, index) => ({
    x:
      CURVE_PAD.left +
      (values.length > 1 ? (innerWidth * index) / (values.length - 1) : innerWidth / 2),
    y: CURVE_PAD.top + (1 - value / scaleMax) * innerHeight,
    value,
  }));
  const line = curvePath(points);
  const baseline = CURVE_HEIGHT - CURVE_PAD.bottom;
  const first = points[0];
  const last = points.at(-1);
  const area =
    points.length > 1 && first && last
      ? `${line} L${last.x.toFixed(1)} ${baseline} L${first.x.toFixed(1)} ${baseline} Z`
      : "";

  return (
    <div className="mc-curve" ref={wrapRef}>
      {width > 0 ? (
        <svg width={width} height={CURVE_HEIGHT} role="img" aria-label={label}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--mc-stat-read)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--mc-stat-read)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[1, 0.5, 0].map((ratio) => {
            const y = CURVE_PAD.top + (1 - ratio) * innerHeight;
            return (
              <g key={ratio}>
                <line
                  x1={CURVE_PAD.left}
                  x2={width - CURVE_PAD.right}
                  y1={y}
                  y2={y}
                  stroke="var(--border)"
                  strokeDasharray={ratio === 0 ? undefined : "2 4"}
                />
                <text x={0} y={y + 3} fontSize={9} fill="var(--fg-subtlest)">
                  {Math.round(scaleMax * ratio)}
                </text>
              </g>
            );
          })}
          {area ? <path d={area} fill={`url(#${gradientId})`} /> : null}
          {points.length > 1 ? (
            <path
              d={line}
              fill="none"
              stroke="var(--mc-stat-read)"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
          {points.map((point, index) => (
            <circle
              key={index}
              cx={point.x}
              cy={point.y}
              r={index === points.length - 1 ? 2.8 : 1.8}
              fill="var(--mc-stat-read)"
            >
              <title>{formatSpeed(point.value)}</title>
            </circle>
          ))}
        </svg>
      ) : null}
    </div>
  );
}

function DetailRow({
  icon,
  label,
  value,
  mono,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="mc-detailrow">
      <span className="mc-detailrow__label">
        {icon}
        {label}
      </span>
      <span
        className={`mc-detailrow__value mc-truncate${mono ? " mc-detailrow__value--mono" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function MiniStat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="mc-mini">
      <span className="mc-mini__label">
        {icon}
        {label}
      </span>
      <span className="mc-mini__value">{value}</span>
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
  speedSamples,
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
  /** 会话累计用量与最近一次 AI 回合的响应统计 */
  metrics: TurnMetrics | null;
  /** 实时生成速度曲线：最近若干次模型调用（时间正序），流中原地更新 */
  speedSamples: SpeedSample[];
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

  /** 服务商未报告缓存明细时显示「未报告」，不把未知伪装成 0。 */
  const cacheReported = metrics?.cacheReadTokens != null;
  const inputTotal = typeof metrics?.inputTokens === "number" ? metrics.inputTokens : null;
  const cacheRead = cacheReported ? (metrics?.cacheReadTokens ?? 0) : null;
  const cacheWrite = typeof metrics?.cacheWriteTokens === "number" ? metrics.cacheWriteTokens : null;
  const outputTotal = typeof metrics?.outputTokens === "number" ? metrics.outputTokens : null;
  // 未命中输入 = 总输入 - 缓存读 - 缓存写：写入的部分已计入缓存，不再算「未缓存」
  const uncachedInput =
    inputTotal != null && cacheRead != null
      ? Math.max(0, inputTotal - cacheRead - (cacheWrite ?? 0))
      : null;

  const legend = [
    { key: "read", label: t("home.field.cacheRead"), value: cacheRead },
    { key: "uncached", label: t("home.field.uncachedInput"), value: uncachedInput },
    { key: "write", label: t("home.field.cacheWrite"), value: cacheWrite },
    { key: "output", label: t("home.field.output"), value: outputTotal },
  ];
  const tokenTotal = legend.reduce((sum, item) => sum + (item.value ?? 0), 0);
  const legendValue = (value: number | null) =>
    metrics == null ? "—" : value == null ? t("home.notReported") : tokenValue(value);

  const showCurve = speedSamples.length > 0;
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
      <div className="mc-rtp__session">
        <div className="mc-rtp__stats">
          <div className="mc-stat mc-stat--hero">
            <span className="mc-stat__label">{t("home.field.cacheHitRate")}</span>
            <div className="mc-stat__ring">
              <HitRing value={metrics?.cacheHitRate ?? null} />
            </div>
            <span className="mc-stat__hint">{t("home.sessionTotal")}</span>
          </div>

          <div className="mc-stat mc-stat--tokens">
            <span className="mc-stat__label">{t("home.tokensTitle")}</span>
            <div className="mc-tokenbar" aria-hidden={tokenTotal === 0}>
              {legend.map((item) =>
                item.value && item.value > 0 ? (
                  <span
                    key={item.key}
                    className={`mc-tokenbar__seg mc-tokenbar__seg--${item.key}`}
                    style={{ flexGrow: item.value }}
                  />
                ) : null,
              )}
            </div>
            <ul className="mc-tokenlegend">
              {legend.map((item) => (
                <li className="mc-tokenlegend__row" key={item.key}>
                  <span className={`mc-tokenlegend__dot mc-tokenlegend__dot--${item.key}`} />
                  <span className="mc-tokenlegend__label">{item.label}</span>
                  <span className="mc-tokenlegend__value">{legendValue(item.value)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mc-chartcard">
          <div className="mc-chartcard__head">
            <span className="mc-chartcard__title">{t("home.field.speed")} · tok/s</span>
            {showCurve ? (
              <span className="mc-chartcard__meta">
                <span className="mc-chartcard__live" aria-hidden="true" />
                {t("home.liveCalls", { count: speedSamples.length })}
              </span>
            ) : null}
          </div>
          {showCurve ? (
            <SpeedCurve samples={speedSamples} label={t("home.field.speed")} />
          ) : (
            <p className="mc-chartcard__empty">—</p>
          )}
        </div>

        <div className="mc-stat mc-stat--details">
          <div className="mc-detailrows">
            <DetailRow
              icon={<LuFolder size={13} />}
              label={t("home.field.workspace")}
              value={session?.cwd ?? "—"}
            />
            <DetailRow
              icon={<LuCpu size={13} />}
              label={t("home.field.provider")}
              value={provider?.name ?? "—"}
            />
            <DetailRow
              icon={<LuCpu size={13} />}
              label={t("home.field.model")}
              value={provider?.model ?? "—"}
            />
            <DetailRow
              icon={<LuHash size={13} />}
              label={t("home.field.sessionId")}
              value={session?.id ?? "—"}
              mono
            />
          </div>
          <div className="mc-detailstats">
            <MiniStat
              icon={<LuSquare size={13} />}
              label={t("home.field.toolCalls")}
              value={String(toolCount)}
            />
            <MiniStat
              icon={<LuGauge size={13} />}
              label={t("home.field.speed")}
              value={formatSpeed(metrics?.tokensPerSecond)}
            />
            <MiniStat
              icon={<LuTimer size={13} />}
              label={t("home.field.response")}
              value={formatDuration(metrics?.responseMs)}
            />
            <MiniStat
              icon={<LuHourglass size={13} />}
              label={t("home.field.firstToken")}
              value={formatDuration(metrics?.firstTokenMs)}
            />
          </div>
        </div>
      </div>

      <PluginSlot name="home.widgets" props={{}} />
    </div>
  );
}
