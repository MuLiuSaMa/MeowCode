// Minimal stdio LSP fixture: initialize + didOpen/didChange -> publishDiagnostics.
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function publish(uri, text, version) {
  const diagnostics = text.includes("BAD")
    ? [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          severity: 1,
          code: "FAKE1",
          source: "fake",
          message: "fake semantic error",
        },
      ]
    : [];
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, version, diagnostics },
  });
}

function handle(message) {
  if (!message || typeof message !== "object") return;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { capabilities: { textDocumentSync: 1 } },
    });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") {
    process.exit(0);
  }
  if (message.method === "textDocument/didOpen") {
    const doc = message.params.textDocument;
    publish(doc.uri, doc.text, doc.version);
    return;
  }
  if (message.method === "textDocument/didChange") {
    const doc = message.params.textDocument;
    const text = message.params.contentChanges?.[0]?.text ?? "";
    publish(doc.uri, text, doc.version);
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: null });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    try {
      handle(JSON.parse(body));
    } catch {
      // ignore malformed fixture input
    }
  }
});
