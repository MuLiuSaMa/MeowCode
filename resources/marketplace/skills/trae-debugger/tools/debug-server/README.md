# Log Collector (Debug Evidence Collector)

This directory contains the bundled, dependency-free Python Debug Server and its maintenance reference. It is the runtime evidence collector for the Scientific Debug Loop Skill.

## Core Principle: Prefer Direct Use

**Rewriting these scripts during each debugging session is strictly prohibited.** They have been optimized to support CORS, automatic cleanup, and session isolation.

Run the server with `workdir` set to the absolute user `PROJECT_ROOT` and pass an absolute `--outdir "<DEBUG_EVIDENCE_DIR>"` outside every active workspace and development-server watch root. The Skill installation directory is read-only; never store session logs, env files, or debug records under `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger`. Do not change application watcher configuration merely to accommodate evidence files.

## Priority Rules (MUST follow)

1.  **Prefer Python Template** (`c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/tools/debug-server/python/debug-server.py`): Suitable for the vast majority of Unix/Linux/macOS environments.
2.  **Local Log Fallback**: If the Python server is unavailable or its bounded probe fails, inspect the project for an existing local structured log path. If no usable path exists, exit the Debugger Skill.

## Log Reporting Constraints

- **HTTP preferred**: Report debugging logs to this server via HTTP POST when the bounded startup and probe succeed.
- **Local fallback**: If the server is unavailable, use the project's existing structured logging path when it can preserve the required evidence fields. Never use ad-hoc `console.log` or `print`, and do not create a new collector.
- **Reason**: A stable transport is needed for evidence analysis. If neither HTTP nor an existing local path is usable, exit the Debugger Skill instead of breaking the evidence chain with repeated retries.
- **Form**: Keep instrumentation inline where practical; introducing new util files or collectors is forbidden.

## Design Goals

- **Zero Dependencies**: Uses only Python/Node standard libraries.
- **Robustness**: Supports CORS and prevents lingering debug processes.
- **Temporality**: It is an experimental instrument, not business code.
