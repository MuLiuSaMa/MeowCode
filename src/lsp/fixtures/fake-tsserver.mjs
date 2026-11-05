// Minimal tsserver fixture: newline-delimited input, Content-Length output.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const open = new Map();

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function respond(seq, body) {
  send({ seq: 0, type: "response", request_seq: seq, success: true, body });
}

function readContent(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return open.get(file) ?? "";
  }
}

function diagnosticsFor(file) {
  const content = readContent(file);
  if (!content.includes("BAD")) return [];
  return [
    {
      start: { line: 2, offset: 3 },
      end: { line: 2, offset: 6 },
      text: "Type 'string' is not assignable to type 'number'.",
      code: 2322,
      category: "error",
      source: "typescript",
      fileName: file,
    },
  ];
}

function handle(message) {
  if (!message || typeof message !== "object") return;
  if (message.type !== "request") return;
  const args = message.arguments ?? {};
  switch (message.command) {
    case "open":
      open.set(args.file, args.fileContent ?? "");
      respond(message.seq, {});
      return;
    case "reload":
      open.set(args.file, readContent(args.file));
      respond(message.seq, {});
      return;
    case "semanticDiagnosticsSync":
      respond(message.seq, diagnosticsFor(args.file));
      return;
    case "syntacticDiagnosticsSync":
      respond(message.seq, []);
      return;
    case "exit":
      process.exit(0);
      return;
    default:
      respond(message.seq, {});
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {
    // ignore malformed fixture input
  }
});
