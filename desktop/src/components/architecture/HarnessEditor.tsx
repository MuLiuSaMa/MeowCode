import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  LuBot,
  LuCheck,
  LuChevronDown,
  LuCpu,
  LuLayers,
  LuLink2,
  LuMaximize,
  LuPlus,
  LuRotateCcw,
  LuSave,
  LuShieldCheck,
  LuTrash2,
  LuUnlink,
  LuX,
} from "react-icons/lu";
import {
  fetchAgentDefinitions,
  fetchHarnessDetail,
  saveHarness,
  type AgentProfileId,
  type AgentDefinitionInfo,
  type HarnessDocument,
  type HarnessEdge,
  type HarnessNode,
  type HarnessNodeType,
} from "../../api";
import "./HarnessEditor.css";

/**
 * 可编辑架构图（harness 文档）：
 * 节点三类（tier 门禁层级 / gate 门禁 / role 角色），边两类（tier-gate 带序 =
 * 门禁序列、gate-role = 角色绑定），gate 节点上的 onFail=block|loop-to:<gate>
 * 定义失败回跳。
 * 画布 = 世界坐标 + viewport：节点拖动、空白处平移、滚轮缩放、适应画布。
 */

const NODE_W = 288;
const NODE_H = 80;
const WORLD_W = 3200;
const WORLD_H = 2400;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;

const ROLE_OPTIONS = [
  "general",
  "explore",
  "planner",
  "scoper",
  "depth-prober",
  "implementer",
  "reviewer",
  "verifier",
  "fresh-verifier",
  "juror",
  "sweeper",
  "goal-checker",
  "custom",
];

const ROLE_LABELS: Record<string, string> = {
  general: "通用",
  explore: "探索",
  planner: "规划",
  scoper: "范围界定",
  "depth-prober": "深挖",
  implementer: "实现",
  reviewer: "评审",
  verifier: "验证",
  "fresh-verifier": "独立复验",
  juror: "终审",
  sweeper: "收敛清扫",
  "goal-checker": "目标核对",
  custom: "自定义",
};

const TYPE_LABELS: Record<HarnessNodeType, string> = {
  agent: "Agent",
  tier: "层级",
  gate: "门禁",
  role: "子 Agent",
};

const TYPE_ICONS: Record<HarnessNodeType, typeof LuLayers> = {
  agent: LuCpu,
  tier: LuLayers,
  gate: LuShieldCheck,
  role: LuBot,
};

type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;

type Viewport = { x: number; y: number; zoom: number };

type PointerInteraction =
  | {
      kind: "node";
      pointerId: number;
      nodeId: string;
      startClientX: number;
      startClientY: number;
      originX: number;
      originY: number;
      zoom: number;
      moved: boolean;
      /** 拖拽期间直接改这两个 DOM，绕开 React 渲染 */
      nodeEl: HTMLElement | null;
      edgeEls: Array<{ edge: HarnessEdge; el: SVGGElement | null }>;
      /** 预览层里的对应 path（真实边已临时隐藏） */
      ghostPaths: SVGPathElement[];
      /** 最后一次落地的坐标，松手时提交 */
      lastX: number;
      lastY: number;
    }
  | {
      kind: "pan";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      originX: number;
      originY: number;
      moved: boolean;
    };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function edgeKindOf(
  nodes: HarnessNode[],
  source: string,
  target: string,
): string {
  const from = nodes.find((node) => node.id === source)?.type;
  const to = nodes.find((node) => node.id === target)?.type;
  if (from === "agent" && to === "tier") return "agent-tier";
  if (from === "agent" && to === "role") return "agent-role";
  if (from === "tier" && to === "gate") return "tier-gate";
  if (from === "gate" && to === "role") return "gate-role";
  if (from === "role" && to === "role") return "role-delegation";
  return "flow";
}

function uniqueId(base: string, existing: string[]): string {
  let next = base;
  let seq = 2;
  while (existing.includes(next)) {
    next = `${base}-${seq}`;
    seq += 1;
  }
  return next;
}

function nodeSummary(node: HarnessNode): string {
  const data = node.data as { description?: string; invariant?: string };
  return data.description ?? data.invariant ?? "";
}

/** 读元素当前的 translate 值（节点用 transform 定位） */
function readTranslate(el: HTMLElement | null): { x: number; y: number } | null {
  if (!el) return null;
  const transform = getComputedStyle(el).transform;
  if (!transform || transform === "none") return null;
  const matrix = new DOMMatrixReadOnly(transform);
  return { x: matrix.e, y: matrix.f };
}

/** 连线 path：from/to 是两端节点的左上角坐标 */
function edgePath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const mid = (x1 + x2) / 2;
  return {
    d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - 4} ${y2}`,
    labelX: mid,
    labelY: (y1 + y2) / 2 - 6,
  };
}

/** 角色节点的内置角色类型；旧文档没有 data.role 时用节点 id。 */
function roleTypeOf(node: HarnessNode): string {
  const data = node.data as { role?: string };
  return data.role ?? node.id;
}

/**
 * 画布上的一个节点卡片。
 * memo 化：拖拽时只有被拖的那个节点会重渲染，其余节点的 vDOM 直接跳过
 * （比较函数忽略 onPointerDown —— 父层每次渲染都会新建函数，但语义等价）。
 */
const NodeCard = memo(
  function NodeCard({
    node,
    selected,
    connecting,
    roleOrdinalNum,
    roleCount,
    terminalTier,
    displayName,
  }: {
    node: HarnessNode;
    selected: boolean;
    connecting: boolean;
    /** 同类型子 Agent 的第几个（原始值，便于 memo 比较） */
    roleOrdinalNum?: number;
    roleCount?: number;
    terminalTier: boolean;
    displayName: string;
  }) {
    const Icon = TYPE_ICONS[node.type];
    const summary = nodeSummary(node);
    const onFail = node.type === "gate" ? (node.data as { onFail?: string }).onFail : undefined;
    const numberedName =
      node.type === "role" && roleCount && roleCount > 1 && roleOrdinalNum
        ? `${displayName} ${roleOrdinalNum}`
        : displayName;
    return (
      <div
        className="mc-harness__node"
        data-node-id={node.id}
        data-type={node.type}
        data-selected={selected}
        data-connecting={connecting}
        style={{
          // 用 transform 定位：移动时只走合成，不触发 layout/重排
          transform: `translate(${node.position?.x ?? 0}px, ${node.position?.y ?? 0}px)`,
          width: NODE_W,
          height: NODE_H,
        }}
      >
        <span className="mc-harness__nodeicon">
          <Icon size={15} />
        </span>
        <span className="mc-harness__nodebody">
          <span className="mc-harness__nodeline">
            <span className="mc-harness__nodename">{numberedName}</span>
            <span className="mc-harness__nodeid">
              {node.type === "role"
                ? `${roleTypeOf(node)}${
                    roleCount && roleCount > 1 && roleOrdinalNum ? ` · ${roleOrdinalNum}` : ""
                  }`
                : node.id}
            </span>
            <span
              className="mc-harness__nodechip"
              data-kind={node.type}
              title={
                terminalTier
                  ? "该层级没有门禁：admit 后直接完成"
                  : node.type === "agent"
                    ? "主 Agent 是根 runtime，通过 task 派发子 Agent"
                    : node.type === "gate"
                      ? "门禁是一个检查点，由 gate→role 边指定关账子 Agent"
                      : node.type === "role"
                        ? "子 Agent 会在 task 派发时实例化"
                        : "任务层级，决定 admit 后走哪串门禁"
              }
            >
              {node.type === "agent"
                ? "主 Agent"
                : node.type === "role"
                  ? "子 Agent"
                  : node.type === "gate"
                    ? "门禁"
                    : terminalTier
                      ? "层级 · 直通"
                      : "层级"}
            </span>
          </span>
          <span className="mc-harness__nodedesc">{summary || TYPE_LABELS[node.type]}</span>
          {onFail ? <span className="mc-harness__nodeonfail">{onFail}</span> : null}
        </span>
      </div>
    );
  },
  (prev, next) =>
    prev.node === next.node &&
    prev.selected === next.selected &&
    prev.connecting === next.connecting &&
    prev.roleOrdinalNum === next.roleOrdinalNum &&
    prev.roleCount === next.roleCount &&
    prev.terminalTier === next.terminalTier &&
    prev.displayName === next.displayName,
);

/**
 * 画布上的一条连线。坐标以原始值传入 + memo：拖动某个节点时，
 * 只有连到它的那几条边会重算 path，其余边直接跳过。
 */
const EdgeLine = memo(
  function EdgeLine({
    edge,
    x1,
    y1,
    x2,
    y2,
    selected,
    onSelect,
  }: {
    edge: HarnessEdge;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    selected: boolean;
    onSelect: (id: string) => void;
  }) {
    const mid = (x1 + x2) / 2;
    const d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - 4} ${y2}`;
    return (
      <g
        className="mc-harness__edge"
        data-edge-id={edge.id}
        data-kind={edge.type}
        data-selected={selected}
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect(edge.id);
        }}
      >
        <path d={d} fill="none" className="mc-harness__edgehit" />
        <path d={d} fill="none" markerEnd="url(#mc-harness-arrow)" />
        {edge.type === "tier-gate" && edge.order !== undefined ? (
          <text x={mid} y={(y1 + y2) / 2 - 6} className="mc-harness__edgeorder">
            {edge.order}
          </text>
        ) : edge.type === "agent-tier" ||
          edge.type === "agent-role" ||
          edge.type === "gate-role" ? (
          <text x={mid} y={(y1 + y2) / 2 - 6} className="mc-harness__edgelabel">
            {edge.type === "agent-tier" ? "admit" : edge.type === "agent-role" ? "task" : "关账"}
          </text>
        ) : null}
      </g>
    );
  },
  (prev, next) =>
    prev.edge === next.edge &&
    prev.x1 === next.x1 &&
    prev.y1 === next.y1 &&
    prev.x2 === next.x2 &&
    prev.y2 === next.y2 &&
    prev.selected === next.selected,
);

export type HarnessAgentEntry = {
  id: string;
  kind: "agent" | "role";
  roleType: string;
  label: string;
  ordinal: number;
  count: number;
};

/** 左栏 Agent 列表的数据源：主 Agent + 所有角色实例（同类型按出现顺序编号）。 */
function summarizeAgents(doc: HarnessDocument): HarnessAgentEntry[] {
  const roleCounts = new Map<string, number>();
  for (const node of doc.nodes) {
    if (node.type !== "role") continue;
    const type = roleTypeOf(node);
    roleCounts.set(type, (roleCounts.get(type) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const entries: HarnessAgentEntry[] = [];
  for (const node of doc.nodes) {
    if (node.type === "agent") {
      entries.push({
        id: node.id,
        kind: "agent",
        roleType: "main",
        label: node.data.name || "标准 Agent",
        ordinal: 1,
        count: 1,
      });
      continue;
    }
    if (node.type !== "role") continue;
    const roleType = roleTypeOf(node);
    const ordinal = (seen.get(roleType) ?? 0) + 1;
    seen.set(roleType, ordinal);
    const count = roleCounts.get(roleType) ?? 1;
    entries.push({
      id: node.id,
      kind: "role",
      roleType,
      label: node.data.name || ROLE_LABELS[roleType] || roleType,
      ordinal,
      count,
    });
  }
  return entries;
}

type SelectOption = { value: string; label: string; disabled?: boolean };

/** 自定义下拉：固定定位到 body，避免被抽屉滚动容器裁切。 */
function HarnessSelect({
  value,
  options,
  onChange,
  placeholder = "请选择",
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const height = Math.min(options.length * 34 + 8, 260);
    const below = rect.bottom + 4;
    const above = rect.top - height - 4;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, above) : below;
    const width = Math.max(rect.width, 220);
    setMenu({
      top,
      left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8),
      width,
    });
  }, [options.length]);

  useEffect(() => {
    if (!open) {
      setMenu(null);
      return;
    }
    place();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="mc-harness__selecttrigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="mc-harness__selectvalue" data-placeholder={!selected}>
          {selected?.label ?? placeholder}
        </span>
        <LuChevronDown size={14} className="mc-harness__selectchevron" />
      </button>
      {open && menu
        ? createPortal(
            <div
              ref={menuRef}
              className="mc-harness__selectmenu"
              role="listbox"
              style={{ top: menu.top, left: menu.left, width: menu.width }}
            >
              {options.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  disabled={option.disabled}
                  data-active={option.value === value}
                  className="mc-harness__selectoption"
                  key={option.value}
                  onClick={() => {
                    if (option.disabled) return;
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === value ? <LuCheck size={13} /> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function HarnessEditor({
  workspace,
  profile,
  selectedAgent,
  onRoleSelect,
  onAgentsChange,
  architectureName,
  onArchitectureRename,
}: {
  workspace?: string;
  /** 架构图 id：内置三档（standard/minimal/complex）或自定义架构（custom-1 …） */
  profile: string;
  /** 左栏选中的节点 id：在画布中找到对应节点并打开设置抽屉 */
  selectedAgent?: string | null;
  /** 画布/抽屉选择变化时回传给左栏（null = 清除左栏选中） */
  onRoleSelect?: (id: string | null) => void;
  /** Agent/角色节点增删或改名时同步左栏列表 */
  onAgentsChange?: (entries: HarnessAgentEntry[]) => void;
  /** 左栏列表里的架构名（自定义架构的权威名字，改左栏后画布立即跟着变） */
  architectureName?: string;
  /** 画布上改了主 Agent 名字：回传左栏，让列表项立刻改名 */
  onArchitectureRename?: (name: string) => void;
}) {
  const [doc, setDoc] = useState<HarnessDocument | null>(null);
  /** 该架构对应的档位默认提示词：主 Agent 节点没写提示词时用它预填输入框 */
  const [defaultAgentPrompt, setDefaultAgentPrompt] = useState("");
  /**
   * 自定义架构（custom-*）：主 Agent 节点名与架构名（metadata.name）是同一个名字。
   * 名字来源优先级：左栏列表（props）> 图里的 metadata.name，
   * 这样「左栏改名」和「画布改名」两个方向都能立刻反映到对方。
   */
  const isCustomArchitecture =
    profile !== "standard" && profile !== "minimal" && profile !== "complex";
  const resolvedArchitectureName = isCustomArchitecture
    ? (architectureName?.trim() || doc?.metadata?.name?.trim() || "")
    : "";
  const [selection, setSelection] = useState<Selection>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  /**
   * 平移画布时为了不重渲染整张图（节点多的时候会卡），直接写 DOM；
   * viewportRef 记录最新视口，松手时再同步回 state。
   */
  const viewportRef = useRef<Viewport>(viewport);
  const worldRef = useRef<HTMLDivElement | null>(null);
  /** 拖拽节点时的连线预览层：小尺寸 SVG，只重绘这几条线 */
  const ghostGroupRef = useRef<SVGGElement | null>(null);
  /** 最新文档 / 节点索引：memo 节点可能持有旧回调，读这里保证数据不过期 */
  const docRef = useRef<HarnessDocument | null>(null);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);
  /** 换图后短暂开启 transform 过渡，让画布平滑落到新布局（平时拖拽/缩放不加过渡） */
  const [fitAnimating, setFitAnimating] = useState(false);
  const fitTimerRef = useRef<number | null>(null);
  const [registry, setRegistry] = useState<{
    definitions: AgentDefinitionInfo[];
    tools: string[];
  } | null>(null);
  const [registryState, setRegistryState] = useState<"loading" | "ready" | "error">("loading");
  const [registryError, setRegistryError] = useState("");
  const interactionRef = useRef<PointerInteraction | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const fitToNodes = useCallback((nodes: HarnessNode[]) => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) return;
    const xs = nodes.map((node) => node.position?.x ?? 0);
    const ys = nodes.map((node) => node.position?.y ?? 0);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs) + NODE_W;
    const maxY = Math.max(...ys) + NODE_H;
    const pad = 64;
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const zoom = clamp(
      Math.min(
        (canvas.clientWidth - pad * 2) / width,
        (canvas.clientHeight - pad * 2) / height,
      ),
      MIN_ZOOM,
      1.15,
    );
    setViewport({
      zoom,
      x: (canvas.clientWidth - width * zoom) / 2 - minX * zoom,
      y: (canvas.clientHeight - height * zoom) / 2 - minY * zoom,
    });
  }, []);

  const loadRegistry = useCallback(() => {
    setRegistryState("loading");
    setRegistryError("");
    void fetchAgentDefinitions()
      .then((data) => {
        setRegistry(data);
        setRegistryState("ready");
      })
      .catch((cause: unknown) => {
        setRegistryState("error");
        setRegistryError(cause instanceof Error ? cause.message : String(cause));
      });
  }, []);

  const load = useCallback(() => {
    setError("");
    setStatus("加载中…");
    void fetchHarnessDetail(workspace, profile)
      .then(({ document, agentPrompt }) => {
        setDoc(document);
        setDefaultAgentPrompt(agentPrompt);
        // 切换架构时保留仍然存在的选中（主 Agent 通常是 main），避免右侧面板闪一下
        setSelection((current) => {
          if (!current) return null;
          if (current.kind === "node" && document.nodes.some((node) => node.id === current.id)) {
            return current;
          }
          return null;
        });
        setConnectFrom(null);
        setDirty(false);
        setStatus("");
        // 换图时让画布平滑过渡到新布局，而不是瞬间跳变
        setFitAnimating(true);
        requestAnimationFrame(() => fitToNodes(document.nodes));
        if (fitTimerRef.current !== null) window.clearTimeout(fitTimerRef.current);
        fitTimerRef.current = window.setTimeout(() => {
          setFitAnimating(false);
          fitTimerRef.current = null;
        }, 280);
      })
      .catch((cause: unknown) => {
        setStatus("");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [workspace, profile, fitToNodes]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 左栏改名后同步进画布文档：否则下次保存会用旧的 metadata.name 把服务端的改名覆盖掉。
   * 这里只对齐名字，不标 dirty（改名本身已经落盘）。
   */
  useEffect(() => {
    if (!isCustomArchitecture) return;
    const next = architectureName?.trim();
    if (!next) return;
    setDoc((current) => {
      if (!current) return current;
      if ((current.metadata?.name ?? "") === next) return current;
      return { ...current, metadata: { ...current.metadata, name: next } };
    });
  }, [architectureName, isCustomArchitecture]);

  useEffect(() => {
    loadRegistry();
  }, [loadRegistry]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      setViewport((current) => {
        const zoom = clamp(
          current.zoom * Math.exp(-event.deltaY * 0.0015),
          MIN_ZOOM,
          MAX_ZOOM,
        );
        if (zoom === current.zoom) return current;
        return {
          zoom,
          x: px - ((px - current.x) / current.zoom) * zoom,
          y: py - ((py - current.y) / current.zoom) * zoom,
        };
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const mutate = useCallback((updater: (current: HarnessDocument) => HarnessDocument) => {
    setDoc((current) => (current ? updater(current) : current));
    setDirty(true);
  }, []);

  const addNode = (type: HarnessNodeType) => {
    if (!doc) return;
    const base = type === "agent" ? "main" : type === "tier" ? "T3" : type === "gate" ? "G7" : "custom";
    const id = uniqueId(base, doc.nodes.map((node) => node.id));
    const canvas = canvasRef.current;
    const centerX = ((canvas?.clientWidth ?? 800) / 2 - viewport.x) / viewport.zoom;
    const centerY = ((canvas?.clientHeight ?? 500) / 2 - viewport.y) / viewport.zoom;
    const x = Math.round(centerX - NODE_W / 2 + doc.nodes.length * 18);
    const y = Math.round(centerY - NODE_H / 2 + doc.nodes.length * 14);

    const node: HarnessNode = {
      id,
      type,
      data: {
        name:
          type === "agent"
            ? "主 Agent"
            : type === "tier"
              ? "新层级"
              : type === "gate"
                ? "新门禁"
                : "自定义",
        ...(type === "gate" ? { invariant: "" } : {}),
        ...(type === "agent" ? { description: "" } : {}),
        ...(type === "role"
          ? {
              description: "自定义子 Agent：工具白名单与系统提示词由该节点的属性面板覆盖",
              role: "custom",
            }
          : {}),
      },
      position: { x, y },
    };
    mutate((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelection({ kind: "node", id });
    onRoleSelect?.(id);
  };

  const deleteSelection = () => {
    if (!selection || !doc) return;
    if (selection.kind === "node") {
      mutate((current) => ({
        ...current,
        nodes: current.nodes.filter((node) => node.id !== selection.id),
        edges: current.edges.filter((edge) => edge.source !== selection.id && edge.target !== selection.id),
      }));
    } else {
      mutate((current) => ({
        ...current,
        edges: current.edges.filter((edge) => edge.id !== selection.id),
      }));
    }
    setSelection(null);
    onRoleSelect?.(null);
  };

  /** 选中一条边（EdgeLine 的回调，保持引用稳定以便 memo 生效） */
  const selectEdge = useCallback(
    (id: string) => {
      setSelection({ kind: "edge", id });
      onRoleSelect?.(null);
    },
    [onRoleSelect],
  );

  const onNodePointerDown = (event: React.PointerEvent, node: HarnessNode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (connectFrom && connectFrom !== node.id) {
      // 连线模式：点第二个节点成边
      const source = connectFrom;
      const target = node.id;
      setConnectFrom(null);
      mutate((current) => {
        if (current.edges.some((edge) => edge.source === source && edge.target === target)) {
          return current;
        }
        const kind = edgeKindOf(current.nodes, source, target);
        const order =
          kind === "tier-gate"
            ? current.edges.filter((edge) => edge.type === "tier-gate" && edge.source === source).length + 1
            : undefined;
        const edge: HarnessEdge = {
          id: uniqueId(`${source}-${target}`, current.edges.map((item) => item.id)),
          source,
          target,
          type: kind,
          ...(order !== undefined ? { order } : {}),
        };
        return { ...current, edges: [...current.edges, edge] };
      });
      return;
    }
    setSelection({ kind: "node", id: node.id });
    if (node.type === "role" || node.type === "agent") onRoleSelect?.(node.id);
    canvas.setPointerCapture(event.pointerId);
    // 拖拽期间直接改 DOM：只碰被拖的节点和与它相连的边，完全不惊动 React
    const world = worldRef.current;
    const nodeEl = world?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`) ?? null;
    // 起点优先从 DOM 实测（节点定位用 transform），避免 doc 与画面不同步时跳一下
    const domOrigin = readTranslate(nodeEl);
    const originX = domOrigin?.x ?? node.position?.x ?? 0;
    const originY = domOrigin?.y ?? node.position?.y ?? 0;
    const liveDoc = docRef.current;
    const edgeEls = (liveDoc?.edges ?? [])
      .filter((edge) => edge.source === node.id || edge.target === node.id)
      .map((edge) => ({
        edge,
        el: world?.querySelector<SVGGElement>(`[data-edge-id="${CSS.escape(edge.id)}"]`) ?? null,
      }));
    interactionRef.current = {
      kind: "node",
      pointerId: event.pointerId,
      nodeId: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX,
      originY,
      // 关键：这里必须读 ref。NodeCard 是 memo 的，回调可能停留在旧渲染，
      // 闭包里的 viewport 会是切图前的旧缩放（拖多节点图拖不动、拖少节点图飞出去）。
      zoom: viewportRef.current.zoom,
      moved: false,
      nodeEl,
      edgeEls,
      ghostPaths: [],
      lastX: originX,
      lastY: originY,
    };
  };

  const onCanvasPointerDown = (event: React.PointerEvent) => {
    // 节点点击走事件委托：NodeCard 是 memo 的，绑在它身上的回调容易过期，
    // 这里统一用最新闭包处理，拖拽 / 连线模式都不会拿到旧状态。
    const nodeEl = (event.target as HTMLElement | null)?.closest?.(
      "[data-node-id]",
    ) as HTMLElement | null;
    const liveNode = nodeEl
      ? docRef.current?.nodes.find((item) => item.id === nodeEl.dataset.nodeId)
      : undefined;
    if (liveNode) {
      onNodePointerDown(event, liveNode);
      return;
    }
    // 左键或中键都能平移画布
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 1) event.preventDefault();
    // 点空白处只退出连线模式，保留当前选中（右侧属性面板不关闭）
    if (connectFrom) setConnectFrom(null);
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(event.pointerId);
    interactionRef.current = {
      kind: "pan",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: viewportRef.current.x,
      originY: viewportRef.current.y,
      moved: false,
    };
  };

  /** 平移时直接改 DOM（world transform + 网格背景），绕开 React 重渲染 */
  const applyPanDom = (v: Viewport) => {
    if (worldRef.current) {
      worldRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    }
    if (canvasRef.current) {
      canvasRef.current.style.backgroundPosition = `${v.x}px ${v.y}px`;
    }
  };

  /**
   * 开始拖拽时才建预览层（单击不闪）：真实边临时隐藏，
   * 拖动过程中只更新这个小 SVG 里的几条线，避免每帧重绘整块连线层。
   */
  const beginGhostDrag = (drag: {
    edgeEls: Array<{ edge: HarnessEdge; el: SVGGElement | null }>;
    ghostPaths: SVGPathElement[];
  }) => {
    const ghost = ghostGroupRef.current;
    if (!ghost || drag.ghostPaths.length > 0 || drag.edgeEls.length === 0) return;
    const v = viewportRef.current;
    ghost.setAttribute("transform", `translate(${v.x},${v.y}) scale(${v.zoom})`);
    ghost.innerHTML = "";
    for (const item of drag.edgeEls) {
      if (item.el) item.el.style.visibility = "hidden";
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", item.edge.type === "tier-gate" ? "var(--fg)" : "var(--fg-subtle)");
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("opacity", "0.65");
      if (item.edge.type === "gate-role") path.setAttribute("stroke-dasharray", "5 4");
      path.setAttribute("marker-end", "url(#mc-harness-arrow)");
      ghost.appendChild(path);
      drag.ghostPaths.push(path);
    }
  };


  const onPointerMove = (event: React.PointerEvent) => {
    const drag = interactionRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    if (drag.kind === "node") {
      beginGhostDrag(drag);
      // 只改 DOM：节点 transform + 预览层里的连线，拖多少节点都跟手
      const x = Math.round(drag.originX + dx / drag.zoom);
      const y = Math.round(drag.originY + dy / drag.zoom);
      drag.lastX = x;
      drag.lastY = y;
      if (drag.nodeEl) {
        drag.nodeEl.style.transform = `translate(${x}px, ${y}px)`;
      }
      // 只改预览层：几条 path，重绘范围是视口大小而不是整张画布
      drag.edgeEls.forEach((item, index) => {
        const path = drag.ghostPaths[index];
        if (!path) return;
        const from =
          item.edge.source === drag.nodeId ? { x, y } : nodeById.get(item.edge.source)?.position;
        const to =
          item.edge.target === drag.nodeId ? { x, y } : nodeById.get(item.edge.target)?.position;
        if (!from || !to) return;
        path.setAttribute("d", edgePath(from, to).d);
      });
      return;
    }
    // 平移：只改 DOM，不动 state（节点多时这是最大的卡顿来源）
    const next = { ...viewportRef.current, x: drag.originX + dx, y: drag.originY + dy };
    viewportRef.current = next;
    applyPanDom(next);
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const drag = interactionRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    interactionRef.current = null;
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    if (drag.kind === "node") {
      // 恢复真实边、清掉预览层
      for (const item of drag.edgeEls) {
        if (item.el) item.el.style.visibility = "";
      }
      if (ghostGroupRef.current) ghostGroupRef.current.innerHTML = "";
      // 松手才提交到文档：一次渲染搞定，拖拽过程零 React 参与
      if (!drag.moved) return;
      const { nodeId, lastX, lastY } = drag;
      setDoc((current) =>
        current
          ? {
              ...current,
              nodes: current.nodes.map((node) =>
                node.id === nodeId ? { ...node, position: { x: lastX, y: lastY } } : node,
              ),
            }
          : current,
      );
      setDirty(true);
      return;
    }
    // 平移结束才同步 state，让缩放百分比等派生值跟上
    if (drag.moved) setViewport(viewportRef.current);
  };

  const save = () => {
    if (!doc) return;
    setSaving(true);
    setError("");
    setStatus("保存中…");
    void saveHarness(workspace, profile, doc)
      .then(() => {
        setDirty(false);
        setStatus("已保存 — 治理 run 在下一次 admit 前装载新图");
      })
      .catch((cause: unknown) => {
        setStatus("");
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setSaving(false));
  };

  const reset = useCallback(() => {
    setStatus("");
    setError("");
    // 内置种子由服务端提供（与运行时的图同源），避免编辑器里再维护一份副本
    void fetchHarnessDetail(workspace, profile, { seed: true })
      .then(({ document: seed, agentPrompt }) => {
        setDoc(seed);
        setDefaultAgentPrompt(agentPrompt);
        setSelection(null);
        onRoleSelect?.(null);
        setConnectFrom(null);
        setDirty(true);
        setStatus("已重置为内置架构 — 保存后生效");
        requestAnimationFrame(() => fitToNodes(seed.nodes));
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [workspace, profile, fitToNodes, onRoleSelect]);

  const nodeById = useMemo(() => new Map((doc?.nodes ?? []).map((node) => [node.id, node])), [doc]);

  /** 左栏点选 Agent 后，打开画布中对应节点的设置抽屉；编辑节点时不重复覆盖当前选择。 */
  const appliedAgentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!doc) return;
    if (!selectedAgent) {
      appliedAgentRef.current = null;
      return;
    }
    const currentNode = selection?.kind === "node" ? nodeById.get(selection.id) : null;
    if (currentNode?.id === selectedAgent) {
      appliedAgentRef.current = selectedAgent;
      return;
    }
    if (appliedAgentRef.current === selectedAgent) return;
    const target = doc.nodes.find(
      (node) =>
        node.id === selectedAgent && (node.type === "role" || node.type === "agent"),
    );
    if (!target) return;
    appliedAgentRef.current = selectedAgent;
    setSelection({ kind: "node", id: target.id });
  }, [selectedAgent, doc, selection, nodeById]);

  const agentEntries = useMemo(() => (doc ? summarizeAgents(doc) : []), [doc]);
  const roleOrdinalById = useMemo(
    () =>
      new Map(
        agentEntries
          .filter((entry) => entry.kind === "role")
          .map((entry) => [entry.id, entry] as const),
      ),
    [agentEntries],
  );
  const agentSignature = agentEntries
    .map((entry) => `${entry.id}:${entry.kind}:${entry.roleType}:${entry.label}:${entry.ordinal}:${entry.count}`)
    .join("|");
  useEffect(() => {
    if (!doc) return;
    onAgentsChange?.(agentEntries);
    // agentEntries 的语义变化由 agentSignature 捕获；拖动节点不应刷新左栏
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSignature, onAgentsChange]);

  const selectedNode =
    selection?.kind === "node" ? (nodeById.get(selection.id) ?? null) : null;
  const selectedEdge =
    selection?.kind === "edge" ? (doc?.edges.find((edge) => edge.id === selection.id) ?? null) : null;
  const gateIds = (doc?.nodes ?? []).filter((node) => node.type === "gate").map((node) => node.id);

  const definitionByName = useMemo(
    () =>
      new Map<string, AgentDefinitionInfo>(
        (registry?.definitions ?? []).map((definition) => [definition.name, definition]),
      ),
    [registry],
  );
  const registryTools = registry?.tools ?? [];
  const selectedRoleDefinition =
    selectedNode?.type === "role"
      ? definitionByName.get(roleTypeOf(selectedNode))
      : undefined;

  const selectedTierGates = useMemo(() => {
    if (!doc || selectedNode?.type !== "tier") return [];
    return doc.edges
      .filter((edge) => edge.type === "tier-gate" && edge.source === selectedNode.id)
      .map((edge) => ({ id: edge.target, order: edge.order ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.order - b.order);
  }, [doc, selectedNode]);

  const selectedGateCloser = useMemo(() => {
    if (!doc || selectedNode?.type !== "gate") return null;
    return (
      doc.edges.find((edge) => edge.type === "gate-role" && edge.source === selectedNode.id)
        ?.target ?? null
    );
  }, [doc, selectedNode]);

  const selectedRoleGates = useMemo(() => {
    if (!doc || selectedNode?.type !== "role") return [];
    return doc.edges
      .filter((edge) => edge.type === "gate-role" && edge.target === selectedNode.id)
      .map((edge) => edge.source);
  }, [doc, selectedNode]);

  const selectedAgentTargets = useMemo(() => {
    if (!doc || selectedNode?.type !== "agent") return [];
    return doc.edges
      .filter(
        (edge) =>
          edge.source === selectedNode.id &&
          (edge.type === "agent-role" || edge.type === "agent-tier"),
      )
      .map((edge) => ({ id: edge.target, kind: edge.type }));
  }, [doc, selectedNode]);

  // 子 Agent 永远拿不到 task / admit；工具面板不展示这两项，避免误导。
  const visibleTools = (registry?.tools ?? []).filter(
    (tool) => tool !== "task" && tool !== "admit",
  );
  // 主 Agent 可以覆盖档位默认的工具白名单（task / admit 是编排通道，这里允许勾选）
  const allAgentTools = registry?.tools ?? [];
  const explicitAgentTools =
    selectedNode?.type === "agent" && Array.isArray(selectedNode.data.tools)
      ? selectedNode.data.tools
      : null;
  const agentToolsOverridden = explicitAgentTools !== null;
  const effectiveAgentTools = explicitAgentTools ?? allAgentTools;
  // 主 Agent 的系统提示词覆盖（留空 = 用档位默认）
  const agentPromptOverridden =
    selectedNode?.type === "agent" &&
    typeof selectedNode.data.systemPrompt === "string" &&
    selectedNode.data.systemPrompt.trim() !== "";
  const explicitRoleTools =
    selectedNode?.type === "role" && Array.isArray(selectedNode.data.tools)
      ? selectedNode.data.tools.filter((tool) => tool !== "task" && tool !== "admit")
      : null;
  const roleToolsOverridden = explicitRoleTools !== null;
  const effectiveRoleTools =
    selectedNode?.type === "role"
      ? explicitRoleTools ??
        (selectedRoleDefinition
          ? selectedRoleDefinition.tools ?? visibleTools
          : [])
      : [];
  const roleToolsAreFull =
    selectedNode?.type === "role" &&
    explicitRoleTools === null &&
    selectedRoleDefinition?.tools === null;
  const roleToolCount = roleToolsAreFull ? "全量" : String(effectiveRoleTools.length);
  const roleToolSummary =
    explicitRoleTools !== null
      ? effectiveRoleTools.join(", ") || "无工具"
      : roleToolsAreFull
        ? "全量工具，另含 MCP / 浏览器动态工具"
        : selectedRoleDefinition
          ? effectiveRoleTools.join(", ") || "无工具"
          : registryState === "error"
            ? "注册表不可用"
            : "正在读取注册表…";
  const rolePromptOverridden =
    selectedNode?.type === "role" && typeof selectedNode.data.systemPrompt === "string";

  const InspectorIcon = selectedNode ? TYPE_ICONS[selectedNode.type] : LuLink2;
  const selectedRoleInfo =
    selectedNode?.type === "role" ? roleOrdinalById.get(selectedNode.id) : undefined;
  const inspectorTitle = selectedNode
    ? isCustomArchitecture && selectedNode.type === "agent" && resolvedArchitectureName
      ? resolvedArchitectureName
      : selectedNode.data.name
        ? `${selectedNode.data.name}${
            selectedRoleInfo && selectedRoleInfo.count > 1
              ? ` ${selectedRoleInfo.ordinal}`
              : ""
          }`
        : selectedNode.id
    : "连线";
  const inspectorSubtitle = selectedNode
    ? selectedNode.type === "agent"
      ? `主 Agent · ${selectedNode.id}`
      : selectedNode.type === "tier"
        ? `任务层级 · ${selectedNode.id}`
        : selectedNode.type === "gate"
          ? `质量门 · ${selectedNode.id}`
          : `子 Agent · ${roleTypeOf(selectedNode)}${
              (roleOrdinalById.get(selectedNode.id)?.count ?? 1) > 1
                ? ` #${roleOrdinalById.get(selectedNode.id)?.ordinal}`
                : ""
            }`
    : selectedEdge
      ? `连线 · ${selectedEdge.type ?? "flow"}`
      : "";

  /** 编辑节点 data 字段（name / invariant / onFail 等） */
  const updateNode = (id: string, dataPatch: Record<string, unknown>) => {
    const target = doc?.nodes.find((node) => node.id === id);
    // 只认第一个 agent 节点为主 Agent；改它的名字 = 改架构名
    const rootAgentId = doc?.nodes.find((node) => node.type === "agent")?.id;
    const syncArchitectureName =
      isCustomArchitecture &&
      target?.type === "agent" &&
      target.id === rootAgentId &&
      typeof dataPatch.name === "string";
    mutate((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, ...dataPatch } } : node,
      ),
      ...(syncArchitectureName
        ? { metadata: { ...current.metadata, name: dataPatch.name as string } }
        : {}),
    }));
    // 画布改名 → 左栏列表立刻跟着改
    if (syncArchitectureName) onArchitectureRename?.(dataPatch.name as string);
  };

  const changeRoleType = (next: string) => {
    if (!selectedNode || selectedNode.type !== "role") return;
    const currentType = roleTypeOf(selectedNode);
    if (next === currentType) return;
    const patch: Record<string, unknown> = { role: next };
    if (!selectedNode.data.name || selectedNode.data.name === ROLE_LABELS[currentType]) {
      patch.name = ROLE_LABELS[next] ?? next;
    }
    updateNode(selectedNode.id, patch);
  };

  const renameNode = (nodeId: string, nextId: string) => {
    const next = nextId.trim();
    if (!next || next === nodeId) return;
    mutate((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId ? { ...node, id: next } : node,
      ),
      edges: current.edges.map((edge) => ({
        ...edge,
        source: edge.source === nodeId ? next : edge.source,
        target: edge.target === nodeId ? next : edge.target,
      })),
    }));
    setSelection({ kind: "node", id: next });
    const renamed = nodeById.get(nodeId);
    if (renamed?.type === "agent" || renamed?.type === "role") onRoleSelect?.(next);
  };

  const setGateCloser = (gateId: string, roleId: string) => {
    mutate((current) => {
      const rest = current.edges.filter(
        (edge) => !(edge.type === "gate-role" && edge.source === gateId),
      );
      if (!roleId) return { ...current, edges: rest };
      return {
        ...current,
        edges: [
          ...rest,
          {
            id: uniqueId(`${gateId}-${roleId}`, rest.map((edge) => edge.id)),
            source: gateId,
            target: roleId,
            type: "gate-role",
          },
        ],
      };
    });
  };

  const toggleRoleGate = (gateId: string) => {
    if (!selectedNode || selectedNode.type !== "role") return;
    const roleId = selectedNode.id;
    mutate((current) => {
      const bound = current.edges.some(
        (edge) => edge.type === "gate-role" && edge.source === gateId && edge.target === roleId,
      );
      const rest = current.edges.filter(
        (edge) => !(edge.type === "gate-role" && edge.source === gateId),
      );
      if (bound) return { ...current, edges: rest };
      return {
        ...current,
        edges: [
          ...rest,
          {
            id: uniqueId(`${gateId}-${roleId}`, rest.map((edge) => edge.id)),
            source: gateId,
            target: roleId,
            type: "gate-role",
          },
        ],
      };
    });
  };

  const toggleTierGate = (gateId: string) => {
    if (!selectedNode || selectedNode.type !== "tier") return;
    const tierId = selectedNode.id;
    mutate((current) => {
      const existing = current.edges.find(
        (edge) => edge.type === "tier-gate" && edge.source === tierId && edge.target === gateId,
      );
      if (existing) {
        return { ...current, edges: current.edges.filter((edge) => edge !== existing) };
      }
      const order =
        current.edges.filter((edge) => edge.type === "tier-gate" && edge.source === tierId)
          .length + 1;
      return {
        ...current,
        edges: [
          ...current.edges,
          {
            id: uniqueId(`${tierId}-${gateId}`, current.edges.map((edge) => edge.id)),
            source: tierId,
            target: gateId,
            type: "tier-gate",
            order,
          },
        ],
      };
    });
  };

  const setRoleTools = (tools: string[] | undefined) => {
    if (!selectedNode || selectedNode.type !== "role") return;
    updateNode(selectedNode.id, { tools });
  };

  const toggleRoleTool = (tool: string) => {
    const current = effectiveRoleTools;
    const next = current.includes(tool)
      ? current.filter((item) => item !== tool)
      : [...current, tool];
    setRoleTools(next);
  };

  /** 主 Agent 的工具白名单：undefined = 跟随档位 */
  const setAgentTools = (tools: string[] | undefined) => {
    if (!selectedNode || selectedNode.type !== "agent") return;
    updateNode(selectedNode.id, { tools });
  };

  const toggleAgentTool = (tool: string) => {
    const current = effectiveAgentTools;
    const next = current.includes(tool)
      ? current.filter((item) => item !== tool)
      : [...current, tool];
    setAgentTools(next);
  };

  return (
    <div className="mc-harness">
      <div className="mc-harness__toolbar">
        <button type="button" className="mc-harness__btn" onClick={() => addNode("tier")}>
          <LuPlus size={13} /> 层级
        </button>
        <button type="button" className="mc-harness__btn" onClick={() => addNode("gate")}>
          <LuPlus size={13} /> 门禁
        </button>
        <button type="button" className="mc-harness__btn" onClick={() => addNode("role")}>
          <LuPlus size={13} /> 子 Agent
        </button>
        <span className="mc-harness__sep" />
        <button
          type="button"
          className="mc-harness__btn"
          data-active={connectFrom !== null}
          title="点击起点节点，再点击终点节点连线"
          onClick={() => {
            setConnectFrom(connectFrom ? null : (selection?.kind === "node" ? selection.id : null));
            if (connectFrom === null) {
              setStatus(selection?.kind === "node" ? "连线模式：点击目标节点" : "先选中一个节点，再点「连线」");
            } else {
              setStatus("");
            }
          }}
        >
          {connectFrom ? <LuUnlink size={13} /> : <LuLink2 size={13} />}
          {connectFrom ? "取消连线" : "连线"}
        </button>
        <button
          type="button"
          className="mc-harness__btn"
          disabled={!selection}
          onClick={deleteSelection}
          title="删除选中的节点或连线（节点删除会级联删除相连边）"
        >
          <LuTrash2 size={13} /> 删除
        </button>
        <span className="mc-harness__sep" />
        <button
          type="button"
          className="mc-harness__btn"
          disabled={!doc}
          onClick={() => doc && fitToNodes(doc.nodes)}
          title="居中并缩放显示整张架构图"
        >
          <LuMaximize size={13} /> 适应画布
        </button>
        <span className="mc-harness__zoom">{Math.round(viewport.zoom * 100)}%</span>
        <span className="mc-harness__sep" />
        <button type="button" className="mc-harness__btn" onClick={reset}>
          <LuRotateCcw size={13} /> 重置内置
        </button>
        <button
          type="button"
          className="mc-harness__btn mc-harness__btn--primary"
          disabled={!doc || saving}
          data-dirty={dirty}
          onClick={save}
        >
          <LuSave size={13} /> 保存到工作区
        </button>
        {status ? <span className="mc-harness__status">{status}</span> : null}
        {dirty && !status ? <span className="mc-harness__status">有未保存修改</span> : null}
      </div>
      {error ? <p className="mc-harness__error">{error}</p> : null}
      <div className="mc-harness__main">
        <div
          className="mc-harness__canvas"
          ref={canvasRef}
          style={{
            backgroundSize: `${22 * viewport.zoom}px ${22 * viewport.zoom}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          }}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {!doc ? (
            <p className="mc-harness__hint">正在加载架构图…</p>
          ) : (
            <>
              {/* 拖拽预览层：视口大小，只画正在拖的那几条线，避免整块大 SVG 重绘 */}
              <svg className="mc-harness__ghost" aria-hidden="true">
                <g ref={ghostGroupRef} />
              </svg>
              <div
                ref={worldRef}
                className="mc-harness__world"
                data-fit-anim={fitAnimating}
                style={{
                  width: WORLD_W,
                  height: WORLD_H,
                  transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
                }}
            >
              <svg className="mc-harness__svg" width={WORLD_W} height={WORLD_H}>
                <defs>
                  <marker id="mc-harness-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 8 4 L 0 8 z" className="mc-harness__arrow" />
                  </marker>
                </defs>
                {doc.edges.map((edge) => {
                  const from = nodeById.get(edge.source);
                  const to = nodeById.get(edge.target);
                  if (!from?.position || !to?.position) return null;
                  return (
                    <EdgeLine
                      key={edge.id}
                      edge={edge}
                      x1={from.position.x + NODE_W}
                      y1={from.position.y + NODE_H / 2}
                      x2={to.position.x}
                      y2={to.position.y + NODE_H / 2}
                      selected={selection?.kind === "edge" && selection.id === edge.id}
                      onSelect={selectEdge}
                    />
                  );
                })}
              </svg>
              {doc.nodes.map((node) => {
                const roleOrdinal = node.type === "role" ? roleOrdinalById.get(node.id) : undefined;
                // 自定义架构的主 Agent 节点名 = 架构名（与左栏列表同一个名字）
                const displayName =
                  isCustomArchitecture && node.type === "agent" && resolvedArchitectureName
                    ? resolvedArchitectureName
                    : node.data.name || node.id;
                // 没有 tier-gate 出边的层级 = 无门禁直通（内置 T0）
                const terminalTier =
                  node.type === "tier" &&
                  !doc.edges.some((edge) => edge.type === "tier-gate" && edge.source === node.id);
                return (
                  <NodeCard
                    key={node.id}
                    node={node}
                    selected={selection?.kind === "node" && selection.id === node.id}
                    connecting={connectFrom === node.id}
                    roleOrdinalNum={roleOrdinal?.ordinal}
                    roleCount={roleOrdinal?.count}
                    terminalTier={terminalTier}
                    displayName={displayName}
                  />
                );
              })}
              </div>
            </>
          )}
          {doc ? (
            <p className="mc-harness__legend">
              拖动节点 · 空白处平移 · 滚轮缩放　|　主 Agent→子 Agent = task 派发，主 Agent→层级 =
              admit　|　tier→gate 序号 = 门禁顺序，gate→role = 关账
            </p>
          ) : null}
        </div>
        {selection ? (
          <aside className="mc-harness__inspector" aria-label="节点属性">
            <header className="mc-harness__inspecthead">
              <span className="mc-harness__inspecticon">
                <InspectorIcon size={16} />
              </span>
              <div className="mc-harness__inspectnames">
                <h3 className="mc-harness__inspecttitle">{inspectorTitle}</h3>
                <p className="mc-harness__inspectsubtitle">{inspectorSubtitle}</p>
              </div>
              <button
                type="button"
                className="mc-harness__inspectclose"
                onClick={() => {
                  setSelection(null);
                  onRoleSelect?.(null);
                }}
                aria-label="关闭属性面板"
              >
                <LuX size={15} />
              </button>
            </header>

            {selectedNode ? (
              <div className="mc-harness__inspectbody">
                {selectedNode.type === "agent" ? (
                  <>
                    <label className="mc-harness__field">
                      节点名称
                      <input
                        value={
                          isCustomArchitecture && resolvedArchitectureName
                            ? resolvedArchitectureName
                            : (selectedNode.data.name ?? "")
                        }
                        onChange={(event) =>
                          updateNode(selectedNode.id, { name: event.target.value })
                        }
                      />
                    </label>
                    <label className="mc-harness__field">
                      节点 id
                      <input
                        value={selectedNode.id}
                        onChange={(event) => renameNode(selectedNode.id, event.target.value)}
                      />
                    </label>
                    <label className="mc-harness__field">
                      职责说明
                      <textarea
                        rows={4}
                        value={selectedNode.data.description ?? ""}
                        onChange={(event) =>
                          updateNode(selectedNode.id, { description: event.target.value })
                        }
                      />
                    </label>
                    <div className="mc-harness__field">
                      <span className="mc-harness__fieldhead">
                        可用工具
                        <span className="mc-harness__fieldactions">
                          <button
                            type="button"
                            onClick={() => setAgentTools(allAgentTools)}
                            disabled={!allAgentTools.length}
                          >
                            全选
                          </button>
                          <button
                            type="button"
                            onClick={() => setAgentTools([])}
                            disabled={!allAgentTools.length}
                          >
                            清空
                          </button>
                          <button
                            type="button"
                            onClick={() => setAgentTools(undefined)}
                            disabled={!agentToolsOverridden}
                          >
                            恢复默认
                          </button>
                        </span>
                      </span>
                      {allAgentTools.length ? (
                        <div className="mc-harness__toolgrid">
                          {allAgentTools.map((tool) => (
                            <button
                              type="button"
                              className="mc-harness__toolchip"
                              // 未覆盖时视为跟随档位：全部显示为可用
                              data-on={agentToolsOverridden ? effectiveAgentTools.includes(tool) : true}
                              key={tool}
                              onClick={() => toggleAgentTool(tool)}
                            >
                              {tool}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="mc-harness__emptyfact">
                          {registryState === "error"
                            ? "注册表不可用 — 重启应用或点上方重试"
                            : "正在读取注册表…"}
                        </span>
                      )}
                      <p className="mc-harness__toolsmeta">
                        {agentToolsOverridden ? `已选 ${effectiveAgentTools.length} 项` : "跟随当前档位"}
                        <span>
                          {agentToolsOverridden
                            ? effectiveAgentTools.join(", ") || "无工具"
                            : "未覆盖时不额外限制，由档位决定"}
                        </span>
                        <span>task / admit 是编排通道，始终可用</span>
                      </p>
                    </div>
                    <div className="mc-harness__field">
                      <span className="mc-harness__fieldhead">
                        系统提示词
                        <span className="mc-harness__fieldactions">
                          <button
                            type="button"
                            onClick={() => updateNode(selectedNode.id, { systemPrompt: undefined })}
                            disabled={!agentPromptOverridden}
                          >
                            恢复默认
                          </button>
                        </span>
                      </span>
                      <textarea
                        className="mc-harness__prompt"
                        rows={10}
                        placeholder="留空 = 使用当前档位的默认提示词"
                        // 未覆盖时预填档位默认提示词，可以直接在上面改
                        value={selectedNode.data.systemPrompt ?? defaultAgentPrompt}
                        onChange={(event) =>
                          updateNode(selectedNode.id, { systemPrompt: event.target.value })
                        }
                      />
                      <p className="mc-harness__note">
                        输入框里预填的是当前档位的默认提示词；改完保存即生效。
                        自定义内容是<strong>整体替换</strong>档位提示词，记得保留工具用法、路径规则等基础约定。
                      </p>
                    </div>
                    <div className="mc-harness__field">
                      <span className="mc-harness__fieldhead">
                        派发关系
                        <span className="mc-harness__fieldactions">在连线上改</span>
                      </span>
                      {selectedAgentTargets.length ? (
                        <div className="mc-harness__toolgrid">
                          {selectedAgentTargets.map((target) => (
                            <span
                              className="mc-harness__toolchip"
                              data-on="true"
                              key={`${target.kind}-${target.id}`}
                            >
                              {target.kind === "agent-tier" ? "admit" : "task"} {target.id}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="mc-harness__emptyfact">还没有派发连线</span>
                      )}
                    </div>
                    <p className="mc-harness__note">
                      主 Agent 是常驻根 runtime，不参与门禁；关账子 Agent 通过 tier→gate→role
                      链路关账。子 Agent 不能再派发。
                    </p>
                  </>
                ) : selectedNode.type === "role" ? (
                  <>
                    {registryState === "error" ? (
                      <div className="mc-harness__registry-error">
                        <div>
                          <strong>子 Agent 注册表加载失败</strong>
                          <code>{registryError}</code>
                          <p>
                            桌面端可能仍在运行旧的服务端构建；重启应用后重试。
                          </p>
                        </div>
                        <button type="button" onClick={loadRegistry}>
                          重试
                        </button>
                      </div>
                    ) : null}
                    <label className="mc-harness__field">
                      子 Agent 标识
                      <HarnessSelect
                        value={roleTypeOf(selectedNode)}
                        onChange={changeRoleType}
                        options={ROLE_OPTIONS.map((name) => ({ value: name, label: name }))}
                      />
                    </label>
                    <label className="mc-harness__field">
                      显示名
                      <input
                        value={selectedNode.data.name ?? ""}
                        onChange={(event) =>
                          updateNode(selectedNode.id, { name: event.target.value })
                        }
                      />
                    </label>
                    <label className="mc-harness__field">
                      子 Agent 职责简述
                      <textarea
                        rows={3}
                        value={selectedNode.data.description ?? ""}
                        onChange={(event) =>
                          updateNode(selectedNode.id, { description: event.target.value })
                        }
                      />
                    </label>
                    <div className="mc-harness__field">
                      <span className="mc-harness__fieldhead">
                        可用工具
                        <span className="mc-harness__fieldactions">
                          <button
                            type="button"
                            onClick={() => setRoleTools(visibleTools)}
                            disabled={!selectedRoleDefinition}
                          >
                            全选
                          </button>
                          <button
                            type="button"
                            onClick={() => setRoleTools([])}
                            disabled={!selectedRoleDefinition}
                          >
                            清空
                          </button>
                          <button
                            type="button"
                            onClick={() => setRoleTools(undefined)}
                            disabled={!roleToolsOverridden}
                          >
                            恢复内置
                          </button>
                        </span>
                      </span>
                      {visibleTools.length ? (
                        <div className="mc-harness__toolgrid">
                          {visibleTools.map((tool) => (
                            <button
                              type="button"
                              className="mc-harness__toolchip"
                              data-on={effectiveRoleTools.includes(tool)}
                              key={tool}
                              disabled={!selectedRoleDefinition}
                              onClick={() => toggleRoleTool(tool)}
                            >
                              {tool}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="mc-harness__emptyfact">
                          {registryState === "error"
                            ? "注册表不可用 — 重启应用或点上方重试"
                            : "正在读取注册表…"}
                        </span>
                      )}
                      <p className="mc-harness__toolsmeta">
                        已选 {roleToolCount} 项
                        <span>{roleToolSummary}</span>
                        {roleToolsOverridden ? (
                          <span>显式白名单不含运行时注入的 MCP / 浏览器工具</span>
                        ) : null}
                      </p>
                    </div>
                    <div className="mc-harness__field">
                      <span className="mc-harness__fieldhead">
                        门禁绑定
                        <span className="mc-harness__fieldactions">点选改绑</span>
                      </span>
                      {gateIds.length ? (
                        <div className="mc-harness__toolgrid">
                          {gateIds.map((gate) => (
                            <button
                              type="button"
                              className="mc-harness__toolchip"
                              data-on={selectedRoleGates.includes(gate)}
                              key={gate}
                              onClick={() => toggleRoleGate(gate)}
                            >
                              {gate}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="mc-harness__emptyfact">图中还没有门禁节点</span>
                      )}
                      <p className="mc-harness__note">
                        一道门禁只能有一个关账子 Agent，点选已绑定的会解除绑定。
                      </p>
                    </div>
                    <label className="mc-harness__field">
                      <span className="mc-harness__fieldhead">
                        系统提示词
                        <span className="mc-harness__fieldactions">
                          <button
                            type="button"
                            onClick={() =>
                              updateNode(selectedNode.id, { systemPrompt: undefined })
                            }
                            disabled={!rolePromptOverridden}
                          >
                            恢复内置
                          </button>
                        </span>
                      </span>
                      <textarea
                        className="mc-harness__prompt"
                        rows={10}
                        placeholder="留空使用内置提示词"
                        value={
                          selectedNode.data.systemPrompt ??
                          selectedRoleDefinition?.systemPrompt ??
                          ""
                        }
                        onChange={(event) =>
                          updateNode(selectedNode.id, { systemPrompt: event.target.value })
                        }
                      />
                    </label>
                    <p className="mc-harness__note">
                      留空回落内置提示词。只读子 Agent 的审批模式仍由注册表强制；关账子 Agent 需要保留
                      JSON 结果契约，否则 ChildResult 校验会失败。
                    </p>
                  </>
                ) : selectedNode.type === "gate" ? (
                  <>
                    <label className="mc-harness__field">
                      质量门名称
                      <input
                        value={selectedNode.data.name ?? ""}
                        onChange={(event) =>
                          updateNode(selectedNode.id, { name: event.target.value })
                        }
                      />
                    </label>
                    <label className="mc-harness__field">
                      判定不变量 / 验收标准
                      <textarea
                        rows={4}
                        value={selectedNode.data.invariant ?? ""}
                        onChange={(event) =>
                          updateNode(selectedNode.id, { invariant: event.target.value })
                        }
                      />
                    </label>
                    <label className="mc-harness__field">
                      失败策略
                      <HarnessSelect
                        value={selectedNode.data.onFail ?? ""}
                        onChange={(value) =>
                          updateNode(selectedNode.id, { onFail: value })
                        }
                        options={[
                          { value: "", label: "返工（回跳到首道门禁）" },
                          ...gateIds
                            .filter((id) => id !== selectedNode.id)
                            .map((id) => ({
                              value: `loop-to:${id}`,
                              label: `loop-to:${id}（回跳到 ${id}）`,
                            })),
                          { value: "block", label: "block（直接阻塞 lane）" },
                        ]}
                      />
                    </label>
                    <label className="mc-harness__field">
                      关账子 Agent
                      <HarnessSelect
                        value={selectedGateCloser ?? ""}
                        onChange={(value) => setGateCloser(selectedNode.id, value)}
                        options={[
                          { value: "", label: "未绑定（admit 会拒绝）" },
                          ...(doc?.nodes ?? [])
                            .filter((node) => node.type === "role")
                            .map((node) => {
                              const type = roleTypeOf(node);
                              const info = roleOrdinalById.get(node.id);
                              const typeLabel = `${type}${
                                info && info.count > 1 ? ` · ${info.ordinal}` : ""
                              }`;
                              return {
                                value: node.id,
                                label:
                                  node.data.name && node.data.name !== type
                                    ? `${typeLabel} · ${node.data.name}`
                                    : typeLabel,
                              };
                            }),
                        ]}
                      />
                    </label>
                    <p className="mc-harness__note">
                      证据由宿主实测：implementer 看文件改动，reviewer 看 critical findings，
                      verifier 看命令退出码；绑给其他子 Agent 时只校验 completed + valid。
                      门禁不采信模型自述。
                    </p>
                  </>
                ) : (
                  <>
                    <label className="mc-harness__field">
                      层级名称
                      <input
                        value={selectedNode.data.name ?? ""}
                        onChange={(event) =>
                          updateNode(selectedNode.id, { name: event.target.value })
                        }
                      />
                    </label>
                    <label className="mc-harness__field">
                      层级 id（T0 / T1 / T2 才会被 admit 识别）
                      <input
                        value={selectedNode.id}
                        onChange={(event) => renameNode(selectedNode.id, event.target.value)}
                      />
                    </label>
                    <label className="mc-harness__field">
                      层级说明
                      <textarea
                        rows={3}
                        value={selectedNode.data.description ?? ""}
                        onChange={(event) =>
                          updateNode(selectedNode.id, { description: event.target.value })
                        }
                      />
                    </label>
                    <div className="mc-harness__field">
                      <span className="mc-harness__fieldhead">
                        门禁序列
                        <span className="mc-harness__fieldactions">点选增删</span>
                      </span>
                      {gateIds.length ? (
                        <div className="mc-harness__toolgrid">
                          {gateIds.map((gate) => (
                            <button
                              type="button"
                              className="mc-harness__toolchip"
                              data-on={selectedTierGates.some((item) => item.id === gate)}
                              key={gate}
                              onClick={() => toggleTierGate(gate)}
                            >
                              {gate}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="mc-harness__emptyfact">图中还没有门禁节点</span>
                      )}
                      <p className="mc-harness__note">
                        {selectedTierGates.length
                          ? `执行顺序：${selectedTierGates.map((gate) => gate.id).join(" → ")}；顺序在连线上改 order。`
                          : "无门禁 · 直通（admit 后直接完成）"}
                      </p>
                    </div>
                  </>
                )}
              </div>
            ) : selectedEdge ? (
              <div className="mc-harness__inspectbody">
                <div className="mc-harness__factrow">
                  <span>路径</span>
                  <code>
                    {selectedEdge.source} → {selectedEdge.target}
                  </code>
                </div>
                <div className="mc-harness__factrow">
                  <span>类型</span>
                  <code>{selectedEdge.type ?? "flow"}</code>
                </div>
                {selectedEdge.type === "tier-gate" ? (
                  <label className="mc-harness__field">
                    序号 order（同层级内升序执行）
                    <input
                      type="number"
                      min={1}
                      value={selectedEdge.order ?? 1}
                      onChange={(event) =>
                        mutate((current) => ({
                          ...current,
                          edges: current.edges.map((edge) =>
                            edge.id === selectedEdge.id
                              ? { ...edge, order: Number(event.target.value) || 1 }
                              : edge,
                          ),
                        }))
                      }
                    />
                  </label>
                ) : null}
                <p className="mc-harness__note">
                  tier→gate 边决定门禁顺序；gate→role 边决定关账子 Agent；其他连线仅作说明。
                </p>
              </div>
            ) : null}

            <footer className="mc-harness__inspectfoot">
              <button type="button" className="mc-harness__delete" onClick={deleteSelection}>
                <LuTrash2 size={13} />
                {selectedNode ? "删除节点" : "删除连线"}
              </button>
            </footer>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

