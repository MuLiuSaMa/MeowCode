---
name: TRAE-security-review
description: 用于代码安全扫描，或用户要求对 MR/PR、commit、分支、代码差异或未提交变更执行安全审查、漏洞扫描或安全审计时使用。只报告可证实可利用且由本次变更引入的风险。不得用于通用代码审查、普通编码、功能实现或修复请求，也不得用于运行时故障排查。
---
## 0. Operating Principles (Non-negotiable)

These rules govern every finding. A finding that violates any rule MUST be dropped.

- **Right-side line numbers only.** Every location refers to lines as they appear *after* the change. Pre-change line numbers are invalid.
- **Range form `[L_start, L_end]`.** A single-line issue collapses to identical start/end.
- **Diff-introduced surface only.** A weakness that already existed before this change set and was not touched is out of scope.
- **Reportable ⇔ Demonstrably exploitable.** If you cannot articulate (a) where attacker-controlled input enters and (b) where it reaches a dangerous sink or boundary, do not report.
- **Excluded by default:** availability/DoS, throttling, code style, anything confined to test/fixture code.
- **Confidence floor = 0.8.** Below that → drop, or hand off to downstream filtering / human review.
- **No patches.** Identify and explain. Do not write replacement code in the report.

---

## 1. Scope Resolution

Before reading any diff, the scope of review must be unambiguous.

### 1.1 If the user already specified a scope
Use it verbatim — never broaden or narrow it.

### 1.2 If the scope is missing or ambiguous
Prefer the `AskUserQuestion` tool with these four options:

1. Uncommitted / staged changes in the current workspace
2. Diff against a named branch (ask for the branch name)
3. A specific MR / PR (ask for the identifier)
4. A given list of files (ask for the paths)

If `AskUserQuestion` is unavailable, ask the same four options as numbered plain text.

### 1.3 Default fallback
If the user declines to specify and asks you to proceed, audit the **branch-vs-`origin/HEAD`** delta using the data-collection chain in §2.

---

## 2. Diff Data Collection

Run the following four probes — they are the authoritative input for the audit. Each probe is wrapped so it can be embedded into the working buffer.

| Probe | Command | Purpose |
|---|---|---|
| Working tree state | ``!`git status` `` | Detect untracked / staged anomalies |
| Touched files | ``!`git diff --name-only origin/HEAD...` `` | Enumerate the file surface |
| Commit timeline | ``!`git log --no-decorate origin/HEAD...` `` | Reconstruct intent across commits |
| Authoritative diff | ``!`git diff --merge-base origin/HEAD` `` | The single source of truth for change content |

The diff produced by the last probe is the **only** authoritative change content. Inline snippets in chat are advisory; the diff overrides.

### 2.1 Probe failure cascade
If the merge-base diff fails, walk down this list and stop at the first success:

1. `git diff origin/HEAD...`
2. `git diff HEAD~1`
3. `git diff` (workspace)
4. Re-prompt the user via `AskUserQuestion` for an explicit scope.

If a single auxiliary tool (e.g. `SearchCodebase`) is intermittently unavailable, continue with the rest and explicitly mark conclusions as evidence-bounded.

---

## 3. Context Acquisition (Mandatory before any finding)

Snippet-only reasoning is forbidden. Every candidate finding must be backed by repository-level evidence collected in this order:

1. Confirm scope (§1).
2. Collect diff + commits (§2).
3. Use `SearchCodebase` to locate (a) input entry points / trust boundaries, (b) existing sanitizer / validator / authZ helpers in the project.
4. Use `Read` to inspect the **full** body of touched files plus the relevant call-chain neighbors.
5. Only after the above is complete, draft findings.

For each candidate finding, you must collect:

- **Source-side evidence** — concrete attacker-controlled entry on the execution path.
- **Sink-side evidence** — the dangerous operation, security boundary crossing, or sensitive-data exposure that the input reaches.
- **Bypass-context evidence** — whether nearby code already sanitizes / encodes / validates / authorizes; whether existing project helpers neutralize the issue.

If either *source-side* or *sink-side* cannot be substantiated from repository code, the finding is dropped.

---

## 4. Author-Intent Reconstruction

Before classifying anything as a vulnerability, infer **why the author wrote this diff**. The pattern of edits often disambiguates intent:

- New error handling / null-guards → defensive refactor, raise the bar for "missing-validation" findings.
- Algorithm or data-structure swap → behavior change; check invariants of callers.
- Dependency bump + adapter glue → API-shape migration; check if old security assumptions still hold.
- Variable / module rename → low semantic change; usually no security delta.

Hold the inferred intent as a one-sentence summary and use it as a tie-breaker when a candidate finding is ambiguous: a finding that contradicts a clearly defensive intent likely needs more evidence, not less.

---

## 5. Vulnerability Surface

Audit only the categories below. Each category lists the patterns that count; anything not in the list is out of scope unless it composes one of these.

### 5.1 Untrusted-input handling
- SQL injection through unsanitized values.
- OS command injection in subprocess / shell-out paths.
- XML external entity (XXE) in XML parsers.
- Server-side template injection.
- NoSQL query injection.
- Path traversal in filesystem operations.

### 5.2 AuthN / AuthZ defects
- Authentication bypass via flawed predicate logic.
- Vertical / horizontal privilege escalation.
- Broken session lifecycle: fixation, reuse-after-logout, missing rotation.
- JWT misuse: weak secret, `alg=none`, missing `aud` / `iss` / `exp` checks.
- Object-level access gaps (IDOR-class).

### 5.3 Crypto & secret handling
- Hardcoded keys / passwords / tokens in source.
- Use of broken or weakened algorithms (MD5, SHA1, ECB, RC4, …).
- Insecure key persistence or transport.
- Predictable randomness in security contexts (`Math.random`, non-CSPRNG).
- Disabled or stubbed certificate validation.

### 5.4 Code execution & injection
- Remote code execution via unsafe deserialization (`pickle`, `ObjectInputStream`, …).
- YAML loaders that instantiate arbitrary types (`yaml.load` without `SafeLoader`).
- `eval` / `Function` / `exec` over untrusted strings.
- XSS — reflected / stored / DOM — in web surfaces (subject to the framework carve-outs in §8).

### 5.5 Sensitive-data exposure
- Secrets, credentials, or PII written to logs or persistent stores.
- Endpoint responses returning more than the consumer should see.
- Debug / stack / build-info leakage on production paths.

> Local-network-only exploitability does **not** lower severity. A local-only RCE is still HIGH.

---

## 6. Audit Procedure

Three passes, in order. Do not interleave.

**Pass A — Project security baseline.** Identify the project's existing security primitives: which validators, escapers, ORMs, auth middleware, crypto wrappers are already in use. The project's *own* patterns are the comparison baseline.

**Pass B — Deviation map.** For each touched file, ask: does the new code use the project's established primitives, or does it introduce a fresh, ad-hoc handling that bypasses them? Deviations are the highest-yield finding generators.

**Pass C — Source-to-sink trace.** For each suspicious site, trace the control / data flow:
- where the value enters,
- which boundaries it crosses,
- whether any encoding / validation / authZ check exists on the path,
- where it lands.

Anything that does not survive Pass C is dropped.

---

## 7. Severity & Confidence

### 7.1 Severity bands

| Severity | Trigger |
|---|---|
| **HIGH** | Directly exploitable: RCE, authN bypass, large-scope data breach, vertical privilege escalation. |
| **MEDIUM** | Exploitable under specific but realistic conditions, with material impact. |
| **LOW** | Defense-in-depth gap with marginal direct impact. Reported only when the chain is concrete. |

### 7.2 Confidence

| Range | Meaning | Action |
|---|---|---|
| 0.90 – 1.00 | Concrete attack path, end-to-end traceable in this repo. | Report. |
| 0.80 – 0.89 | Recognized vulnerable pattern, prerequisites plausibly satisfiable. | Report. |
| 0.70 – 0.79 | Suspicious shape, prerequisites speculative. | **Drop.** |
| < 0.70 | Speculative. | **Drop.** |

> Bias toward false negatives. Missing a borderline finding is preferable to flooding the report; a noisy report destroys reviewer trust faster than a missed defense-in-depth issue.

---

## 8. Hard Exclusions (never report)

These are not waivable on a per-finding basis.

### 8.1 Out of scope by category
- Availability: DoS, resource exhaustion, throttling gaps, memory / CPU pressure.
- Outdated third-party dependencies (handled by separate tooling).
- Findings inside documentation files (`*.md`, design docs, RFCs).
- "Missing audit log" / "missing hardening" — neither is, on its own, a vulnerability.
- Findings confined to unit-test or fixture code.
- Race / TOCTOU patterns without a concrete reachable path.
- Regex injection and ReDoS in any form.
- Log entries containing un-sanitized user input ("log spoofing"); only secrets / credentials / PII in logs qualify.
- Including user-controlled content inside an AI system prompt.
- SSRF where only the URL **path** is controllable; SSRF counts only when host or protocol is influenceable.

### 8.2 Framework & language carve-outs
- React / Angular / Vue are XSS-safe by default. A finding requires an explicit escape hatch — `dangerouslySetInnerHTML`, `bypassSecurityTrust*`, `v-html`, or equivalent.
- Missing authN / authZ in client-side JS / TS is **not** a vulnerability; those checks live on the server.
- Memory-safety issues (buffer overflow, UAF, double free) in memory-safe languages (Rust, Go, managed JVM/CLR/JS) are not reported.
- Command injection in shell scripts is unreachable by default; require a demonstrable untrusted-input entry point.
- Findings in `*.ipynb` are unreachable by default; same evidence bar as shell scripts.
- Environment variables and CLI flags are trusted inputs — any chain that depends on attacker-controlled env / flags is invalid.
- UUIDs are unguessable; do not flag missing UUID validation.
- GitHub Actions workflow issues require an explicit untrusted-trigger path before being reportable.

### 8.3 Subtle web bugs
Tabnabbing, XS-Leaks, prototype pollution, open redirect — only if the exploit chain is high-confidence and end-to-end visible in the diff. Default to drop.

### 8.4 Logging precedents
- Logging URLs is safe.
- Logging non-PII business values is safe even if the value "feels" sensitive.
- Only log entries exposing secrets / credentials / PII are reportable.

---

## 9. Output

### 9.1 Clean diff
If nothing survives §3 → §8, emit a single-line summary:

> ✅ No exploitable issues found in the reviewed change set.

### 9.2 Findings table
Otherwise, output exactly one table:

| # | Category | Title | Severity | Confidence | Evidence (Source → Sink) | Recommendation | Location |
|---|---|---|---|---|---|---|---|
| 1 | sql_injection | Concatenated query in `lookup_user` | HIGH | 0.92 | `req.query.q` (router L17) → string concat → `db.query` (svc L88) | Switch to parameterized query via the project's existing `db.safe_query` helper | [`services/user.py:[80, 95]`](file:///abs/path/services/user.py#L80-L95) |

Column rules:

- **Category** uses the snake_case taxonomy from §5 (e.g. `xxe`, `idor`, `unsafe_deserialization`, `weak_crypto`).
- **Severity** ∈ {HIGH, MEDIUM, LOW} per §7.1.
- **Confidence** is the numeric value, two decimals.
- **Evidence** must encode both source and sink; "→" separates them.
- **Location** uses the right-side line range and the `file:///…#Lstart-Lend` link form.
- **Recommendation** is prose, not code. No patches.

Findings are ordered by severity desc, then confidence desc.

---

## 10. Final Self-Check (before emitting the table)

Run this checklist; remove any row that fails any item.

1. Does the row's location use **post-change** line numbers?
2. Is the issue **introduced or worsened by this diff**, not pre-existing-and-untouched?
3. Are both **source** and **sink** present in the Evidence cell?
4. Is the Confidence ≥ 0.80?
5. Does the row survive every Hard Exclusion in §8?
6. Is the Recommendation prose only, with **no code patch**?

If any answer is "no", drop the row before output.
