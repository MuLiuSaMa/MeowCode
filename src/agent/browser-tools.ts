import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserHostClient, BrowserHostCommand } from "./browser-host.js";
import { truncateOutput } from "./tools.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * 内嵌浏览器工具：由 agent 驱动桌面端「浏览器」页签做页面验证。
 * 仅当桌面端注入了 browser host（env）时才注册给模型；浏览器操作不进审批。
 */

const SCREENSHOT_DIR = path.join(os.tmpdir(), "meowcode-screenshots");

export const browserToolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description:
        "Open a URL in the agent's own browser (a hidden window with a fixed 1280x900 viewport) and wait for it to load. Use it to preview local dev servers, read documentation, or verify a page visually. Only http(s) URLs or about:blank are allowed. Nothing opens in the app UI; call browser_screenshot to see the page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL, for example http://localhost:4173/" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_snapshot",
      description:
        "Read the current browser page: URL, title, and visible interactive elements with refs (e1, e2, ...). Call this before browser_click or browser_type, and again after a navigation or page change.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description:
        "Click an interactive element on the current page by its snapshot ref. Re-snapshot first if the page changed.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref from browser_snapshot, for example e3." },
        },
        required: ["ref"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description:
        "Type text into an input, textarea, or contenteditable element identified by a snapshot ref (or the focused element when ref is omitted). Set submit=true to press Enter afterwards.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to enter." },
          ref: { type: "string", description: "Optional element ref from browser_snapshot." },
          submit: { type: "boolean", description: "Press Enter after typing (default false)." },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description:
        "Capture the visible browser page as a PNG and show it to the user in the conversation. " +
        "After a UI change, open the page and take one screenshot so the user can see the result; " +
        "do not take screenshots repeatedly just to check your own work.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_back",
      description: "Go back in the browser history.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_reload",
      description: "Reload the current browser page.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_preview",
      description:
        "Render a page in the agent's own hidden browser (fixed 1280x900 viewport) to check page styles and design mockups. " +
        "Pass html with the whole page source: it is written to a temp folder outside the workspace and cleaned up automatically, " +
        "so never create scratch HTML files in the repository. Pass path instead to open an HTML file that already exists in the " +
        "workspace (its relative css/js/images load too). Nothing opens in the app UI: call browser_screenshot to show the user the " +
        "result, browser_reload after a change, and never screenshot the desktop window to show page styling.",
      parameters: {
        type: "object",
        properties: {
          html: {
            type: "string",
            description: "Full HTML source of the page (self-contained, inline CSS/JS). Stored in a temp folder, not the repo.",
          },
          path: {
            type: "string",
            description: "Workspace-relative path of an existing HTML file to open, for example dist/index.html",
          },
          name: {
            type: "string",
            description: "Optional short name for the temp file, for example pricing-page",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
];

const BROWSER_TOOL_NAMES = new Set(browserToolDefinitions.map((definition) => definition.function.name));

export function isBrowserTool(name: string): boolean {
  return BROWSER_TOOL_NAMES.has(name);
}

function pageFooter(result: { url?: string; title?: string }): string {
  const lines: string[] = [];
  if (result.url) lines.push(`url: ${result.url}`);
  if (result.title) lines.push(`title: ${result.title}`);
  return lines.join("\n");
}

async function saveScreenshot(base64: string): Promise<string> {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `shot-${Date.now()}.png`);
  await fs.writeFile(file, Buffer.from(base64, "base64"));
  return file;
}

export async function executeBrowserTool(
  name: string,
  input: unknown,
  host: BrowserHostClient,
  options: { keepImages: boolean },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const args = (input ?? {}) as Record<string, unknown>;
  let command: BrowserHostCommand;
  switch (name) {
    case "browser_navigate":
      command = { op: "navigate", url: String(args.url ?? "").trim() };
      break;
    case "browser_preview": {
      const html = typeof args.html === "string" ? args.html : "";
      const previewPath = String(args.path ?? "").trim();
      if (!html.trim() && !previewPath) {
        return { ok: false, output: "Browser error: browser_preview needs html or path." };
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      command = {
        op: "preview",
        ...(html.trim() ? { html } : { path: previewPath }),
        ...(name ? { name } : {}),
      };
      break;
    }
    case "browser_snapshot":
      command = { op: "snapshot" };
      break;
    case "browser_click":
      command = { op: "click", ref: String(args.ref ?? "").trim() };
      break;
    case "browser_type":
      command = {
        op: "type",
        text: String(args.text ?? ""),
        ...(typeof args.ref === "string" && args.ref.trim() ? { ref: args.ref.trim() } : {}),
        ...(args.submit === true ? { submit: true } : {}),
      };
      break;
    case "browser_screenshot":
      command = { op: "screenshot" };
      break;
    case "browser_back":
      command = { op: "back" };
      break;
    case "browser_reload":
      command = { op: "reload" };
      break;
    default:
      return { ok: false, output: `Unknown browser tool: ${name}` };
  }

  const result = await host.execute(command, signal);
  if (!result.ok) {
    return { ok: false, output: `Browser error: ${result.error || "unknown error"}` };
  }

  switch (name) {
    case "browser_navigate": {
      const text = [`Opened page.`, pageFooter(result)].filter(Boolean).join("\n");
      return { ok: true, output: truncateOutput(text).output };
    }
    case "browser_preview": {
      const text = [
        "Opened page.",
        result.preview ? `preview: ${result.preview}` : "",
        pageFooter(result),
        "Call browser_screenshot to show this page to the user.",
      ].filter(Boolean).join("\n");
      return { ok: true, output: truncateOutput(text).output };
    }
    case "browser_snapshot": {
      return { ok: true, output: truncateOutput(result.snapshot || "(empty snapshot)").output };
    }
    case "browser_click": {
      const text = [
        `Clicked ${result.clicked ?? String(args.ref ?? "")}${result.trusted === false ? " (fallback click, non-trusted input)" : ""}.`,
        pageFooter(result),
      ].filter(Boolean).join("\n");
      return { ok: true, output: truncateOutput(text).output };
    }
    case "browser_type": {
      const text = [
        `Typed ${JSON.stringify(result.typed ?? String(args.text ?? ""))}${result.submitted ? " and pressed Enter" : ""}.`,
        pageFooter(result),
      ].filter(Boolean).join("\n");
      return { ok: true, output: truncateOutput(text).output };
    }
    case "browser_screenshot": {
      if (!result.screenshotBase64) {
        return { ok: false, output: "浏览器未返回截图数据" };
      }
      const mimeType = result.mimeType || "image/png";
      const meta = [
        `Screenshot captured (${result.viewportWidth ?? "?"}x${result.viewportHeight ?? "?"}).`,
        pageFooter(result),
      ].filter(Boolean).join("\n");
      // 图永远交给运行时：工具行会直接展示给用户；是否回传给模型由 keepImages 决定。
      const images = [{ data: result.screenshotBase64, mimeType }];
      if (options.keepImages) {
        return {
          ok: true,
          output: `${meta}\nThe screenshot is attached as an image.`,
          images,
        };
      }
      // 纯文本模型看不到图：额外落一份临时文件，让它能引用路径；图仍会展示给用户
      const file = await saveScreenshot(result.screenshotBase64).catch(() => null);
      return {
        ok: true,
        output: file
          ? `${meta}\nThe active model does not accept image input, so the screenshot was saved to:\n${file}`
          : `${meta}\nThe active model does not accept image input.`,
        images,
      };
    }
    default: {
      const text = [`Done.`, pageFooter(result)].filter(Boolean).join("\n");
      return { ok: true, output: truncateOutput(text).output };
    }
  }
}
