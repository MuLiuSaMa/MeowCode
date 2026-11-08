## Debugging Session Record (debug-<sessionId>.md)

This file is the single source of truth for debugging progress. Create it at `<PROJECT_ROOT>/debug-<sessionId>.md`, where `PROJECT_ROOT` is the absolute path of the user workspace containing the code being debugged.

> **📌 Naming**: Use semantic identifiers like `login-500-error`, `cart-empty-bug`
>
> **📌 Location**: Resolve `PROJECT_ROOT` before the first write. Never create this file in `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger`, a Skill installation directory, or a directory selected only because it is the current shell working directory.
>
> **📌 Watcher Isolation**: Keep this low-frequency record in `PROJECT_ROOT`, but store NDJSON and env files in an absolute `DEBUG_EVIDENCE_DIR` outside every active workspace and development-server watch root. Record that external path here so the user can locate the evidence.

### Purpose
- **Status Tracking**: `[OPEN]` / `[FIXED]` / `[BLOCKED]`
- **Evidence Chain**: Hypotheses, log evidence, verification conclusions
- **Progress Gate**: Every conclusion records `progress_status` and its evidence source
- **Cleanup Gate**: No cleanup while status is `[OPEN]`; close after successful post-fix verification, explicit user abort, or transport failure with status `[BLOCKED]`

### File Template

```markdown
# Debug Session: [sessionId]
- **Status**: [OPEN] / [FIXED] / [BLOCKED]
- **progress_status**: collecting / analyzed / verified / blocked
- **Issue**: Brief description
- **Evidence Source**: HTTP Debug Server / existing local log path
- **Evidence Directory**: <DEBUG_EVIDENCE_DIR> (if HTTP is active)
- **Debug Server**: http://127.0.0.1:<port>/event (if HTTP is active)
- **Log File**: <DEBUG_EVIDENCE_DIR>/trae-debug-log-<sessionId>.ndjson (if HTTP is active)

## Reproduction Steps
1. ...

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | ... | High/Med/Low | Low/Med/High | Pending/Confirmed/Rejected |

## Log Evidence
[Key log entries]

## Verification Conclusion
[Pre-fix vs post-fix comparison, or the reason for INCONCLUSIVE]

## Final Evidence Gate
- **Evidence Sources**: [paths or log query methods]
- **progress_status**: collecting / analyzed / verified / blocked
- **Hypothesis Conclusions**: Every hypothesis is CONFIRMED, REJECTED, or INCONCLUSIVE
```

### Lifecycle
1. **Create** at Step 1 (before any code changes)
2. **Update** after instrumentation, log analysis, and fix attempts
3. **Close** after post-fix evidence verifies the fix (change status to `[FIXED]`), or after transport failure is recorded (change status to `[BLOCKED]`)
4. **Delete** after final cleanup completes
