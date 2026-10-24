/**
 * 自动提交插件（适配自 metis-main examples/extensions/auto-commit-on-exit.ts）
 *
 * turn_end 且状态 completed 时，若工作区是 git 仓库且有未提交改动，自动 commit。
 * **默认关闭**（自动提交有风险）：/autocommit on 开启、/autocommit off 关闭，状态持久化。
 */
import type { PluginFactory } from "meowcode";
import { execFile } from "node:child_process";

function git(cwd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        output: `${stdout}${stderr}`.trim() || (error?.message ?? ""),
      });
    });
  });
}

const factory: PluginFactory = (api) => {
  let enabled = false;
  let running = false;

  void api.storage.get<boolean>("enabled").then((value) => {
    enabled = value === true;
  });

  api.registerCommand({
    name: "autocommit",
    description: "回合结束自动 git commit：/autocommit on 开启，/autocommit off 关闭",
    run: async (args) => {
      enabled = args.trim() === "on";
      await api.storage.set("enabled", enabled);
      return enabled ? "自动提交已开启：每个完成的回合若有改动将自动 commit。" : "自动提交已关闭。";
    },
  });

  api.on("turn_end", async (event) => {
    if (!enabled || event.status !== "completed" || running) return;
    running = true;
    try {
      const status = await git(api.workspace, ["status", "--porcelain"]);
      if (!status.ok || status.output.length === 0) return;
      const add = await git(api.workspace, ["add", "-A"]);
      if (!add.ok) {
        api.logger.warn(`auto-commit add failed: ${add.output}`);
        return;
      }
      const commit = await git(api.workspace, [
        "commit",
        "-m",
        `chore: auto-commit after completed turn (${event.turnId.slice(0, 8)})`,
      ]);
      if (!commit.ok) api.logger.warn(`auto-commit failed: ${commit.output}`);
      else api.logger.info(`auto-commit done: ${commit.output.split("\n")[0]}`);
    } finally {
      running = false;
    }
  });

  api.logger.info("auto-commit loaded（默认关闭，/autocommit on 开启）");
};

export default factory;
