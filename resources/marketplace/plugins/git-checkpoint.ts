/**
 * Git 检查点插件（适配自 metis-main examples/extensions/git-checkpoint.ts）
 *
 * 每个完成的回合结束后，用 `git stash create` 生成一个不改变工作树的检查点提交，
 * 并存入 refs/stash（不 pop、不 apply，工作区不受影响）。回滚时用
 * `git stash apply stash@{N}` 找回某个时点。
 * /checkpoint-now 立即打一个检查点；默认关闭，/checkpoint on 开启。
 */
import type { PluginFactory } from "meowcode";
import { execFile } from "node:child_process";

function git(cwd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}${stderr}`.trim() || (error?.message ?? "") });
    });
  });
}

const factory: PluginFactory = (api) => {
  let enabled = false;

  void api.storage.get<boolean>("enabled").then((value) => {
    enabled = value === true;
  });

  async function checkpoint(label: string): Promise<string> {
    const inside = await git(api.workspace, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.output !== "true") return "当前目录不是 git 仓库，跳过检查点。";
    const create = await git(api.workspace, [
      "stash",
      "create",
      `meowcode-checkpoint ${label}`,
    ]);
    if (!create.ok || create.output.length === 0) {
      return create.output.includes("You do not have the initial commit")
        ? "仓库还没有初始提交，跳过。"
        : `创建检查点失败：${create.output}`;
    }
    const sha = create.output;
    const store = await git(api.workspace, ["stash", "store", "-m", `meowcode-checkpoint ${label}`, sha]);
    return store.ok ? `检查点已保存：${sha.slice(0, 10)}（${label}）` : `存储检查点失败：${store.output}`;
  }

  api.registerCommand({
    name: "checkpoint",
    description: "回合结束 git 检查点：/checkpoint on|off，/checkpoint-now 立即打点",
    run: async (args) => {
      const action = args.trim();
      if (action === "on" || action === "off") {
        enabled = action === "on";
        await api.storage.set("enabled", enabled);
        return enabled
          ? "检查点已开启：每回合结束自动 git stash create（不改工作树）。"
          : "检查点已关闭。";
      }
      return await checkpoint("manual");
    },
  });

  api.on("turn_end", async (event) => {
    if (!enabled || event.status !== "completed") return;
    const result = await checkpoint(event.turnId.slice(0, 8));
    api.logger.info(result);
  });

  api.logger.info("git-checkpoint loaded（默认关闭，/checkpoint on 开启）");
};

export default factory;
