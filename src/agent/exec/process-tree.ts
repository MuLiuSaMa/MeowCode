import { spawn, type ChildProcess } from "node:child_process";
import { commandEnv } from "./env.js";

/**
 * 杀掉整棵子进程树（Windows 走 taskkill /T）。git 服务复用同一份实现，不复制逻辑。
 *
 * 返回 Promise 是为了让调用方**等它真的收工**：之前 spawn 完就返回，接着就把管道
 * destroy 掉，taskkill 还在跑、孙进程可能已经脱离成孤儿并继续持有句柄。
 * 不关心结果的调用方（git / 后台任务）照旧忽略返回值即可。
 */
export function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const fallback = (): void => {
        try {
          child.kill();
        } catch {
          // 进程可能已经退出
        }
        finish();
      };
      try {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
          env: commandEnv(),
        });
        killer.on("error", fallback);
        killer.on("close", finish);
      } catch {
        fallback();
      }
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // 进程可能已经退出
    }
  }
  return Promise.resolve();
}
