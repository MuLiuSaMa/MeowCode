export const CANVAS_CAPABILITY_POLICY = Object.freeze({
  version: 1,
  canvasActions: Object.freeze({
    loadScene: false,
    export: false,
    saveAsImage: false,
    saveToActiveFile: false,
    clearCanvas: false,
    toggleTheme: false,
    changeViewBackgroundColor: false
  }),
  agentCommands: Object.freeze([
    "start",
    "stop",
    "status",
    "add",
    "apply",
    "update",
    "delete",
    "get",
    "query",
    "describe",
    "screenshot",
    "export",
    "import",
    "snapshot",
    "arrange"
  ])
});

const ALLOWED_AGENT_COMMANDS = new Set(
  CANVAS_CAPABILITY_POLICY.agentCommands
);

export function assertAllowedCanvasCommand(command) {
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("缺少画板命令");
  }
  if (!ALLOWED_AGENT_COMMANDS.has(command)) {
    throw new Error(`画板命令不允许：${command}`);
  }
  return command;
}
