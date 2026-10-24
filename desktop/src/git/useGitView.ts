import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  gitBranches,
  gitCommit,
  gitCommitMessage,
  gitCreateBranch,
  gitDiff,
  gitDiscard,
  gitLog,
  gitPull,
  gitPush,
  gitResolve,
  gitShowCommit,
  gitStage,
  gitStatus,
  gitSwitchBranch,
  gitUnstage,
  type GitBranch,
  type GitCommit,
  type GitDiffResult,
  type GitFileEntry,
  type GitStatus,
} from "../api";

/** 当前选中的条目：某个文件（区分暂存/工作区侧）或某次提交 */
export type GitSelection =
  | { kind: "file"; path: string; side: "worktree" | "index"; conflict?: boolean }
  | { kind: "commit"; sha: string };

export type GitCommitDetail = {
  commit: GitCommit;
  files: GitFileEntry[];
  /** 该提交涉及的文件总数（files 最多 500 条，大提交会被截断） */
  fileCount: number;
  patch: string;
  truncated: boolean;
};

/** 左栏分组：冲突 / 已暂存 / 未暂存 */
export type GitGroupId = "conflicted" | "staged" | "unstaged";

export type GitView = {
  workspace?: string;
  status: GitStatus | null;
  loading: boolean;
  /** 最近一次动作/拉取的错误文案（渲染在头部，可关闭） */
  error: string | null;
  clearError: () => void;
  /** 正在执行的动作名（按钮转圈 + 防重复点击） */
  busy: string | null;

  selection: GitSelection | null;
  diff: GitDiffResult | null;
  diffLoading: boolean;
  commitDetail: GitCommitDetail | null;

  branches: GitBranch[];
  branchesLoading: boolean;
  detached: boolean;

  commits: GitCommit[];
  logLoading: boolean;
  hasMore: boolean;

  message: string;
  setMessage: (value: string) => void;
  aiLoading: boolean;

  /** 手动/定时刷新；silent 不闪 loading 骨架 */
  refresh: (options?: { silent?: boolean }) => Promise<void>;
  selectFile: (entry: GitFileEntry, side: GitGroupId) => void;
  selectCommit: (sha: string) => void;
  clearSelection: () => void;

  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discard: (paths: string[]) => Promise<void>;
  commit: () => Promise<boolean>;
  resolve: (path: string, side: "ours" | "theirs" | "mark") => Promise<void>;

  loadBranches: () => Promise<void>;
  switchBranch: (input: { name: string; force?: boolean; stash?: boolean }) => Promise<void>;
  createBranch: (name: string, startPoint?: string) => Promise<void>;

  pull: () => Promise<void>;
  push: (input?: { force?: boolean }) => Promise<void>;

  generateMessage: () => Promise<void>;
  loadMoreCommits: () => Promise<void>;
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

const LOG_PAGE_SIZE = 50;

/**
 * Git 面板的全部状态与动作。
 *
 * 必须在 App 里调用（视图切走时 GitBody 会卸载，选中态、diff、提交草稿都不能跟着丢）。
 * 刷新策略：视图可见时 10s 轮询 + git_changed/file_changed/turn_complete 事件（300ms 防抖），
 * 写操作成功后立即刷新；`requestIdRef` 保证只有最新响应落地。
 */
export function useGitView(options: { workspace?: string; active: boolean }): GitView {
  const { workspace, active } = options;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selection, setSelection] = useState<GitSelection | null>(null);
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [commitDetail, setCommitDetail] = useState<GitCommitDetail | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [detached, setDetached] = useState(false);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [message, setMessage] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  const requestIdRef = useRef(0);
  const diffRequestRef = useRef(0);
  const logRequestRef = useRef(0);
  const selectionRef = useRef<GitSelection | null>(null);
  selectionRef.current = selection;

  const clearError = useCallback(() => setError(null), []);

  /** 拉状态 + 提交列表；silent 用于轮询，不显示骨架屏 */
  const refresh = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!workspace) {
        setStatus(null);
        return;
      }
      const requestId = (requestIdRef.current += 1);
      if (!opts.silent) setLoading(true);
      try {
        const next = await gitStatus();
        if (requestId !== requestIdRef.current) return;
        setStatus(next);
        // 选中项已消失（提交/丢弃/切分支后）：清空，避免显示已不存在文件的旧 diff
        const current = selectionRef.current;
        if (current?.kind === "file") {
          const stillThere = [...next.staged, ...next.unstaged, ...next.conflicted].some(
            (entry) => entry.path === current.path,
          );
          if (next.isRepo && !stillThere) {
            setSelection(null);
            setDiff(null);
          }
        }
        if (next.isRepo) {
          const logRequest = (logRequestRef.current += 1);
          setLogLoading(true);
          await gitLog({ limit: LOG_PAGE_SIZE })
            .then((result) => {
              if (logRequest !== logRequestRef.current) return;
              setCommits(result.commits);
              setHasMore(result.hasMore);
            })
            .catch(() => undefined)
            .finally(() => {
              if (logRequest === logRequestRef.current) setLogLoading(false);
            });
        } else {
          setCommits([]);
          setHasMore(false);
        }
      } catch (refreshError) {
        if (requestId !== requestIdRef.current) return;
        setError(errorMessage(refreshError));
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [workspace],
  );

  /** 切工作区：清空全部派生状态 */
  useEffect(() => {
    setStatus(null);
    setSelection(null);
    setDiff(null);
    setCommitDetail(null);
    setBranches([]);
    setCommits([]);
    setMessage("");
    setError(null);
  }, [workspace]);

  // 视图可见时轮询 + 事件驱动刷新（事件做 300ms 防抖，避免提交时事件风暴）
  useEffect(() => {
    if (!active || !workspace) return;
    void refresh();
    const timer = setInterval(() => void refresh({ silent: true }), 10_000);
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const off = window.meow.onEvent((event) => {
      const type = (event as { type?: string }).type;
      if (type !== "git_changed" && type !== "file_changed" && type !== "turn_complete") return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void refresh({ silent: true });
      }, 300);
    });
    return () => {
      clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      off();
    };
  }, [active, workspace, refresh]);

  const selectFile = useCallback((entry: GitFileEntry, side: GitGroupId) => {
    const scope: "worktree" | "index" = side === "staged" ? "index" : "worktree";
    const next: GitSelection = {
      kind: "file",
      path: entry.path,
      side: scope,
      ...(side === "conflicted" ? { conflict: true } : {}),
    };
    setSelection(next);
    setCommitDetail(null);
    void (async () => {
      const requestId = (diffRequestRef.current += 1);
      setDiffLoading(true);
      try {
        const result = await gitDiff({
          path: entry.path,
          scope: side === "conflicted" ? "worktree" : scope,
        });
        if (requestId !== diffRequestRef.current) return;
        setDiff(result);
      } catch (diffError) {
        if (requestId !== diffRequestRef.current) return;
        setDiff(null);
        setError(errorMessage(diffError));
      } finally {
        if (requestId === diffRequestRef.current) setDiffLoading(false);
      }
    })();
  }, []);

  const selectCommit = useCallback((sha: string) => {
    setSelection({ kind: "commit", sha });
    setDiff(null);
    void (async () => {
      const requestId = (diffRequestRef.current += 1);
      setDiffLoading(true);
      try {
        const detail = await gitShowCommit(sha);
        if (requestId !== diffRequestRef.current) return;
        setCommitDetail(detail);
      } catch (commitError) {
        if (requestId !== diffRequestRef.current) return;
        setCommitDetail(null);
        setError(errorMessage(commitError));
      } finally {
        if (requestId === diffRequestRef.current) setDiffLoading(false);
      }
    })();
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(null);
    setDiff(null);
    setCommitDetail(null);
  }, []);

  /** 统一包一层：busy 标记 + 错误落到 error + 成功后静默刷新 */
  const run = useCallback(
    async (name: string, action: () => Promise<unknown>): Promise<boolean> => {
      if (busy) return false;
      setBusy(name);
      setError(null);
      try {
        await action();
        await refresh({ silent: true });
        return true;
      } catch (actionError) {
        // 错误只落在面板顶部的横幅里：Git 视图里看不到聊天时间线，
        // 往那里塞 toast 等于静默丢失。
        setError(errorMessage(actionError));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [busy, refresh],
  );

  const stage = useCallback(
    async (paths: string[]) => {
      await run("stage", () => gitStage(paths));
    },
    [run],
  );

  const unstage = useCallback(
    async (paths: string[]) => {
      await run("unstage", () => gitUnstage(paths));
    },
    [run],
  );

  const discard = useCallback(
    async (paths: string[]) => {
      await run("discard", () => gitDiscard(paths));
    },
    [run],
  );

  const resolve = useCallback(
    async (filePath: string, side: "ours" | "theirs" | "mark") => {
      await run(`resolve:${side}`, () => gitResolve({ path: filePath, side }));
    },
    [run],
  );

  const commit = useCallback(async (): Promise<boolean> => {
    const text = message.trim();
    if (!text) {
      setError("提交信息不能为空");
      return false;
    }
    const ok = await run("commit", () => gitCommit(text));
    if (ok) {
      setMessage("");
      setSelection(null);
      setDiff(null);
    }
    return ok;
  }, [message, run]);

  const loadBranches = useCallback(async () => {
    if (!workspace) return;
    setBranchesLoading(true);
    try {
      const result = await gitBranches();
      setBranches(result.branches);
      setDetached(result.detached);
    } catch (branchError) {
      setError(errorMessage(branchError));
    } finally {
      setBranchesLoading(false);
    }
  }, [workspace]);

  const switchBranch = useCallback(
    async (input: { name: string; force?: boolean; stash?: boolean }) => {
      const ok = await run("switch", () => gitSwitchBranch(input));
      if (ok) {
        await loadBranches();
        clearSelection();
      }
    },
    [clearSelection, loadBranches, run],
  );

  const createBranch = useCallback(
    async (name: string, startPoint?: string) => {
      const ok = await run("create-branch", () => gitCreateBranch(name, startPoint));
      if (ok) await loadBranches();
    },
    [loadBranches, run],
  );

  const pull = useCallback(async () => {
    await run("pull", () => gitPull());
  }, [run]);

  const push = useCallback(
    async (input: { force?: boolean } = {}) => {
      await run("push", () => gitPush(input));
    },
    [run],
  );

  const generateMessage = useCallback(async () => {
    if (aiLoading) return;
    setAiLoading(true);
    setError(null);
    try {
      const result = await gitCommitMessage();
      setMessage(result.message);
    } catch (aiError) {
      const text = errorMessage(aiError);
      setError(`AI 生成失败：${text}`);
    } finally {
      setAiLoading(false);
    }
  }, [aiLoading]);

  const loadMoreCommits = useCallback(async () => {
    if (logLoading || !hasMore) return;
    const requestId = (logRequestRef.current += 1);
    setLogLoading(true);
    try {
      const result = await gitLog({ limit: LOG_PAGE_SIZE, skip: commits.length });
      if (requestId !== logRequestRef.current) return;
      setCommits((current) => [...current, ...result.commits]);
      setHasMore(result.hasMore);
    } catch {
      // 静默：分页失败不影响已加载的列表
    } finally {
      if (requestId === logRequestRef.current) setLogLoading(false);
    }
  }, [commits.length, hasMore, logLoading]);

  return {
    workspace,
    status,
    loading,
    error,
    clearError,
    busy,
    selection,
    diff,
    diffLoading,
    commitDetail,
    branches,
    branchesLoading,
    detached,
    commits,
    logLoading,
    hasMore,
    message,
    setMessage,
    aiLoading,
    refresh,
    selectFile,
    selectCommit,
    clearSelection,
    stage,
    unstage,
    discard,
    commit,
    resolve,
    loadBranches,
    switchBranch,
    createBranch,
    pull,
    push,
    generateMessage,
    loadMoreCommits,
  };
}
