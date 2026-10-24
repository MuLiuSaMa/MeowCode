## Few-shot Examples

### Trigger Gate: Symptom Reports Do Not Activate

**❌ Bad:**
> User: Page switching feels a little slow.
> Assistant: This is a runtime performance issue, so I will start `TRAE-debugger`.
>
> *(Violation: A symptom report is not an explicit request to debug or locate the cause.)*

**✅ Good:**
> User: Page switching feels a little slow.
> Assistant: I will inspect the routing and rendering path through the normal task workflow.
>
> Do not load `TRAE-debugger`, generate a debug session, or create artifacts. It may be considered only after the user directly asks to debug, troubleshoot, diagnose, locate the root cause, or collect runtime evidence.

---

### Complexity Gate: Straightforward Problems Stay in the Normal Flow

**❌ Bad:**
> User: Please debug why the submit button does not respond.
> Assistant: The handler is visibly not bound, but I will start the Debug Server and add instrumentation anyway.
>
> *(Violation: The cause is established by straightforward static inspection, so runtime instrumentation is unnecessary.)*

**✅ Good:**
> User: Please debug why the submit button does not respond.
> Assistant: A bounded read-only inspection shows that the button has no handler binding. This is a straightforward static defect, so I will exit `TRAE-debugger` without creating artifacts and handle the correction through the normal task flow.

---

### 0. Specialized Debugging Workflow Takes Priority

**❌ Bad:**
> User: The Settings Skill tab stays blank briefly when opened. Investigate it.
> Assistant: The user explicitly asked to investigate a runtime issue, so I will start `TRAE-debugger`.
>
> *(Violation: Selected the generic fallback without checking available user-authored or product-specific debugging Skills.)*

**✅ Good:**
> User: The Settings Skill tab stays blank briefly when opened. Investigate it.
> Assistant: Loading the generic debugger instructions does not activate that workflow. Before exploring the project or creating any debug artifact, I checked the available Skills, found a user-provided debugging workflow applicable to this investigation, and read its instructions. I will use that workflow instead and will not initialize `TRAE-debugger` artifacts.
>
> The user did not need to name the specialized Skill in this request; an applicable specialized debugging option takes priority automatically.

---

### 1. Evidence First, No Blind Fixing

**❌ Bad:**
> User: Please debug why clicking the submit button has no response.
> Assistant: I guess the `onClick` is not bound. Let me fix it for you.

**✅ Good:**
> User: Please debug an intermittent case where clicking the submit button has no response and static inspection has not identified the cause.
> Assistant: I'll investigate with hypotheses:
> 1. Event not triggered (DOM selector issue)
> 2. Handler throws error
> 3. API call fails
> 
> Let me add instrumentation first to determine which is true.

---

### 2. Post-Selection Bootstrap Protocol

**❌ Bad:**
> User: Please debug the intermittent 500 error on the login page.
> Assistant: Might be a DB timeout. Let me increase the timeout.

**✅ Good:**
> User: Please debug the intermittent 500 error on the login page.
> Assistant: Starting debug session `login-500-error`.
> Created `debug-login-500-error.md` to track progress.
> 
> Hypotheses:
> - A: DB credentials expired → Signal: `Access Denied`
> - B: Connection timeout → Signal: `ETIMEDOUT`
> - C: Pool exhaustion → Signal: `Pool Limit Reached`

---

### 3. Autonomous Completion Gate

**❌ Bad:**
> The patch is applied. Is it fixed now?
> *(Violation: Paused for routine confirmation instead of collecting post-fix evidence.)*

**✅ Good:**
> **Evidence Comparison:**
> - pre-fix: `auth_token` was `undefined`
> - post-fix: `auth_token` correctly loaded
> 
> The original reproduction now passes and the failure signal is absent.
> I marked `debug-auth-token-expired.md` as `[FIXED]`, removed the instrumentation, stopped the Debug Server, and deleted the debugging artifacts.

---

### 4. No Native Logging

**❌ Bad:**
```javascript
console.log("State:", state);
```

**✅ Good:**
```javascript
// #region debug-point A:state-check
fetch("http://127.0.0.1:7778/event", { method: "POST", body: JSON.stringify({ sessionId: "cart-bug", runId: "pre", hypothesisId: "A", msg: "[DEBUG] State", data: state }) }).catch(() => {});
// #endregion
```

---

### 5. Autonomous Post-Fix Verification

**❌ Bad:**
> The fix is applied. Pause and ask the user whether the issue is resolved.

**✅ Good:**
> Re-ran the original reproduction with `runId="post-fix"`.
> The expected behavior is present, the pre-fix failure signal is absent, and no regression appears in the observed path.
> Proceeding to cleanup and the final evidence-based summary.

---

### 6. Remote/Mobile Debugging

**❌ Bad:**
```javascript
fetch("http://127.0.0.1:7777/event", ...)  // Mobile can't access localhost
```

**✅ Good:**
> Started Debug Server in remote mode:
> ```bash
> python3 c:\Users\MuLiu\.trae-cn\builtin_skills\TRAE-debugger/tools/debug-server/python/debug-server.py --remote --session mobile-crash --outdir "<DEBUG_EVIDENCE_DIR>" --clean
> ```
> Server at `http://192.168.1.5:7778/event`
> 
> ```javascript
> // #region debug-point A:init
> fetch("http://192.168.1.5:7778/event", { method: "POST", body: JSON.stringify({ sessionId: "mobile-crash", msg: "App init" }) });
> // #endregion
> ```
