import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const requireFromDesktop = createRequire(new URL("../desktop/package.json", import.meta.url));
const electronPath = requireFromDesktop("electron");
const args = process.argv.slice(2);
if (args.length === 0) args.push(".");

const child = spawn(electronPath, args, { stdio: ["inherit", "inherit", "pipe"] });

// Electron 44 / Chromium 152 启动时会为内置资源打印 39 条该警告，与项目代码无关。
const NOISE = "libpng warning: iCCP: known incorrect sRGB profile";
let buffer = "";
child.stderr.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline + 1);
    buffer = buffer.slice(newline + 1);
    if (line.trim() !== NOISE) process.stderr.write(line);
  }
});

child.on("close", (code, signal) => {
  if (buffer && buffer.trim() !== NOISE) process.stderr.write(buffer);
  process.exitCode = code ?? (signal ? 1 : 0);
});

child.on("error", (error) => {
  process.stderr.write(`dev-electron: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
