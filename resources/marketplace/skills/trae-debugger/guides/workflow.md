## Workflow

### Step 1 — Problem Definition & Initialization (BLOCKING)

1.  **Restate the Issue**: Clearly define the difference between actual behavior and expected behavior.
2.  **Generate Session ID**: Create a semantic session identifier based on the bug description using lowercase English words with hyphens (e.g., `login-500-error`, `cart-empty-bug`).
3.  **Resolve Project Root**: Resolve `PROJECT_ROOT` to the absolute path of the user workspace containing the primary code or service being debugged. Never use `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger`, its installation directory, or the current shell directory as a substitute.
4.  **Resolve Evidence Directory**: Resolve `DEBUG_EVIDENCE_DIR` to an absolute, session-specific temporary directory outside every active workspace and development-server watch root.
5.  **Create debug-<sessionId>.md**: Initialize `<PROJECT_ROOT>/debug-<sessionId>.md`, recording the initial status `[OPEN]`, problem description, known reproduction steps, and the absolute `DEBUG_EVIDENCE_DIR`.

> **⚠️ Core Constraint**: Modifying any business logic code is strictly prohibited during this phase. **Executing any other write operations before creating `<PROJECT_ROOT>/debug-<sessionId>.md` is strictly forbidden.**

> **💡 User Guidance**: After this step, inform the user:
> - The session ID being used (e.g., `login-500-error`)
> - The absolute `PROJECT_ROOT`
> - Where the debug file is located (e.g., `<PROJECT_ROOT>/debug-login-500-error.md`)
> - The absolute external `DEBUG_EVIDENCE_DIR`
> - What the next steps will be

Output: Bug Brief + `<PROJECT_ROOT>/debug-<sessionId>.md` (Initial)

---

### Step 2 — Hypothesis Generation (3–5 items) (BLOCKING)

Generate hypotheses with **Likelihood** and **Effort** assessment to prioritize verification:

| ID | Hypothesis | Likelihood | Effort | Expected Signal |
|----|------------|------------|--------|-----------------|
| A | Description | High/Medium/Low | Low/Medium/High | What logs would confirm |

**Prioritization Rule**: Verify **High Likelihood + Low Effort** hypotheses first.

Each hypothesis must include:

*   What signals will be seen in the logs if true (falsifiable signals).
*   Where instrumentation is needed (minimal points).
*   Whether it can be determined by a single fastest reproduction.

**Example**:
| ID | Hypothesis | Likelihood | Effort | Expected Signal |
|----|------------|------------|--------|-----------------|
| A | Database connection timeout | High | Low | `ETIMEDOUT` in error object |
| B | Auth token expired | Medium | Low | `401` response code |
| C | Memory leak causing slowdown | Low | High | Memory growth pattern over time |

> **💡 Tip**: Start with Hypothesis A (High likelihood, Low effort). Refer to `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/guides/scenarios.md` for scenario-specific hypothesis templates.

Output: Hypothesis Table (A–E) with Likelihood/Effort

---

### Step 3 — Instrumentation Design (3–8 points)

Principle: Use the minimum amount of logs to simultaneously distinguish 3–5 hypotheses (parallel verification).

Before designing the instrumentation, select the evidence transport. Run every command with `workdir` set to `PROJECT_ROOT`, but keep high-frequency evidence outside all project and development-server watch roots:

1. Start the bundled Debug Server once with `--outdir "<DEBUG_EVIDENCE_DIR>"` and perform one bounded startup, health, and probe-event check, for example within 10 seconds total. `DEBUG_EVIDENCE_DIR` must be absolute and outside the watched workspace.
2. If the HTTP path is unavailable, inspect the project for an existing local structured log sink and use it if it can preserve the required evidence fields.
3. If neither path is usable, set `progress_status: blocked`, mark all hypotheses `INCONCLUSIVE`, clean up any started server and debug artifacts, and exit this Skill. Do not keep retrying or invent a new collector.

Do not modify Vite, webpack, HMR, or other watcher configuration to ignore debugger artifacts. If evidence writes trigger reloads, discard that run, move `DEBUG_EVIDENCE_DIR` outside the watch root, restart the affected runtime once, clear the new evidence sink, and reproduce again.

Requirements:

*   Each log must be bound to a `hypothesisId`.
*   Instrumentation code must use semantic tags: `// #region debug-point <hypothesisId>[:description]`.
*   It is recommended to include a unified log prefix in the `message` field (default `[DEBUG]`).

Output: List of Insertion Points + Expected Signals

---

### Step 4 — Instrumentation Patch (No Behavioral Changes)

*   **Strictly Prohibit Business Logic Changes**: Code changes in this step are limited only to adding instrumentation logs; fixing any discovered potential bugs or performing refactoring is forbidden.
*   **Strictly Prohibit Creating New Util Files**: Use inline one-liners or reuse existing capabilities.
*   Introduce lightweight inline reporting logic (One-liner).

> **💡 User Guidance**: After instrumentation, clearly explain to the user:
> - Which files were modified and why
> - Which evidence transport is active and where its logs will be read
> - For HTTP transport, the instrumentation uses the env file for configuration (no manual setup needed)
> - If HTTP is unavailable, the instrumentation uses the project's existing local structured log path

Output: Instrumentation Diff

---

### Step 5 — Log Initialization (MANDATORY)

*   **Clear Content**: Clear the current session's existing log entries using the selected HTTP or local transport (do not delete the log sink).
*   **Confirm Status**: Ensure `runId = "pre-fix"`.

Output: Reproduction Steps (must include runId/sessionId)

---

### Step 6 — Autonomous Reproduction & Evidence Collection

1.  **Clear Logs (MANDATORY)**: Before reproduction, clear the current session's entries in the selected HTTP or local log sink so the collected evidence contains only data from the current run.
2.  **Drive Reproduction**: Use available browser, terminal, test, application, or project-specific tools to execute the reproduction path directly.
3.  **Collect Evidence**: Read the resulting runtime evidence and continue to analysis without asking for routine user confirmation.
4.  **User-Only Action**: If an essential reproduction action cannot be performed by the Agent, explain the exact action and evidence needed in a concise plain-text message and yield. Do not use `AskUserQuestion`.

Output: Evidence (Runtime Logs)

---

### Step 7 — Evidence-Based Analysis

> **⚠️ Log Reading Constraint**: Read evidence from the selected local file or log sink using the file read/tooling path it provides. For HTTP transport, read `<DEBUG_EVIDENCE_DIR>/trae-debug-log-<sessionId>.ndjson` directly; **do NOT use `curl` or the HTTP API** (e.g., `curl -s "http://127.0.0.1:7777/logs" | head`) to query logs.

1.  **Read Evidence**: Read the selected evidence source and extract relevant log entries. Record its path or query method in `debug-<sessionId>.md`.
2.  **Determine Hypotheses**: Mark each hypothesis as CONFIRMED / REJECTED / INCONCLUSIVE.
3.  **Present Verification Status**: Report hypothesis verification status to user in table format:

| ID | Hypothesis | Status | Evidence Summary |
|----|------------|--------|------------------|
| A | Database connection timeout | ✅ Confirmed | Line 23: `ETIMEDOUT` in error object |
| B | Auth token expired | ❌ Rejected | Line 45: Token valid, 200 response |
| C | Memory leak | ⏳ Inconclusive | Insufficient data for pattern analysis |

4.  **Update Records**: Synchronize these verification conclusions in `debug-<sessionId>.md`, referencing specific log lines.

> **💡 User Guidance**: When presenting verification results:
> - Use the table format above to clearly show confirmed/rejected/inconclusive hypotheses
> - Provide brief evidence summary for each hypothesis
> - Highlight the confirmed root cause if identified

Output: Root cause or `INCONCLUSIVE` result + Verification Table + `debug-<sessionId>.md` (Updated)

---

### Step 8 — Minimal Fix (Retain Instrumentation)

1.  Implement a minimal fix Patch.
2.  Summarize the fix logic for the user and explain why instrumentation is retained for comparative verification.

---

### Step 9 — Autonomous Post-Fix Verification

1.  **Clear Logs (MANDATORY)**: Before fix verification, **previous debugging logs must be cleared** to ensure the post-fix evidence is pure.
2.  **Update runId**: Set `runId="post-fix"`.
3.  **Repeat Reproduction**: Re-run the same reproduction path with available tools.
4.  **Compare Evidence**: Compare `pre-fix` and `post-fix` evidence and determine whether the original failure signal is gone and the expected behavior is present.
5.  **No Premature Cleanup**: Retain all instrumentation and the selected evidence transport until the completion gate in Step 10 is satisfied.

---

### Step 10 — Autonomous Completion Gate

Do not call `AskUserQuestion` and do not pause for routine confirmation. Determine the next action from the reproduced behavior and runtime evidence:

*   **Verified**: The original reproduction produces the expected behavior, the pre-fix failure signal is absent, and post-fix evidence shows no observed regression. Proceed to cleanup.
*   **Still reproducible**: Record the failed verification and enter the iteration loop.
*   **Evidence inconclusive**: Refine hypotheses or instrumentation and continue collecting evidence.
*   **Blocked by user-only action**: Request the exact action and evidence needed in plain text, then yield.
*   **User abort**: Proceed to cleanup with a progress summary and no unsupported conclusion.

---

### Step 11 — Branching Decision

**If Verified: Enter Cleanup & Summary Phase**
1.  **Update Status**: Change Status to `[FIXED]` in `debug-<sessionId>.md` and record the successful `pre-fix` versus `post-fix` comparison.
2.  **Status Check & Cleanup**:
    *   Check Debug Server process status (e.g., `lsof -i :<port>`).
    *   If still running, explicitly terminate and exit the process.
    *   Completely remove all instrumentation code (code blocks marked with `#region debug-point`).
3.  **Delete All Debug Files (MANDATORY)**:

> **⚠️ MANDATORY: Delete All Debug Files**
>
> You **MUST** delete ALL of the following files. **Do NOT "archive" or "preserve" any debug files.**
> ```
> ❌ WRONG - Do NOT do this:
> 📁 调试文件归档
> - 日志文件：.dbg/xxx.ndjson（已保留）
> - 环境配置：.dbg/xxx.env（已保留）
> ```

**Files to DELETE:**
| File | Path Pattern |
|------|--------------|
| Debug record | `<PROJECT_ROOT>/debug-<sessionId>.md` |
| Log file | `<DEBUG_EVIDENCE_DIR>/trae-debug-log-<sessionId>.ndjson` |
| Env file | `<DEBUG_EVIDENCE_DIR>/<sessionId>.env` |

4.  **Final Summary**: Summarize the problem principles based on evidence and complete the formal submission with minimal changes.

> **💡 User Guidance**: After cleanup, provide a summary including:
> - Root cause of the issue
> - What was fixed
> - Files that were **deleted** (not archived)

**If Still Reproducible or Evidence Is Inconclusive: Enter Iteration Loop**
1.  **Record Status**: Record in `debug-<sessionId>.md` why it wasn't fixed and update reproduction steps or hypotheses.
2.  **Status Check & Recovery**:
    *   Check if the Debug Server is still running. Do not restart it because of user inactivity; if the transport has failed, apply the stop-loss rule and use the local fallback or exit the Skill.
    *   In-depth Analysis: Compare log differences between `pre-fix` and `post-fix`.
    *   Adjust Instrumentation: Adjust or add instrumentation points based on new findings and return to Step 5 without asking for routine confirmation.

**If User Aborts: Enter Cleanup Phase**
1.  **Record Status**: Record in `debug-<sessionId>.md` that debugging was aborted by user.
2.  **Cleanup (MANDATORY)** - Delete ALL debug files:
    *   Completely remove all instrumentation code.
    *   Stop the Debug Server if running.
    *   **DELETE**: `<DEBUG_EVIDENCE_DIR>/trae-debug-log-<sessionId>.ndjson`
    *   **DELETE**: `<DEBUG_EVIDENCE_DIR>/<sessionId>.env`
    *   **DELETE**: `<PROJECT_ROOT>/debug-<sessionId>.md`
3.  **Summary**: Provide a brief summary of what was investigated and current findings (even if inconclusive).
