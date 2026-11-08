## Debug Server (Runtime Evidence Collection Tool)

This Skill provides a Python-based Debug Server script.

> **⚠️ MUST use the exact script path below. Do NOT invent commands like `npx trae-debugger` or `trae-debug-server` — they don't exist.**

### Startup

Resolve `PROJECT_ROOT` to the absolute path of the user workspace containing the code being debugged. Resolve `DEBUG_EVIDENCE_DIR` to an absolute, session-specific temporary directory outside every active workspace and development-server watch root. Run the command with `workdir` set to `PROJECT_ROOT`. The Skill installation directory is read-only and must never receive session artifacts.

```bash
# Local Debugging
python3 c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/tools/debug-server/python/debug-server.py --session <sessionId> --outdir "<DEBUG_EVIDENCE_DIR>" --clean

# Remote/Mobile Debugging (Auto-detect IP)
python3 c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/tools/debug-server/python/debug-server.py --remote --session <sessionId> --outdir "<DEBUG_EVIDENCE_DIR>" --clean
```

`<DEBUG_EVIDENCE_DIR>` is a placeholder that must be replaced with an absolute path before execution. Prefer a tool-provided or operating-system temporary directory namespaced by workspace and `sessionId`. Do not pass bare `.dbg`, place evidence inside a watched project tree, derive the output directory from `c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger`, or rely on the shell's current directory.

**❌ Wrong (do NOT use)**:
```bash
npx trae-debugger start --session xxx        # Does not exist
trae-debug-server --session xxx              # Does not exist
node debug-server.js --session xxx           # Does not exist
```

**Parameters**:
- `--session`: **Required.** Semantic session ID (e.g., `login-500-error`)
- `--outdir`: **Required by this Skill.** Must be the absolute external path `<DEBUG_EVIDENCE_DIR>`
- `--clean`: Clear existing logs for this session on startup
- `--idle`: Optional auto-exit after N seconds of inactivity (default: 0 = never); do not set it for this Skill
- `--port`: Starting port (default: 7777, auto-probes if occupied)
- `--remote`: Listen on `0.0.0.0` and show local IP for mobile/remote access

### Core Features

- **Zero Dependencies**: Uses Python standard library only
- **CORS Support**: Allows browser-side reporting
- **Auto Port Probing**: Tries next port if occupied (up to 10 retries)
- **Environment File**: Writes `<sessionId>.env` for zero-config instrumentation

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/event` | Submit log event |
| `GET` | `/health` | Health check (status, uptime, log count) |
| `GET` | `/logs` | Get all logs (`?last=N`, `?hypothesisId=A`, `?runId=pre`) |
| `DELETE` | `/logs` | Clear logs for current session |

### Environment File

On startup, the server writes `<DEBUG_EVIDENCE_DIR>/<sessionId>.env`:

```
DEBUG_SERVER_URL=http://127.0.0.1:<port>/event
DEBUG_SESSION_ID=<sessionId>
```

Instrumentation code can read this file to auto-configure.

### Lifecycle

- **Start**: At workflow Step 3, before instrumentation. Start it once from `PROJECT_ROOT`, pass the absolute external `DEBUG_EVIDENCE_DIR`, and perform one bounded startup/health/reporting probe, for example no more than 10 seconds total.
- **During**: If the probe succeeds, keep it running throughout the debugging session, including post-fix verification. Do not use an idle timeout.
- **Stop**: After post-fix evidence verifies the fix (Step 11), when the user explicitly aborts, or immediately when the HTTP transport fails and the local-log fallback is unavailable.
- **Security**: `--remote` exposes to local network; use in trusted environments only

### Troubleshooting

| Symptom | Solution |
|---------|----------|
| `Port occupied` loops | Kill process: `lsof -i :7777` then `kill <PID>` |
| `python3: command not found` | Install Python 3.6+ |
| Mobile can't connect | Use `--remote` mode |
| No logs received | Verify URL matches server output |

### Fallback

If Python is unavailable, the server cannot start, or the probe cannot receive an event, do not keep retrying and do not create another collector just to preserve this workflow. Inspect whether the project already has a local structured logging path that can carry the same instrumentation fields. If such a path exists, use it and record its log file or query command as the evidence source. If no usable local path exists, record `progress_status: blocked`, mark the hypotheses `INCONCLUSIVE`, clean up the debug artifacts, stop any started server, and exit this Skill so the Agent can choose another approach.

If writing evidence causes Vite, webpack, HMR, or another file watcher to reload the target application, the run is contaminated and must not be used as business evidence. Stop the server, discard that run, select a new `DEBUG_EVIDENCE_DIR` outside the watch root, restart the affected runtime once, and collect a fresh run. Do not change application watcher configuration solely for this debugging session.
