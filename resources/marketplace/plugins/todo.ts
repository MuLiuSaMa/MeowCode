/**
 * Todo 清单插件（适配自 metis-main examples/extensions/todo.ts）
 *
 * 注册 todo 工具（list/add/toggle/clear）供模型管理任务清单，状态经 api.storage 持久化
 * （metis 版存会话条目以支持分支，MeowCode 无分支语义，改用 KV 存储）；/todos 命令查看。
 */
import type { PluginFactory } from "meowcode";

type Todo = { id: number; text: string; done: boolean };

const factory: PluginFactory = (api) => {
  const load = async (): Promise<Todo[]> => (await api.storage.get<Todo[]>("todos")) ?? [];
  const save = (todos: Todo[]): Promise<void> => api.storage.set("todos", todos);
  const render = (todos: Todo[]): string =>
    todos.length > 0
      ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
      : "No todos";

  api.registerTool({
    name: "todo",
    description:
      "Manage a todo list for the current task. Actions: list, add (text), toggle (id), clear. Use it to track multi-step work.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "toggle", "clear"], description: "Operation" },
        text: { type: "string", description: "Todo text (for add)" },
        id: { type: "number", description: "Todo ID (for toggle)" },
      },
      required: ["action"],
    },
    execute: async (input) => {
      const todos = await load();
      const action = String(input.action);
      switch (action) {
        case "list":
          return { output: render(todos), ok: true };
        case "add": {
          const text = String(input.text ?? "").trim();
          if (!text) return { output: "Error: text required for add", ok: false };
          const nextId = todos.reduce((max, t) => Math.max(max, t.id), 0) + 1;
          todos.push({ id: nextId, text, done: false });
          await save(todos);
          return { output: `Added todo #${nextId}: ${text}`, ok: true };
        }
        case "toggle": {
          const id = Number(input.id);
          const todo = todos.find((t) => t.id === id);
          if (!todo) return { output: `Todo #${id} not found`, ok: false };
          todo.done = !todo.done;
          await save(todos);
          return { output: `Todo #${id} ${todo.done ? "completed" : "uncompleted"}`, ok: true };
        }
        case "clear": {
          const count = todos.length;
          await save([]);
          return { output: `Cleared ${count} todos`, ok: true };
        }
        default:
          return { output: `Unknown action: ${action}`, ok: false };
      }
    },
  });

  api.registerCommand({
    name: "todos",
    description: "让模型用 todo 工具汇报当前清单",
    run: () => "请用 todo 工具的 list 动作读取当前任务清单，并逐条简要汇报完成状态。",
  });

  api.logger.info("todo loaded（任务清单工具）");
};

export default factory;
