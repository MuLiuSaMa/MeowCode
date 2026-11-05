import { useCallback, useEffect, useRef, useState } from "react";
import { gitStatus, type GitStatus } from "../api";

/**
 * 聊天页常驻的轻量 git 状态：只拉 status（不拉 log），
 * 10s 轮询 + git/file/turn/回滚事件 300ms 防抖。
 * 右上角概览面板与输入框胶囊的「未提交」过滤共用这一份状态。
 */
export function useWorkspaceGit(options: {
  workspace?: string;
  active: boolean;
}): GitStatus | null {
  const { workspace, active } = options;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!workspace) {
      setStatus(null);
      return;
    }
    const requestId = (requestRef.current += 1);
    try {
      const next = await gitStatus();
      if (requestId === requestRef.current) setStatus(next);
    } catch {
      // 调用方保持上一份状态；具体错误由 Git 面板展示
    }
  }, [workspace]);

  useEffect(() => {
    setStatus(null);
  }, [workspace]);

  // 提交/暂存/丢弃可能发生在 Git 视图（聊天页 hook 未激活），
  // git_changed 始终监听，保证回到聊天时已提交文件立刻从胶囊消失。
  useEffect(() => {
    if (!workspace) return;
    let debounce: number | null = null;
    const off = window.meow.onEvent((event) => {
      if (event.type !== "git_changed") return;
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        void refresh();
      }, 300);
    });
    return () => {
      if (debounce !== null) window.clearTimeout(debounce);
      off();
    };
  }, [refresh, workspace]);

  useEffect(() => {
    if (!active || !workspace) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    let debounce: number | null = null;
    const off = window.meow.onEvent((event) => {
      if (
        event.type !== "file_changed" &&
        event.type !== "turn_complete" &&
        event.type !== "files_rewound"
      ) {
        return;
      }
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        void refresh();
      }, 300);
    });
    return () => {
      window.clearInterval(timer);
      if (debounce !== null) window.clearTimeout(debounce);
      off();
    };
  }, [active, workspace, refresh]);

  return status;
}
