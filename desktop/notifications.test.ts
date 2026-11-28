import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type Labels = {
  turnDone: string;
  turnAborted: string;
  turnError: string;
  approval: string;
  ask: string;
};

type NotificationsModule = {
  PREVIEW_MAX: number;
  TURN_DEDUPE_MS: number;
  summarize: (text: unknown, max?: number) => string;
  describeTurn: (input: {
    status?: string;
    preview?: string | null;
    labels: Labels;
  }) => string;
  describeApproval: (input: {
    tool?: string;
    command?: string;
    input?: Record<string, unknown>;
    labels: Labels;
  }) => string;
  describeAsk: (input: {
    questions?: Array<{ question: string; options: string[] }>;
    labels: Labels;
  }) => string;
  shouldNotify: (input: { enabled?: boolean; supported?: boolean }) => boolean;
  notificationTitle: (title: string | null | undefined, untitled: string) => string;
  createDedupe: (options?: {
    windowMs?: number;
    now?: () => number;
    limit?: number;
  }) => { accept: (key: string) => boolean; release: (key: string) => void; size: () => number };
  escapeXml: (value: unknown) => string;
  notificationTag: (sessionId: string) => string;
  buildReplyToastXml: (input: {
    title: string;
    body: string;
    iconUrl?: string;
    tag: string;
    sessionId: string;
    placeholder: string;
    sendLabel: string;
  }) => string;
  parseActivationArgs: (raw: unknown) => Record<string, string>;
  pickReplyText: (details: unknown) => string;
  createReplyRoutes: (options?: {
    ttlMs?: number;
    limit?: number;
    now?: () => number;
  }) => { remember: (tag: string, sessionId: string) => void; resolve: (tag: string) => string | null; size: () => number };
};

const requireCjs = createRequire(import.meta.url);
const {
  PREVIEW_MAX,
  summarize,
  describeTurn,
  describeApproval,
  describeAsk,
  shouldNotify,
  notificationTitle,
  createDedupe,
  escapeXml,
  notificationTag,
  buildReplyToastXml,
  parseActivationArgs,
  pickReplyText,
  createReplyRoutes,
} = requireCjs("./notifications.cjs") as NotificationsModule;

const LABELS: Labels = {
  turnDone: "回合已完成，等待你的输入",
  turnAborted: "回合已被中断",
  turnError: "回合执行出错",
  approval: "需要你确认",
  ask: "需要你回答",
};

describe("summarize", () => {
  it("flattens whitespace so the toast stays one paragraph", () => {
    expect(summarize("第一行\n\n第二行   带   空格")).toBe("第一行 第二行 带 空格");
  });

  it("returns an empty string for blank input", () => {
    expect(summarize(undefined)).toBe("");
    expect(summarize("   \n\t ")).toBe("");
  });

  it("clips long text with an ellipsis", () => {
    const long = "字".repeat(PREVIEW_MAX + 30);
    const clipped = summarize(long);
    expect(clipped).toBe(`${"字".repeat(PREVIEW_MAX)}…`);
    expect(summarize("短文本")).toBe("短文本");
  });
});

describe("describeTurn", () => {
  it("prefers the reply summary", () => {
    expect(describeTurn({ status: "completed", preview: "改好了，测试全绿。", labels: LABELS })).toBe(
      "改好了，测试全绿。",
    );
  });

  it("falls back to the status text when there is no reply text", () => {
    expect(describeTurn({ status: "completed", preview: "", labels: LABELS })).toBe(LABELS.turnDone);
    expect(describeTurn({ status: "aborted", preview: "  ", labels: LABELS })).toBe(
      LABELS.turnAborted,
    );
    expect(describeTurn({ status: "error", preview: null, labels: LABELS })).toBe(LABELS.turnError);
  });

  it("treats an unknown status as a normal completion", () => {
    expect(describeTurn({ status: undefined, preview: "", labels: LABELS })).toBe(LABELS.turnDone);
  });
});

describe("describeApproval", () => {
  it("puts the tool name and its command on one line", () => {
    expect(
      describeApproval({ tool: "run_command", command: "npm test", labels: LABELS }),
    ).toBe("需要你确认：run_command · npm test");
  });

  it("falls back to a path or the first readable input value", () => {
    expect(
      describeApproval({ tool: "edit_file", input: { file_path: "src/a.ts" }, labels: LABELS }),
    ).toBe("需要你确认：edit_file · src/a.ts");
    expect(
      describeApproval({ tool: "write_file", input: { content: "hello world" }, labels: LABELS }),
    ).toBe("需要你确认：write_file · hello world");
  });

  it("still works when only the tool name is known", () => {
    expect(describeApproval({ tool: "browser_screenshot", labels: LABELS })).toBe(
      "需要你确认：browser_screenshot",
    );
  });

  it("clips a runaway multi-line command", () => {
    const body = describeApproval({
      tool: "run_command",
      command: `echo ${"x".repeat(200)}\nrm -rf /tmp`,
      labels: LABELS,
    });
    expect(body.length).toBeLessThanOrEqual(PREVIEW_MAX + 1);
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("describeAsk", () => {
  it("shows the first question", () => {
    expect(
      describeAsk({
        questions: [{ question: "要覆盖还是新建文件？", options: ["覆盖", "新建"] }],
        labels: LABELS,
      }),
    ).toBe("需要你回答：要覆盖还是新建文件？");
  });

  it("marks the remaining questions when there are several", () => {
    expect(
      describeAsk({
        questions: [
          { question: "先做哪个模块？", options: ["A", "B"] },
          { question: "要不要跑测试？", options: ["要"] },
        ],
        labels: LABELS,
      }),
    ).toBe("需要你回答：先做哪个模块？ +1");
  });

  it("falls back to the label when questions are missing", () => {
    expect(describeAsk({ questions: [], labels: LABELS })).toBe(LABELS.ask);
    expect(describeAsk({ labels: LABELS })).toBe(LABELS.ask);
  });
});

describe("shouldNotify", () => {  it("only needs the switch to be on and the platform to support it", () => {
    expect(shouldNotify({ enabled: true, supported: true })).toBe(true);
    expect(shouldNotify({ enabled: undefined, supported: true })).toBe(true);
    expect(shouldNotify({ enabled: false, supported: true })).toBe(false);
    expect(shouldNotify({ enabled: true, supported: false })).toBe(false);
  });
});

describe("notificationTitle", () => {
  it("falls back to the untitled string", () => {
    expect(notificationTitle("修复托盘菜单", "未命名会话")).toBe("修复托盘菜单");
    expect(notificationTitle("  ", "未命名会话")).toBe("未命名会话");
    expect(notificationTitle(null, "")).toBe("MeowCode");
  });
});

describe("createDedupe", () => {
  it("blocks a key until it is released when no window is set", () => {
    const dedupe = createDedupe();
    expect(dedupe.accept("call-1")).toBe(true);
    expect(dedupe.accept("call-1")).toBe(false);
    dedupe.release("call-1");
    expect(dedupe.accept("call-1")).toBe(true);
  });

  it("allows the same key again after the time window", () => {
    let now = 1000;
    const dedupe = createDedupe({ windowMs: 3000, now: () => now });
    expect(dedupe.accept("s1")).toBe(true);
    now = 2000;
    expect(dedupe.accept("s1")).toBe(false);
    now = 4500;
    expect(dedupe.accept("s1")).toBe(true);
  });

  it("always accepts an empty key and never grows past its limit", () => {
    const dedupe = createDedupe({ limit: 3 });
    expect(dedupe.accept("")).toBe(true);
    for (const key of ["a", "b", "c", "d", "e"]) dedupe.accept(key);
    expect(dedupe.size()).toBe(3);
    // 最旧的 a/b 已被淘汰，重新出现时算新请求
    expect(dedupe.accept("a")).toBe(true);
    expect(dedupe.accept("e")).toBe(false);
  });
});

describe("escapeXml", () => {
  it("escapes markup so session text stays plain", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
    expect(escapeXml(null)).toBe("");
  });
});

describe("notificationTag", () => {
  it("is stable, short, and distinct per session", () => {
    const a = notificationTag("0f2c6a1e-1111-4a2b-9c3d-000000000001");
    const b = notificationTag("0f2c6a1e-1111-4a2b-9c3d-000000000002");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(notificationTag("0f2c6a1e-1111-4a2b-9c3d-000000000001")).toBe(a);
    expect(a).not.toBe(b);
    expect(notificationTag("")).toBe("");
  });
});

describe("buildReplyToastXml", () => {
  it("includes a reply input and send action wired to the session", () => {
    const xml = buildReplyToastXml({
      title: "MeowCode · 会话",
      body: "回合已完成",
      iconUrl: "file:///C:/icon.png",
      tag: "abc123",
      sessionId: "sid-1",
      placeholder: "回复…",
      sendLabel: "发送",
    });
    expect(xml.startsWith("<toast ")).toBe(true);
    expect(xml).not.toContain("<?xml");
    // 带输入框的 toast 要留足打字时间
    expect(xml).toContain(`duration="long"`);
    expect(xml).toContain(`<input id="reply" type="text" placeHolderContent="回复…"/>`);
    expect(xml).toContain(`arguments="type=reply&amp;tag=abc123&amp;sid=sid-1"`);
    expect(xml).toContain(`launch="type=click&amp;tag=abc123&amp;sid=sid-1"`);
    expect(xml).toContain(`hintInputId="reply"`);
    expect(xml).toContain(`content="发送"`);
  });

  it("escapes session-derived text and omits a missing icon", () => {
    const xml = buildReplyToastXml({
      title: "<b>t</b>",
      body: "a & b",
      tag: "t1",
      sessionId: "s1",
      placeholder: `"p"`,
      sendLabel: "Send",
    });
    expect(xml).toContain("<text>&lt;b&gt;t&lt;/b&gt;</text>");
    expect(xml).toContain("<text>a &amp; b</text>");
    expect(xml).not.toContain("<image");
  });
});

describe("parseActivationArgs", () => {
  it("splits key=value pairs and ignores malformed tokens", () => {
    expect(parseActivationArgs("type=reply&tag=abc&sid=s-1")).toEqual({
      type: "reply",
      tag: "abc",
      sid: "s-1",
    });
    expect(parseActivationArgs("noequals&&=empty")).toEqual({});
    expect(parseActivationArgs(null)).toEqual({});
  });
});

describe("createReplyRoutes", () => {
  it("reads the reply text from either field and ignores non-reply activations", () => {
    expect(pickReplyText({ type: "reply", reply: "hi" })).toBe("hi");
    expect(pickReplyText({ type: "click", userInputs: { reply: "typed" } })).toBe("typed");
    expect(pickReplyText({ type: "reply", reply: "", userInputs: { reply: "fallback" } })).toBe(
      "fallback",
    );
    expect(pickReplyText({ type: "click", arguments: "type=click&tag=a" })).toBe("");
    expect(pickReplyText(null)).toBe("");
  });

  it("resolves a remembered tag and drops expired routes", () => {
    let now = 1000;
    const routes = createReplyRoutes({ ttlMs: 500, now: () => now });
    routes.remember("tag-1", "session-1");
    expect(routes.resolve("tag-1")).toBe("session-1");
    now = 1600;
    expect(routes.resolve("tag-1")).toBeNull();
    expect(routes.resolve("")).toBeNull();
  });

  it("keeps the newest routes within the limit", () => {
    const routes = createReplyRoutes({ limit: 2 });
    routes.remember("a", "s-a");
    routes.remember("b", "s-b");
    routes.remember("c", "s-c");
    expect(routes.size()).toBe(2);
    expect(routes.resolve("a")).toBeNull();
    expect(routes.resolve("c")).toBe("s-c");
  });
});
