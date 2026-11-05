/**
 * 电脑控制（内置插件）。
 *
 * agent 通过 computer_* 工具控制本机：截屏看屏幕、移动/点击鼠标、打字、按键、
 * 滚动、拖拽、列窗口/激活窗口、读写剪贴板。参考 UI-TARS-desktop 与 Anthropic
 * computer-use 的动作集约定：先截图拿到坐标空间，再逐步操作，动作后截图验证。
 *
 * 链路：插件 --HTTP(token)--> desktop/computer-host.cjs（Electron 主进程）
 *       截图走 desktopCapturer；输入/窗口/剪贴板走常驻 PowerShell 助手（SendInput）。
 *
 * 授权模型：启用插件即授权（用户在设置里开启本插件=同意 agent 控机），
 * 工具不再逐次走审批；不需要时在插件页停用即可。
 * 环境缺失（CLI / 测试 / 非 Desktop）时不注册任何工具，镜像 browser_* 行为。
 */
import type { ToolResult } from "../../../agent/types.js";
import type { PluginAPI, PluginFactory } from "../../types.js";

// ---------------------------------------------------------------------------
// 桥客户端（仿 src/agent/browser-host.ts）
// ---------------------------------------------------------------------------

export type ComputerCommand =
  | { op: "screenshot"; display?: number }
  | { op: "move"; x: number; y: number }
  | { op: "click"; x: number; y: number; button?: string; clicks?: number }
  | { op: "drag"; fromX: number; fromY: number; toX: number; toY: number; button?: string }
  | { op: "scroll"; direction: string; amount?: number; x?: number; y?: number }
  | { op: "key"; key: string }
  | { op: "type"; text: string }
  | { op: "windows" }
  | { op: "activate"; hwnd: number }
  | { op: "clipboard_get" }
  | { op: "clipboard_set"; text: string }
  | { op: "status" };

export type ComputerHostResult = {
  ok: boolean;
  error?: string;
  /** 截图（base64，不含 data: 前缀） */
  screenshotBase64?: string;
  mimeType?: string;
  /** 截图像素尺寸（模型坐标空间） */
  screenshotWidth?: number;
  screenshotHeight?: number;
  /** 截屏显示器的物理分辨率（坐标换算目标空间） */
  physicalWidth?: number;
  physicalHeight?: number;
  /** 截屏显示器的物理坐标原点（主屏 = 0,0） */
  originX?: number;
  originY?: number;
  scaleFactor?: number;
  displayIndex?: number;
  displayCount?: number;
  windows?: Array<{ hwnd: number; title: string; process: string }>;
  activated?: boolean;
  text?: string;
  displays?: Array<{ index: number; primary: boolean; width: number; height: number; scaleFactor: number }>;
};

export interface ComputerHostClient {
  execute(command: ComputerCommand, signal?: AbortSignal): Promise<ComputerHostResult>;
}

const DEFAULT_TIMEOUT_MS = 25_000;

export function createHttpComputerHostClient(options: {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}): ComputerHostClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execute = async (
    command: ComputerCommand,
    signal?: AbortSignal,
  ): Promise<ComputerHostResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
      };
      if (options.token) {
        headers["x-meow-computer-token"] = options.token;
      }
      const response = await fetch(new URL("/computer/command", options.baseUrl).toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(command),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: ComputerHostResult | undefined;
      try {
        parsed = text ? (JSON.parse(text) as ComputerHostResult) : undefined;
      } catch {
        parsed = undefined;
      }
      if (!response.ok) {
        return {
          ok: false,
          error: parsed?.error || `Computer host HTTP ${response.status}: ${text.slice(0, 200)}`,
        };
      }
      if (!parsed) {
        return { ok: false, error: "Computer host returned invalid JSON" };
      }
      return parsed;
    } catch (error) {
      if (signal?.aborted) {
        return { ok: false, error: "aborted" };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Computer host request failed: ${message}` };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
  return { execute };
}

/** Resolve the Desktop-injected computer host from environment (127.0.0.1 / localhost only). */
export function createComputerHostFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ComputerHostClient | undefined {
  const baseUrl = env.MEOWCODE_COMPUTER_HOST?.trim();
  if (!baseUrl) {
    return undefined;
  }
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return createHttpComputerHostClient({
    baseUrl: baseUrl.replace(/\/$/, ""),
    token: env.MEOWCODE_COMPUTER_HOST_TOKEN?.trim() || undefined,
  });
}

// ---------------------------------------------------------------------------
// 工具装配
// ---------------------------------------------------------------------------

/** 最近一次截图的元信息：模型坐标（截图像素）→ 物理坐标的换算依据 */
type ShotMeta = {
  screenshotWidth: number;
  screenshotHeight: number;
  physicalWidth: number;
  physicalHeight: number;
  originX: number;
  originY: number;
};

function fail(output: string): ToolResult {
  return { output, ok: false };
}

export const computerControlPlugin: PluginFactory = (api: PluginAPI): void => {
  const host = createComputerHostFromEnv();
  // 无 Desktop 桥（CLI / 测试）：不注册工具，与 browser_* 的降级行为一致
  if (!host) return;

  const log = (message: string) => api.logger.info(`[computer-control] ${message}`);
  let lastShot: ShotMeta | null = null;

  /** 桥调用统一入口（超时由客户端实现控制） */
  const run = async (
    command: ComputerCommand,
    ctx: { signal?: AbortSignal },
  ): Promise<ComputerHostResult> => host.execute(command, ctx.signal);

  /** 模型坐标（最近一次截图的像素空间）→ 物理坐标（显示器原点 + 物理分辨率换算）；未截屏返回 null */
  const toPhysical = (x: number, y: number): { x: number; y: number } | null => {
    if (!lastShot || !lastShot.screenshotWidth || !lastShot.screenshotHeight) {
      return null;
    }
    return {
      x: lastShot.originX + Math.round((x * lastShot.physicalWidth) / lastShot.screenshotWidth),
      y: lastShot.originY + Math.round((y * lastShot.physicalHeight) / lastShot.screenshotHeight),
    };
  };

  const NEED_SHOT = "尚未截屏：请先调用 computer_screenshot，坐标以最近一次截图的像素空间为准";

  const num = (value: unknown, name: string): number => {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) throw new Error(`参数 ${name} 必须是数字`);
    return n;
  };

  api.registerTool({
    name: "computer_screenshot",
    description:
      "Take a screenshot of a display and return it as an image. ALWAYS take a screenshot first before using " +
      "any coordinate-based computer tool (computer_click / computer_scroll / computer_drag), because their x/y " +
      "are interpreted in the pixel space of the MOST RECENT screenshot. Take another screenshot after each " +
      "action to verify the result before continuing. On multi-monitor setups use `display` (0-based index, " +
      "default = primary display) to capture a specific screen.",
    parameters: {
      type: "object",
      properties: {
        display: {
          type: "number",
          description: "0-based display index (default: primary display). Use computer_screenshot on each display when unsure which one you need.",
        },
      },
      additionalProperties: false,
    },
    execute: async (input, ctx) => {
      const display = input.display === undefined ? undefined : num(input.display, "display");
      const result = await run({ op: "screenshot", ...(display !== undefined ? { display } : {}) }, ctx);
      if (!result.ok || !result.screenshotBase64) {
        return fail(result.error || "截屏失败");
      }
      lastShot = {
        screenshotWidth: result.screenshotWidth ?? 0,
        screenshotHeight: result.screenshotHeight ?? 0,
        physicalWidth: result.physicalWidth ?? 0,
        physicalHeight: result.physicalHeight ?? 0,
        originX: result.originX ?? 0,
        originY: result.originY ?? 0,
      };
      return {
        ok: true,
        output:
          `已截取显示器 ${result.displayIndex ?? 0}（共 ${result.displayCount ?? 1} 台）。` +
          `截图 ${result.screenshotWidth}×${result.screenshotHeight} 像素，对应物理分辨率 ${result.physicalWidth}×${result.physicalHeight}。` +
          "后续 computer_click / computer_scroll / computer_drag 的坐标以这张截图的像素坐标为准。",
        images: [{ data: result.screenshotBase64, mimeType: result.mimeType || "image/jpeg" }],
      };
    },
  });

  api.registerTool({
    name: "computer_click",
    description:
      "Move the mouse to (x, y) and click. x/y are in the pixel space of the MOST RECENT computer_screenshot " +
      "(not physical screen pixels). Prefer clicking visible UI targets; after clicking, take a screenshot to " +
      "verify. Note: windows running as Administrator ignore synthesized input from non-elevated apps (UIPI).",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "X in the last screenshot's pixel space" },
        y: { type: "number", description: "Y in the last screenshot's pixel space" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "default: left" },
        clicks: { type: "number", enum: [1, 2, 3], description: "1=single (default), 2=double, 3=triple" },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    execute: async (input, ctx) => {
      const x = num(input.x, "x");
      const y = num(input.y, "y");
      const button = input.button === "right" || input.button === "middle" ? input.button : "left";
      const clicks = input.clicks === 2 || input.clicks === 3 ? input.clicks : 1;
      const physical = toPhysical(x, y);
      if (!physical) return fail(NEED_SHOT);
      const result = await run({ op: "click", x: physical.x, y: physical.y, button, clicks }, ctx);
      if (!result.ok) return fail(result.error || "点击失败");
      const action = clicks === 2 ? "双击" : clicks === 3 ? "三连击" : "单击";
      return { ok: true, output: `已在截图坐标 (${x}, ${y}) ${action}（物理 ${physical.x}, ${physical.y}）。建议截屏确认结果。` };
    },
  });

  api.registerTool({
    name: "computer_type",
    description:
      "Type text into the currently focused input field (the text is pasted via the clipboard). Click the target " +
      "field first with computer_click, then call this. Newlines in the text are preserved. The user's clipboard " +
      "text content is replaced temporarily and restored afterwards (best effort).",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type into the focused control" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (input, ctx) => {
      const text = typeof input.text === "string" ? input.text : "";
      if (!text.trim()) return fail("text 不能为空");
      const result = await run({ op: "type", text }, ctx);
      if (!result.ok) return fail(result.error || "输入失败");
      const head = text.length > 40 ? `${text.slice(0, 40)}…（共 ${text.length} 字符）` : text;
      return { ok: true, output: `已向当前焦点控件输入文本：${JSON.stringify(head)}。建议截屏确认结果。` };
    },
  });

  api.registerTool({
    name: "computer_key",
    description:
      "Press a key or key combination, e.g. 'Return', 'ctrl+c', 'ctrl+shift+t', 'alt+F4', 'win', 'pagedown'. " +
      "Use for shortcuts and special keys; for typing text use computer_type instead.",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            "Key combo separated by '+'. Supported names: a-z, 0-9, f1-f12, return/enter, tab, escape, backspace, delete, insert, home, end, pageup, pagedown, up/down/left/right, space, ctrl, alt, shift, win, capslock, printscreen, menu, minus, equal, comma, period, slash, backslash, semicolon, quote, bracketleft, bracketright, grave",
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
    execute: async (input, ctx) => {
      const key = typeof input.key === "string" ? input.key.trim() : "";
      if (!key) return fail("key 不能为空");
      const result = await run({ op: "key", key }, ctx);
      if (!result.ok) return fail(result.error || "按键失败");
      return { ok: true, output: `已按下 ${key}。建议截屏确认结果。` };
    },
  });

  api.registerTool({
    name: "computer_scroll",
    description:
      "Scroll the window under the cursor (or at x/y if provided). direction: up/down/left/right; amount: number " +
      "of wheel notches (1 notch ≈ 3 lines). x/y are in the last screenshot's pixel space.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "wheel notches, 1-30, default 3" },
        x: { type: "number", description: "optional: scroll position X in the last screenshot's pixel space" },
        y: { type: "number", description: "optional: scroll position Y in the last screenshot's pixel space" },
      },
      required: ["direction"],
      additionalProperties: false,
    },
    execute: async (input, ctx) => {
      const direction = typeof input.direction === "string" ? input.direction : "";
      if (!["up", "down", "left", "right"].includes(direction)) return fail("direction 必须是 up/down/left/right");
      const amount = input.amount === undefined ? 3 : Math.max(1, Math.min(30, num(input.amount, "amount")));
      const payload: ComputerCommand = { op: "scroll", direction, amount };
      if (input.x !== undefined || input.y !== undefined) {
        const physical = toPhysical(num(input.x, "x"), num(input.y, "y"));
        if (!physical) return fail(NEED_SHOT);
        payload.x = physical.x;
        payload.y = physical.y;
      }
      const result = await run(payload, ctx);
      if (!result.ok) return fail(result.error || "滚动失败");
      return { ok: true, output: `已向${direction}滚动 ${amount} 格。建议截屏确认结果。` };
    },
  });

  api.registerTool({
    name: "computer_drag",
    description:
      "Press the mouse button at (fromX, fromY), move interpolated to (toX, toY), release. Coordinates are in the " +
      "last screenshot's pixel space. Use for sliders, selection rectangles, moving items.",
    parameters: {
      type: "object",
      properties: {
        fromX: { type: "number" },
        fromY: { type: "number" },
        toX: { type: "number" },
        toY: { type: "number" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "default: left" },
      },
      required: ["fromX", "fromY", "toX", "toY"],
      additionalProperties: false,
    },
    execute: async (input, ctx) => {
      const from = toPhysical(num(input.fromX, "fromX"), num(input.fromY, "fromY"));
      const to = toPhysical(num(input.toX, "toX"), num(input.toY, "toY"));
      if (!from || !to) return fail(NEED_SHOT);
      const button = input.button === "right" || input.button === "middle" ? input.button : "left";
      const result = await run(
        { op: "drag", fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, button },
        ctx,
      );
      if (!result.ok) return fail(result.error || "拖拽失败");
      return {
        ok: true,
        output: `已从截图坐标 (${input.fromX}, ${input.fromY}) 拖拽到 (${input.toX}, ${input.toY})。建议截屏确认结果。`,
      };
    },
  });

  api.registerTool({
    name: "computer_window_list",
    description: "List visible top-level windows (hwnd, title, process name), roughly in z-order. Use a hwnd with computer_window_activate to bring one to the front.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_input, ctx) => {
      const result = await run({ op: "windows" }, ctx);
      if (!result.ok) return fail(result.error || "窗口列举失败");
      const windows = result.windows ?? [];
      if (!windows.length) return { ok: true, output: "当前没有可见的有标题窗口" };
      const lines = windows.map(
        (w) => `[${w.hwnd}] ${w.title}${w.process ? ` — ${w.process}` : ""}`,
      );
      return { ok: true, output: `可见窗口 ${windows.length} 个：\n${lines.join("\n")}` };
    },
  });

  api.registerTool({
    name: "computer_window_activate",
    description: "Bring a window to the front by its hwnd (from computer_window_list). Best effort: some windows may refuse focus.",
    parameters: {
      type: "object",
      properties: {
        hwnd: { type: "number", description: "window handle from computer_window_list" },
      },
      required: ["hwnd"],
      additionalProperties: false,
    },
    execute: async (input, ctx) => {
      const hwnd = num(input.hwnd, "hwnd");
      const result = await run({ op: "activate", hwnd }, ctx);
      if (!result.ok) return fail(result.error || "激活窗口失败");
      return {
        ok: true,
        output: result.activated ? `已激活窗口 ${hwnd}。` : `已尝试激活窗口 ${hwnd}（系统可能拒绝了前台切换）。`,
      };
    },
  });

  api.registerTool({
    name: "computer_clipboard",
    description: "Read or write the text clipboard. action=read returns the current text; action=write replaces it with `text`.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write"] },
        text: { type: "string", description: "text to put on the clipboard (action=write only)" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (input, ctx) => {
      const action = input.action === "write" ? "write" : "read";
      if (action === "write") {
        const text = typeof input.text === "string" ? input.text : "";
        if (!text) return fail("write 需要非空 text");
        const result = await run({ op: "clipboard_set", text }, ctx);
        if (!result.ok) return fail(result.error || "写入剪贴板失败");
        return { ok: true, output: `已写入剪贴板（${text.length} 字符）。` };
      }
      const result = await run({ op: "clipboard_get" }, ctx);
      if (!result.ok) return fail(result.error || "读取剪贴板失败");
      const text = result.text ?? "";
      if (!text) return { ok: true, output: "剪贴板当前没有文本内容。" };
      const clipped = text.length > 8000 ? `${text.slice(0, 8000)}\n…（已截断，共 ${text.length} 字符）` : text;
      return { ok: true, output: `剪贴板内容：\n${clipped}` };
    },
  });

  api.registerTool({
    name: "computer_wait",
    description: "Wait for a short time (e.g. an app to finish launching) before the next screenshot. Max 10 seconds.",
    parameters: {
      type: "object",
      properties: {
        ms: { type: "number", description: "milliseconds, 100-10000" },
      },
      required: ["ms"],
      additionalProperties: false,
    },
    execute: async (input, ctx) => {
      const ms = Math.max(100, Math.min(10_000, num(input.ms, "ms")));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, ms);
        const onAbort = () => {
          cleanup();
          reject(new Error("aborted"));
        };
        const cleanup = () => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener("abort", onAbort);
        };
        ctx.signal?.addEventListener("abort", onAbort, { once: true });
      }).catch(() => undefined);
      return { ok: true, output: `已等待 ${ms}ms。` };
    },
  });

  // 斜杠命令：/computer 展开「电脑控制」引导 prompt（服务端 commandIndex.resolve 调 run），
  // 模型收到后按约定流程走 computer_* 工具
  api.registerCommand({
    name: "computer",
    description: "电脑控制：让 agent 截屏查看屏幕并操作鼠标键盘（先在插件页启用）",
    run: (args) => {
      const task = args.trim();
      return [
        "[电脑控制] 用户要求你在电脑上执行操作。请严格按以下流程工作：",
        "1. 先用 computer_screenshot 截屏查看当前屏幕；",
        "2. 用 computer_click / computer_type / computer_key / computer_scroll / computer_drag 执行操作——这些工具的坐标以最近一次截图的像素空间为准；",
        "3. 每个动作后再次截屏确认结果，再决定下一步；",
        "4. 需要切换窗口用 computer_window_list + computer_window_activate；需要读写剪贴板用 computer_clipboard。",
        task ? `\n用户指令：${task}` : "\n用户的具体需求见对话上下文。",
      ].join("\n");
    },
  });

  log("computer control tools registered");
};

export default computerControlPlugin;
