---
name: TRAE-debugger
description: 用于调试需要采集运行时证据的复杂、可复现问题，通过假设、针对性插桩、复现、分析、最小修复和修复后验证形成闭环。仅当用户直接要求调试、排查、诊断、定位根因或采集运行时证据，且无法通过直接的静态分析可靠定位、也没有更合适的专用流程时使用。仅描述卡顿、空白、崩溃、抖动或行为异常，或者仅要求修复、优化，并不构成本 Skill 的启用意图。对于同一调试请求，用户偏好及其他专用调试 Skill、MCP 和流程具有更高优先级，即使用户没有点名。本 Skill 不处理简单问题或静态问题，也不作为 Agent 执行受阻时的自动兜底。
---

# Debugger Skill

## Pre-Activation Intent Gate

Loading this file does not establish debugging intent. Check the user's current request before any other action:

1. Activate only when the user directly asks to debug, troubleshoot, investigate, diagnose, locate the cause or root cause, or collect runtime evidence.
2. A symptom-only statement such as "it is slow," "the page is blank," "it crashes," "it flickers," or "it does not work" does not qualify.
3. A request only to fix, optimize, improve, or look at a problem does not qualify unless it also explicitly asks for debugging or cause investigation.
4. Do not infer intent from severity, reproducibility, the apparent need for runtime evidence, or the Agent's preferred solution.
5. If this gate fails, exit this Skill immediately without reading its referenced guides, exploring the project under this workflow, generating a session ID, or creating artifacts. Handle the request through the normal task flow and applicable non-debugger Skills.

---

## Pre-Activation Selection Gate

Run this gate only after the Pre-Activation Intent Gate passes. Treat this built-in Skill as a generic fallback, never as the default debugging entry point.

Complete this gate before announcing that `TRAE-debugger` will be used, reading its referenced guides, exploring the target project, generating a session ID, creating a debug record, or making any other write:

1. Enumerate the available Skills and established workflows whose descriptions match debugging, troubleshooting, the product or project, the domain, or the reported symptom.
2. Honor any Skill, MCP, method, or workflow explicitly selected by the user in the current request or earlier conversation.
3. When a user-authored, user-preferred, project-specific, business-specific, domain-specific, or scenario-specific option could apply, read that option's instructions before doing anything else.
4. If that option applies, exit this Skill immediately and use only the specialized option. Do not initialize `TRAE-debugger` artifacts.
5. Activate `TRAE-debugger` only after completing this check and determining that no specialized option applies. If applicability is uncertain, prefer the specialized option.
6. Do not combine this workflow with the specialized option unless the user explicitly requests that combination.

---

## Pre-Activation Complexity Gate

Run this gate only after the Intent and Selection gates pass. Perform a bounded, read-only static triage without creating debug artifacts.

Activate this Skill only when runtime evidence is necessary to distinguish plausible causes, such as:

- intermittent, timing-dependent, concurrent, environment-dependent, or state-transition behavior;
- performance symptoms that require runtime measurement;
- multiple plausible runtime hypotheses that straightforward code or configuration inspection cannot reliably confirm or reject.

Do not activate it when a direct code or configuration inspection can identify the cause, or when the issue can be handled as a straightforward implementation, correction, test, compile, type-check, or lint task. Failure to solve another task after multiple attempts does not satisfy this gate. If the gate fails, exit this Skill and continue through the normal task flow.

---

## Activation Boundary

Use this Skill only when all of the following conditions hold:

1. The Pre-Activation Intent Gate has confirmed a direct user request to debug or investigate the cause of a runtime symptom.
2. The Pre-Activation Selection Gate has been completed and no specialized debugging option applies.
3. The Pre-Activation Complexity Gate has confirmed that straightforward static analysis cannot reliably diagnose the problem and runtime evidence is necessary.
4. The debugging intent comes from the user, not from the Agent encountering errors, failed commands or tests, or difficulty completing another task.

Do not activate this Skill for compile errors, type errors, lint failures, static analysis, or other problems that can be handled without runtime evidence. Do not infer a request for runtime debugging merely because static analysis has not yet found the cause, or because the Agent's current approach has failed.

---

## 🚨 Post-Selection Bootstrap Protocol

**Run this protocol only after all Pre-Activation gates pass. The first response after selecting `TRAE-debugger` must include the following actions; otherwise, it is considered an instruction violation:**

1.  **No Logic Modification**: During Steps 1-4, touching any business logic code is strictly prohibited.
2.  **Generate Session ID**: Generate a semantic session identifier based on the bug description, using lowercase English words with hyphens (e.g., `login-500-error`, `cart-empty-bug`, `auth-token-expired`). Keep it concise (2-4 words) and descriptive.
3.  **Resolve Project Root**: Resolve `PROJECT_ROOT` to the absolute path of the user workspace that contains the code being debugged. This read-only resolution must happen before any write.
4.  **Initialize `debug-<sessionId>.md`**: You must create `<PROJECT_ROOT>/debug-<sessionId>.md`. **This is the first write operation of the debugging session.** Example: `<PROJECT_ROOT>/debug-login-500-error.md`
5.  **Disclose Hypotheses**: Clearly list 3-5 falsifiable hypotheses in the conversation.
6.  **Instrumentation First**: The first logical change (Diff) to the **existing codebase** must be and only be the instrumentation log reporting logic.

> **📌 Multi-Session Support**: Each debugging session uses a unique semantic `sessionId`, ensuring multiple parallel debugging tasks (in different conversations) do not interfere with each other. The session ID is used for:
> - Debug file naming: `<PROJECT_ROOT>/debug-<sessionId>.md`
> - Log file naming: `<DEBUG_EVIDENCE_DIR>/trae-debug-log-<sessionId>.ndjson`
> - Environment file naming: `<DEBUG_EVIDENCE_DIR>/<sessionId>.env`

---

## Workspace Artifact Location (MANDATORY)

Resolve `PROJECT_ROOT` and `DEBUG_EVIDENCE_DIR` before creating any debugging artifact:

1. Use an explicit user-provided workspace path when available.
2. Otherwise, use the workspace root that contains the primary file or service being debugged.
3. Otherwise, use the only open workspace root.
4. If multiple roots remain possible, request the target workspace path before writing.
5. Resolve `DEBUG_EVIDENCE_DIR` to an absolute, session-specific directory outside every active project, workspace, and development-server watch root. Prefer a tool-provided or operating-system temporary directory, namespaced by workspace and `sessionId`.

All debugging writes and commands must follow these invariants:

- Run debugging commands with `workdir` set to `PROJECT_ROOT`.
- Create the record only at `<PROJECT_ROOT>/debug-<sessionId>.md`.
- Store the high-frequency NDJSON log and env file only under `DEBUG_EVIDENCE_DIR`.
- Pass `DEBUG_EVIDENCE_DIR` as an absolute `--outdir` value. Never pass bare `.dbg` or any directory inside a watched project tree.
- Record the absolute `DEBUG_EVIDENCE_DIR`, log path, and env path in `<PROJECT_ROOT>/debug-<sessionId>.md` and report them to the user.
- Do not modify Vite, webpack, file-watcher, or HMR configuration merely to accommodate debugger artifacts.
- Treat `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger` and its parent installation directories as read-only. Never create logs, env files, records, or temporary artifacts there.
- Do not derive artifact locations from the current shell directory or from the Debug Server script path.

---

## Directory Structure

This Skill consists of the following components:
- `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/SKILL.md`: Core definition, input/output requirements, and key constraints.
- `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/guides/debug-md.md`: Purpose, template, and maintenance specifications for the `debug-<sessionId>.md` file.
- `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/guides/workflow.md`: Detailed 11-step scientific debugging workflow.
- `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/guides/logging.md`: Log reporting strategy, code templates, and event structure.
- `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/guides/debug-server.md`: Startup, API endpoints, environment file, and lifecycle constraints for the Debug Server.
- `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/guides/scenarios.md`: Debugging scenario guides with hypothesis templates.
- `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/examples/few-shots.md`: Correct vs. incorrect examples for common scenarios.

---

## Core Philosophy

Debug using the **Scientific Method**: First propose multiple falsifiable hypotheses, then collect runtime evidence through minimal instrumentation, and finally implement a minimal fix based on that evidence, followed by secondary verification using "post-fix logs." **When post-fix evidence proves the issue is resolved, clean up the instrumentation and debugging environment and exit the Skill without waiting for user confirmation.**

> Goal: Address the "Lazy Fix / Guess-work" issue caused by the Agent's lack of runtime context.

---

## Input (From User)

* Symptoms: Actual vs. Expected
* Reproduction Steps (as precise as possible)
* Environment Information (OS / Node / Browser / Server Environment / Feature Flags)
* Existing Logs/Screenshots/Stacks/Failed Test Cases
* Impact Scope and Regression Window (if applicable)

---

## Output (Assistant MUST produce)

1.  **3–5 Falsifiable Hypotheses**: Each hypothesis should correspond to a specific observation point.
2.  **Change Summary & Operational Suggestions**: After each instrumentation or fix, clearly explain the changes to the user and provide a specific operational path (Cheatsheet/Checklist).
3.  **Evidence-Based Analysis Report**: Reference specific log lines to determine the confirmed/rejected status of each hypothesis.
4.  **Fix Solution & Comparative Conclusion**: Provide a minimal fix Patch and show a comparative proof between `pre-fix` and `post-fix` logs.
5.  **Autonomous Verification Progress**: Drive reproduction and verification with available tools, reporting meaningful progress without pausing for routine confirmation.
6.  **Cleanup Summary**: Automatically clean up all debugging artifacts after post-fix evidence verifies the fix, or when the user explicitly aborts, and produce a summary of the root cause or current findings.
7.  **Evidence Gate Record**: Before any final conclusion, include a non-empty hypothesis table, evidence sources, `progress_status`, and an explicit `CONFIRMED`, `REJECTED`, or `INCONCLUSIVE` conclusion for every hypothesis.

---

## Evidence-Driven Debugging Protocol

To implement the "Evidence-Driven" core philosophy, the Assistant must follow this sequence of actions when handling bugs:

1.  **Observe & Hypothesize**: Before seeing logs, modifying any business code is strictly prohibited. You must first list 3–5 possible causes (hypotheses).
2.  **Instrument & Collect**: The first code modification must be adding instrumentation logs. The purpose is to confirm or falsify the aforementioned hypotheses.
3.  **Determine by Evidence**: Read and analyze logs to determine which hypothesis holds true based on evidence (specific log outputs, stack traces, variable states).
4.  **Minimal Fix**: Implement a minimal scope fix only after evidence clearly points to the root cause.
5.  **Verify & Compare**: After the fix, run again and compare `pre-fix` vs. `post-fix` logs to prove the issue is resolved without introducing new ones.

---

## Debugging Session Record (debug-<sessionId>.md)

This Skill mandates using `<PROJECT_ROOT>/debug-<sessionId>.md` to sync progress. For detailed specifications, refer to `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/guides/debug-md.md`.

---

## Key Constraints (MUST follow)

### Evidence Gate (Core Principle)
**Before obtaining runtime evidence, modifying any business logic is strictly prohibited.**
- Hypotheses must be verified via instrumentation logs, not code inspection alone
- The first code change must be instrumentation, not a fix attempt
- Even "obvious" bugs must be confirmed through evidence

### Autonomous Completion Gate
**Do not use `AskUserQuestion` in this Skill or pause for routine user confirmation.**
- Drive reproduction, evidence collection, fixes, and post-fix verification autonomously whenever the available tools and environment permit
- Keep `debug-<sessionId>.md` open until post-fix evidence proves the issue is resolved, the user explicitly aborts, or the evidence transport stop-loss applies
- Before autonomous cleanup, present a concrete `pre-fix` versus `post-fix` comparison and satisfy the final evidence gate
- If the issue is still reproducible, continue the evidence-driven iteration instead of asking the user whether it is fixed
- If an essential reproduction action is available only to the user, request that action with a concise plain-text message and yield; do not use `AskUserQuestion`

### Instrumentation Rules
- **No Ad-hoc Native Logging**: Never use `console.log` (JS) or `print` (Python). Prefer network reporting to the Debug Server; if it is unavailable, use only the project's existing local structured logging path.
- **Collapsible Regions**: Wrap all instrumentation in `#region debug-point <id>` blocks
- **Minimal Intrusion**: No new util files in business codebase; use inline one-liners
- **Closed-Loop Execution**: After instrumentation or a fix, continue directly into reproduction and evidence collection when the Agent can perform the required actions. Yield only when an essential user-only action is required.
- **Explicit Abort**: If the user asks to stop or abort debugging, clean up all artifacts and summarize progress immediately.

### Evidence Collection Stop-Loss

- **HTTP first**: Start the bundled Debug Server and perform one bounded startup/health/reporting probe, for example no more than 10 seconds total. Do not keep retrying a failed start, port probe, health check, or event submission.
- **Local fallback**: If HTTP collection is unavailable, inspect whether the project already has a usable local log sink that can carry the same instrumentation fields. Reuse that sink; do not create a new collector just to keep this Skill alive.
- **Exit condition**: If neither HTTP nor an existing local log path can capture instrumentation evidence, record `progress_status: blocked`, mark hypotheses as `INCONCLUSIVE`, clean up the debugging artifacts and any started server, then exit this Skill and return the task to the Agent. Do not infer a root cause from missing evidence.
- **No idle shutdown**: Do not configure an idle timeout for the Debug Server. A user pause must not terminate an otherwise usable debugging session. Stop it only during explicit cleanup or the transport-failure exit.

### Autonomous Reproduction Strategy

1. Reproduce the issue with available browser, terminal, test, application, or project-specific tools.
2. After instrumentation or a fix, continue to the next executable step without asking the user for routine confirmation.
3. Determine completion from runtime evidence:
   - **Verified**: The original reproduction now produces the expected behavior, the pre-fix failure signal is absent, and post-fix evidence contains no observed regression. Proceed to cleanup.
   - **Still reproducible**: Update the record, refine hypotheses or instrumentation, and continue the workflow.
   - **Blocked by user-only action**: Explain the exact action and evidence needed in plain text, then yield.
   - **User abort**: Clean up immediately and summarize current findings.

### Few-shot Examples

To ensure the standardization of the debugging process, refer to `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/examples/few-shots.md`.

---

## Logging System (Runtime Evidence Reporting)

To ensure multi-end logs can be analyzed uniformly, follow `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/guides/logging.md` for log reporting.

---

## Debug Server (Runtime Evidence Collection Tool)

This Skill comes with a high-performance, out-of-the-box Debug Server script. For detailed instructions, refer to `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/guides/debug-server.md`.

**Key Features:**
- Writes `<sessionId>.env` to output directory for zero-config instrumentation
- Provides log query API (`GET /logs`, `GET /health`, `DELETE /logs`)
- Supports auto port probing and remote debugging

---

## Workflow

The debugging process strictly follows an 11-step scientific workflow. For detailed steps, refer to `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/guides/workflow.md`.

---

## Quick Start (Recommended)

*   **Server Continuity**: Ensure the Debug Server remains running through `post-fix` evidence collection. Stop it only after verification succeeds, the user aborts, or the transport-failure stop-loss applies.
*   **Transport Stop-Loss**: If the Server cannot be started or cannot receive a probe event after the bounded probe, follow the local-log fallback and exit the Skill when no existing local sink is usable.
*   **Manual Cleanup**: After post-fix evidence verifies the fix in Step 11, manually remove instrumentation and terminate the Server process.
