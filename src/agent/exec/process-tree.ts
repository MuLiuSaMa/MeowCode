import { spawn, type ChildProcess } from "node:child_process";
import { commandEnv } from "./env.js";

/** Windows 上只 kill 直接子进程会留下孙进程占着管道；必须整棵树终止。 */
/** 杀掉整棵子进程树（Windows 走 taskkill /T）。git 服务复用同一份实现，不复制逻辑。 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      env: commandEnv(),
    });
    killer.on("error", () => {
      try {
        child.kill();
      } catch {
        // 进程可能已经退出
      }
    });
    return;
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
}
