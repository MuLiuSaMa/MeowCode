import type { Server } from "node:http";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginAPI, PluginTool } from "../../types.js";
import { computerControlPlugin } from "./index.js";

/** 简化 PluginAPI 桩：只收集 registerTool 的工具 */
function makeApi(): PluginAPI & { tools: PluginTool[] } {
  const tools: PluginTool[] = [];
  return {
    tools,
    registerTool: (tool) => tools.push(tool),
    on: () => {},
    registerCommand: () => {},
    storage: { get: async () => undefined, set: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    workspace: process.cwd(),
  };
}

/**
 * mock 电脑控制桥：校验 token，把收到的命令存进 received，响应用例注入的 responder。
 */
let received: Array<Record<string, unknown>>;
let responder: (command: Record<string, unknown>) => unknown;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.headers["x-meow-computer-token"] !== "test-token") {
        res.writeHead(401).end(JSON.stringify({ ok: false, error: "invalid token" }));
        return;
      }
      const command = JSON.parse(raw || "{}") as Record<string, unknown>;
      received.push(command);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responder(command)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

const ENV_KEYS = ["MEOWCODE_COMPUTER_HOST", "MEOWCODE_COMPUTER_HOST_TOKEN"] as const;

beforeEach(() => {
  received = [];
  responder = () => ({ ok: true });
  process.env.MEOWCODE_COMPUTER_HOST = baseUrl;
  process.env.MEOWCODE_COMPUTER_HOST_TOKEN = "test-token";
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

const SCREENSHOT_RESPONSE = {
  ok: true,
  screenshotBase64: Buffer.from("fakejpeg").toString("base64"),
  mimeType: "image/jpeg",
  screenshotWidth: 640,
  screenshotHeight: 400,
  physicalWidth: 1280,
  physicalHeight: 800,
  originX: 0,
  originY: 0,
  scaleFactor: 2,
  displayIndex: 0,
  displayCount: 1,
};

describe("computer-control 内置插件", () => {
  it("无 env 时不注册任何工具（CLI / 测试降级）", () => {
    delete process.env.MEOWCODE_COMPUTER_HOST;
    const api = makeApi();
    computerControlPlugin(api);
    expect(api.tools).toHaveLength(0);
  });

  it("注册 10 个 computer_* 工具", () => {
    const api = makeApi();
    computerControlPlugin(api);
    const names = api.tools.map((tool) => tool.name);
    expect(names).toEqual([
      "computer_screenshot",
      "computer_click",
      "computer_type",
      "computer_key",
      "computer_scroll",
      "computer_drag",
      "computer_window_list",
      "computer_window_activate",
      "computer_clipboard",
      "computer_wait",
    ]);
  });

  it("截图返回图片并记录坐标空间；click 按截图像素→物理像素换算", async () => {
    const api = makeApi();
    computerControlPlugin(api);
    const byName = new Map(api.tools.map((tool) => [tool.name, tool]));

    responder = () => SCREENSHOT_RESPONSE;
    const shot = await byName.get("computer_screenshot")!.execute({}, { workspace: ".", logger: { info() {}, warn() {}, error() {} } });
    expect(shot.ok).toBe(true);
    expect(shot.images?.[0]).toMatchObject({ mimeType: "image/jpeg" });
    expect(shot.output).toContain("像素坐标为准");
    expect(received[0]).toMatchObject({ op: "screenshot" });

    // 640×400 截图 → 1280×800 物理：模型 (320,200) → 物理 (640,400)
    responder = (command) => ({ ok: true, echo: command });
    const click = await byName.get("computer_click")!.execute({ x: 320, y: 200 }, { workspace: ".", logger: { info() {}, warn() {}, error() {} } });
    expect(click.ok).toBe(true);
    const sent = received[1];
    expect(sent).toMatchObject({ op: "click", x: 640, y: 400, button: "left", clicks: 1 });
    void click;
  });

  it("未截图先用坐标类工具：报错提示先截图", async () => {
    const api = makeApi();
    computerControlPlugin(api);
    const byName = new Map(api.tools.map((tool) => [tool.name, tool]));
    const click = await byName.get("computer_click")!.execute({ x: 10, y: 10 }, { workspace: ".", logger: { info() {}, warn() {}, error() {} } });
    expect(click.ok).toBe(false);
    expect(click.output).toContain("computer_screenshot");
  });

  it("display 参数透传给桥；非视觉字段被剔除", async () => {
    const api = makeApi();
    computerControlPlugin(api);
    const byName = new Map(api.tools.map((tool) => [tool.name, tool]));
    responder = () => SCREENSHOT_RESPONSE;
    await byName.get("computer_screenshot")!.execute({ display: 1 }, { workspace: ".", logger: { info() {}, warn() {}, error() {} } });
    expect(received[0]).toMatchObject({ op: "screenshot", display: 1 });
    // display 缺省时不带 display 字段
    await byName.get("computer_screenshot")!.execute({}, { workspace: ".", logger: { info() {}, warn() {}, error() {} } });
    expect("display" in received[1]).toBe(false);
  });

  it("带副屏原点的坐标换算：origin + 缩放", async () => {
    const api = makeApi();
    computerControlPlugin(api);
    const byName = new Map(api.tools.map((tool) => [tool.name, tool]));
    responder = () => ({ ...SCREENSHOT_RESPONSE, originX: -1080, originY: 100, displayIndex: 1 });
    await byName.get("computer_screenshot")!.execute({ display: 1 }, { workspace: ".", logger: { info() {}, warn() {}, error() {} } });
    responder = (command) => ({ ok: true, echo: command });
    await byName.get("computer_click")!.execute({ x: 320, y: 200 }, { workspace: ".", logger: { info() {}, warn() {}, error() {} } });
    expect(received[1]).toMatchObject({ x: -1080 + 640, y: 100 + 400 });
  });
});
