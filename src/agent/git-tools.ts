import {
  GitError,
  commit,
  createBranch,
  discard,
  getDiff,
  getStatus,
  listBranches,
  listLog,
  pull,
  push,
  resolveConflict,
  stage,
  stageAll,
  switchBranch,
  unstage,
  unstageAll,
  collectCommitContext,
} from "../git/git.js";
import type { ToolDefinition, ToolResult } from "./types.js";

const GIT_ACTIONS = [
  "status",
  "diff",
  "log",
  "branches",
  "stage",
  "unstage",
  "stage_all",
  "unstage_all",
  "discard",
  "commit",
  "branch_create",
  "branch_switch",
  "pull",
  "push",
  "resolve",
  "commit_context",
] as const;

export type GitAction = (typeof GIT_ACTIONS)[number];

/** 改变仓库状态的 action：plan/read-only 模式拒绝，ask 模式审批。 */
export const GIT_MUTATING_ACTIONS = new Set<string>([
  "stage",
  "unstage",
  "stage_all",
  "unstage_all",
  "discard",
  "commit",
  "branch_create",
  "branch_switch",
  "pull",
  "push",
  "resolve",
]);

/** 不可逆或影响远端：无论审批模式都必须弹一次审批。 */
export const GIT_FORCE_APPROVAL_ACTIONS = new Set<string>(["discard", "push", "pull"]);

export function gitActionOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const action = (input as Record<string, unknown>).action;
  return typeof action === "string" ? action : "";
}

export function isMutatingGitAction(input: unknown): boolean {
  return GIT_MUTATING_ACTIONS.has(gitActionOf(input));
}

export function isForceApprovalGitAction(input: unknown): boolean {
  return GIT_FORCE_APPROVAL_ACTIONS.has(gitActionOf(input));
}

export const gitToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "git",
    description:
      "Structured git operations (status/diff/log/branches/stage/commit/pull/push...). Read actions run without approval; mutating actions follow the approval mode and discard/push/pull always ask.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...GIT_ACTIONS] },
        path: { type: "string", description: "Single path for diff/resolve (relative to the workspace)." },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Paths for stage/unstage/discard.",
        },
        scope: { type: "string", enum: ["worktree", "index", "commit"], description: "diff scope (default worktree)." },
        sha: { type: "string", description: "Revision for diff scope=commit." },
        limit: { type: "integer", description: "log entries (1-100, default 20)." },
        message: { type: "string", description: "Commit message." },
        name: { type: "string", description: "Branch name." },
        start_point: { type: "string", description: "Branch start point (branch_create)." },
        force: { type: "boolean", description: "branch_switch: discard changes; push: force-with-lease." },
        stash: { type: "boolean", description: "branch_switch: stash before switching." },
        set_upstream: { type: "boolean", description: "push: set upstream." },
        side: { type: "string", enum: ["ours", "theirs", "mark"], description: "resolve conflict side." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function stateLabel(entry: { index: string | null; worktree: string | null }): string {
  return entry.index ?? entry.worktree ?? "?";
}

export async function executeGitTool(
  input: Record<string, unknown>,
  workspace: string,
): Promise<ToolResult> {
  const action = gitActionOf(input) as GitAction | "";
  try {
    switch (action) {
      case "status": {
        const status = await getStatus(workspace);
        if (!status.isRepo) {
          return { ok: false, output: `Not a git repository: ${status.reason ?? workspace}` };
        }
        const lines = [
          `repo ${status.name ?? ""} on ${status.detached ? "(detached)" : (status.branch ?? "?")}${
            status.upstream ? ` → ${status.upstream}` : ""
          }${status.ahead ? ` ahead ${status.ahead}` : ""}${status.behind ? ` behind ${status.behind}` : ""}`,
        ];
        const section = (label: string, entries: typeof status.staged) => {
          if (!entries.length) return;
          lines.push(`${label} (${entries.length}):`);
          for (const entry of entries.slice(0, 100)) {
            lines.push(
              `  ${stateLabel(entry)} ${entry.path}${
                entry.origPath ? ` ← ${entry.origPath}` : ""
              }${entry.added !== undefined ? ` +${entry.added}/-${entry.removed ?? 0}` : ""}`,
            );
          }
          if (entries.length > 100) lines.push(`  ... ${entries.length - 100} more`);
        };
        section("staged", status.staged);
        section("unstaged", status.unstaged);
        section("conflicted", status.conflicted);
        if (lines.length === 1) lines.push("working tree clean");
        return { ok: true, output: lines.join("\n") };
      }
      case "diff": {
        const scope = str(input, "scope");
        const result = await getDiff(workspace, {
          ...(str(input, "path") ? { path: str(input, "path") } : {}),
          ...(scope === "index" || scope === "commit" || scope === "worktree"
            ? { scope }
            : {}),
          ...(str(input, "sha") ? { sha: str(input, "sha") } : {}),
        });
        if (!result.patch.trim()) {
          return { ok: true, output: result.binary ? "[binary diff]" : "(no changes)" };
        }
        return {
          ok: true,
          output: `${result.patch}\n[+${result.added} -${result.removed}${result.truncated ? " · truncated" : ""}]`,
          ...(result.truncated ? { truncated: true } : {}),
        };
      }
      case "log": {
        const limit = Math.min(100, Math.max(1, Math.floor(Number(input.limit) || 20)));
        const result = await listLog(workspace, { limit });
        if (!result.commits.length) return { ok: true, output: "(no commits yet)" };
        return {
          ok: true,
          output: result.commits
            .map((item) => `${item.short} ${item.subject} — ${item.author}`)
            .join("\n"),
        };
      }
      case "branches": {
        const result = await listBranches(workspace);
        return {
          ok: true,
          output: result.branches
            .map((branch) => `${branch.current ? "*" : " "} ${branch.name} ${branch.sha.slice(0, 8)}`)
            .join("\n"),
        };
      }
      case "stage":
        await stage(workspace, input.paths);
        return { ok: true, output: `Staged ${(input.paths as unknown[]).length} path(s).` };
      case "unstage":
        await unstage(workspace, input.paths);
        return { ok: true, output: `Unstaged ${(input.paths as unknown[]).length} path(s).` };
      case "stage_all":
        await stageAll(workspace);
        return { ok: true, output: "Staged all changes." };
      case "unstage_all":
        await unstageAll(workspace);
        return { ok: true, output: "Unstaged all changes." };
      case "discard": {
        const result = await discard(workspace, input.paths);
        return { ok: true, output: `Discarded changes in ${result.discarded} path(s).` };
      }
      case "commit": {
        const message = str(input, "message").trim();
        if (!message) return { ok: false, output: "git commit requires message." };
        const result = await commit(workspace, message);
        return { ok: true, output: `Committed ${result.short}: ${result.subject}` };
      }
      case "branch_create": {
        const name = str(input, "name").trim();
        if (!name) return { ok: false, output: "git branch_create requires name." };
        const result = await createBranch(
          workspace,
          name,
          str(input, "start_point") || undefined,
        );
        return { ok: true, output: `Created and switched to ${result.branch}.` };
      }
      case "branch_switch": {
        const name = str(input, "name").trim();
        if (!name) return { ok: false, output: "git branch_switch requires name." };
        const result = await switchBranch(workspace, {
          name,
          ...(input.force === true ? { force: true } : {}),
          ...(input.stash === true ? { stash: true } : {}),
        });
        return { ok: true, output: `Switched to ${result.branch ?? name}.` };
      }
      case "pull": {
        const result = await pull(workspace);
        return { ok: true, output: result.summary };
      }
      case "push": {
        const result = await push(workspace, {
          ...(input.set_upstream === true ? { setUpstream: true } : {}),
          ...(input.force === true ? { force: true } : {}),
        });
        return { ok: true, output: result.summary };
      }
      case "resolve": {
        const target = str(input, "path");
        const side = str(input, "side");
        if (!target) return { ok: false, output: "git resolve requires path." };
        if (side !== "ours" && side !== "theirs" && side !== "mark") {
          return { ok: false, output: 'git resolve requires side "ours" | "theirs" | "mark".' };
        }
        await resolveConflict(workspace, { path: target, side });
        return { ok: true, output: `Resolved ${target} (${side}).` };
      }
      case "commit_context": {
        const context = await collectCommitContext(workspace);
        return {
          ok: true,
          output: [
            "recent:",
            ...context.recentSubjects.slice(0, 10).map((subject) => `- ${subject}`),
            "stat:",
            context.statText || "(empty)",
          ].join("\n"),
        };
      }
      default:
        return { ok: false, output: `Unknown git action: ${action || "(missing)"}` };
    }
  } catch (error) {
    if (error instanceof GitError) {
      return {
        ok: false,
        output: `git ${action} failed (${error.code}): ${error.message}${
          error.detail ? `\n${error.detail}` : ""
        }`,
      };
    }
    return {
      ok: false,
      output: `git ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
