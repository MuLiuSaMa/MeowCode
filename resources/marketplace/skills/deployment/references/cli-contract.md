# Deployment CLI Contract

Use the launcher bundled with this Skill:

- Linux and macOS: `sh "<skill-dir>/scripts/trae-deploy"`
- Windows: `cmd.exe /d /s /c call "<skill-dir>\scripts\trae-deploy.cmd"`

Resolve `<skill-dir>` from the loaded Skill location. This document refers to the selected
command as `<trae-deploy>`. Do not call another executable with the same name from the
workspace `PATH`.

## Output

The CLI writes:

- one JSON result to stdout; and
- short progress messages to stderr.

Parse stdout as the command result. Do not parse progress text as state.

Successful result:

```json
{
  "ok": true,
  "data": {},
  "request_id": "request identifier"
}
```

Build and deploy log commands return a local file descriptor:

```json
{
  "ok": true,
  "data": {
    "log_type": "build",
    "log_file": "/absolute/system-temp/trae-deploy/session/deployment/build.log",
    "size_bytes": 1048576,
    "sha256": "hex digest"
  },
  "request_id": "request identifier"
}
```

Failed result:

```json
{
  "ok": false,
  "error": {
    "code": "STABLE_ERROR_CODE",
    "message": "human-readable summary",
    "retryable": false,
    "details": {}
  },
  "request_id": "request identifier"
}
```

Use `error.code`, `error.retryable`, and structured `details` for decisions. Use
`error.message` for the user-facing summary.

## Exit Codes

| Exit code | Meaning |
|-|-|
| `0` | Command completed successfully |
| `2` | Invalid command input or local source contract |
| `3` | Deployment access is unavailable |
| `4` | The deployment service rejected the operation |
| `5` | Temporary network or service failure |
| `6` | The monitored Deployment reached a failed, cancelled, or timed-out result |

The JSON result is authoritative when both JSON and an exit code are available.

## Commands

Site lifecycle commands:

```text
<trae-deploy> sites pause --site-id ID
<trae-deploy> sites resume --site-id ID
<trae-deploy> sites delete --site-id ID
```

`sites delete` removes the service. The control plane first withdraws any active route
and releases provider resources, then hides the Site target while retaining deployment
history.

### Enum Reference

CLI arguments use the canonical text tokens below. The CLI converts them to the stable
integer codes required by the control plane. Never pass a raw integer to a CLI enum
argument. Repeat list filter flags to select multiple values, for example:

`deployments list --site-id ID --status building --status deploying`

Control-plane JSON fields remain integers. Decode every enum field with this table.
`response-only` means the value can appear in JSON but must not be passed as a CLI
argument. Code `0` is always an unknown compatibility value and is invalid in requests.

| Enum | JSON field | CLI token | Integer | Meaning |
|-|-|-|-|-|
| `DeployType` | `deploy_type` | `response-only` | `0` | Unknown; reject in requests |
| `DeployType` | `deploy_type` | `static-web` | `1` | Static files published from `public/` |
| `DeployType` | `deploy_type` | `function-web` | `2` | Node.js 20 server application |
| `DeployTargetType` | `target_type` | `response-only` | `1` | Site target; currently the only target type |
| `DeployTargetAccessPolicy` | `access_policy` | `response-only` | `0` | Unknown; reject in requests |
| `DeployTargetAccessPolicy` | `access_policy` | `private` | `1` | Only the owner can access the site |
| `DeployTargetAccessPolicy` | `access_policy` | `public` | `2` | Public site access |
| `DeployTargetDisplayStatus` | `display_status` | `response-only` | `0` | Unknown derived target status |
| `DeployTargetDisplayStatus` | `display_status` | `not-deployed` | `1` | Target has no completed deployment |
| `DeployTargetDisplayStatus` | `display_status` | `deploying` | `2` | Target has an active deployment |
| `DeployTargetDisplayStatus` | `display_status` | `online` | `3` | Current release is online |
| `DeployTargetDisplayStatus` | `display_status` | `paused` | `4` | Current release is paused |
| `DeployTargetDisplayStatus` | `display_status` | `offlining` | `5` | Target is being taken offline |
| `DeployTargetDisplayStatus` | `display_status` | `offline` | `6` | Target is offline |
| `DeployTargetDisplayStatus` | `display_status` | `failed` | `7` | Latest target operation failed |
| `DeploymentOperationType` | `operation_type` | `response-only` | `0` | Unknown; reject in filters |
| `DeploymentOperationType` | `operation_type` | `deploy` | `1` | Normal deployment |
| `DeploymentOperationType` | `operation_type` | `rollback` | `2` | Rollback deployment |
| `DeploymentOperationType` | `operation_type` | `offline` | `3` | Offline operation |
| `DeploymentStatus` | `status` | `response-only` | `0` | Unknown; reject in filters |
| `DeploymentStatus` | `status` | `pending-build` | `1` | Waiting to start build processing |
| `DeploymentStatus` | `status` | `building` | `2` | Build stage is running |
| `DeploymentStatus` | `status` | `waiting-deploy-artifact-audit` | `3` | Waiting for source or artifact audit |
| `DeploymentStatus` | `status` | `deploying` | `4` | Resource preparation is running |
| `DeploymentStatus` | `status` | `waiting-url-audit` | `5` | Waiting for deployed URL audit |
| `DeploymentStatus` | `status` | `publishing` | `6` | Publishing the release |
| `DeploymentStatus` | `status` | `offlining` | `7` | Removing the release from service |
| `DeploymentStatus` | `status` | `releasing` | `8` | Releasing provider resources |
| `DeploymentStatus` | `status` | `succeeded` | `9` | Terminal success |
| `DeploymentStatus` | `status` | `failed` | `10` | Terminal failure |
| `DeploymentStatus` | `status` | `cancelled` | `11` | Terminal cancellation |
| `DeploymentStatus` | `status` | `promoting` | `12` | Promoting the prepared resource |
| `DeploymentStageType` | `current_stage`, `stage_type` | `response-only` | `0` | Unknown stage |
| `DeploymentStageType` | `current_stage`, `stage_type` | `response-only` | `1` | Build |
| `DeploymentStageType` | `current_stage`, `stage_type` | `response-only` | `2` | Deploy |
| `DeploymentStageType` | `current_stage`, `stage_type` | `response-only` | `3` | Publish |
| `DeploymentStageType` | `current_stage`, `stage_type` | `response-only` | `4` | Release |
| `DeploymentStageType` | `current_stage`, `stage_type` | `response-only` | `5` | Deploy artifact audit |
| `DeploymentStageType` | `current_stage`, `stage_type` | `response-only` | `6` | URL audit |
| `DeploymentStageType` | `current_stage`, `stage_type` | `response-only` | `7` | Promote |
| `DeploymentTaskStatus` | `tasks[].status` | `response-only` | `0` | Unknown task status |
| `DeploymentTaskStatus` | `tasks[].status` | `response-only` | `1` | Pending |
| `DeploymentTaskStatus` | `tasks[].status` | `response-only` | `2` | Running |
| `DeploymentTaskStatus` | `tasks[].status` | `response-only` | `3` | Reconciling an external job |
| `DeploymentTaskStatus` | `tasks[].status` | `response-only` | `4` | Succeeded |
| `DeploymentTaskStatus` | `tasks[].status` | `response-only` | `5` | Skipped |
| `DeploymentTaskStatus` | `tasks[].status` | `response-only` | `6` | Failed |
| `DeploymentTaskStatus` | `tasks[].status` | `response-only` | `7` | Cancellation requested |
| `DeploymentTaskStatus` | `tasks[].status` | `response-only` | `8` | Cancelled |
| `DeploymentExecutionMode` | `tasks[].execution_mode` | `response-only` | `0` | Unknown execution mode |
| `DeploymentExecutionMode` | `tasks[].execution_mode` | `response-only` | `1` | Stage is skipped |
| `DeploymentExecutionMode` | `tasks[].execution_mode` | `response-only` | `2` | Control-plane internal execution |
| `DeploymentExecutionMode` | `tasks[].execution_mode` | `response-only` | `3` | Provider external job |
| `DeployReleaseStatus` | `serving_status`, `deploy_target_release.release_status` | `response-only` | `0` | Unknown release status |
| `DeployReleaseStatus` | `serving_status`, `deploy_target_release.release_status` | `response-only` | `1` | Online |
| `DeployReleaseStatus` | `serving_status`, `deploy_target_release.release_status` | `response-only` | `2` | Paused |
| `DeployReleaseStatus` | `serving_status`, `deploy_target_release.release_status` | `response-only` | `3` | Offlining |
| `DeployReleaseStatus` | `serving_status`, `deploy_target_release.release_status` | `response-only` | `4` | Offline |
| `DeployResourceType` | `resource_type` | `response-only` | `0` | Unknown resource snapshot |
| `DeployResourceType` | `resource_type` | `response-only` | `1` | Audit resource snapshot |
| `DeployResourceType` | `resource_type` | `response-only` | `2` | Production resource snapshot |
| `DeployConfigApplyStatus` | `config_apply_status` | `response-only` | `0` | Unknown config application status |
| `DeployConfigApplyStatus` | `config_apply_status` | `response-only` | `1` | Desired config is applied |
| `DeployConfigApplyStatus` | `config_apply_status` | `response-only` | `2` | Desired config requires redeployment |
| `DeploymentAuditGateType` | `audit_gates[].gate_type` | `response-only` | `0` | Unknown audit gate |
| `DeploymentAuditGateType` | `audit_gates[].gate_type` | `response-only` | `1` | Source or artifact audit gate |
| `DeploymentAuditGateType` | `audit_gates[].gate_type` | `response-only` | `2` | Deployed URL audit gate |
| `DeploymentAuditDecision` | `audit_gates[].decision` | `response-only` | `0` | Unknown audit decision |
| `DeploymentAuditDecision` | `audit_gates[].decision` | `response-only` | `1` | Pending |
| `DeploymentAuditDecision` | `audit_gates[].decision` | `response-only` | `2` | Approved |
| `DeploymentAuditDecision` | `audit_gates[].decision` | `response-only` | `3` | Requires manual review |
| `DeploymentAuditDecision` | `audit_gates[].decision` | `response-only` | `4` | Rejected |
| `DeploymentAuditDecision` | `audit_gates[].decision` | `response-only` | `5` | Audit execution failed |
| `DeploymentAuditDecision` | `audit_gates[].decision` | `response-only` | `6` | Audit result expired |
| `DeploymentAuditDecision` | `audit_gates[].decision` | `response-only` | `7` | Gate skipped |

### Sites

- `sites list [--current-session] [--page-no PAGE_NO] [--page-size PAGE_SIZE] [--access-policy POLICY] [--display-status STATUS]`
- `sites quota`
- `sites get --site-id ID`
- `sites create --name NAME [--access-policy POLICY]`
- `sites update --site-id ID [--name NAME] [--screenshot-uri URI]`
- `sites update-config --site-id ID [--access-policy POLICY] [--cpu-millicores VALUE] [--memory-bytes VALUE] [--qps-limit VALUE] [--daily-egress-limit-bytes VALUE]`
- `sites refresh-screenshot --site-id ID`

### Deployments

- `deployments list --site-id ID [--page-no PAGE_NO] [--page-size PAGE_SIZE] [--status STATUS] [--operation OPERATION] [--type TYPE]`
- `deployments get --deployment-id ID`
- `deployments create --site-id ID [--title TITLE] --type TYPE --source-dir DIR --execution-config FILE`
- `deployments cancel --deployment-id ID`
- `deployments retry --deployment-id ID`
- `deployments rollback --site-id ID --deployment-id ID`

### Logs

- `logs build --deployment-id ID`
- `logs deploy --deployment-id ID`
- `logs runtime --site-id ID [--since DURATION | --start-time-ms TIMESTAMP] [--end-time-ms TIMESTAMP] [--keyword TEXT] [--stream stdout|stderr] [--limit LIMIT] [--cursor CURSOR]`

## Command Rules

Every command validates the trusted project context and deployment access before
performing its operation. When this preflight fails, the command returns exit code `3`
and a structured error. Stop and follow the CLI's user-facing sign-in or project-access
instruction.

### sites list

Use when no validated site ID is available. The response contains `page_no`, `page_size`,
and `total_pages`. Increment `page_no` until the current page reaches `total_pages`.
`--access-policy` and `--display-status` are repeatable and accept only the canonical
tokens in the enum table.

Without an explicit scope option, the CLI lists Sites in the current project. The shared
default Project is the exception: it lists only Sites created by the current chat
session so Sites from unrelated sessions are not mixed into the result.

Use `--current-session` to explicitly list only Sites created by the current chat
session, regardless of whether the current Project is shared or ordinary.

`--all` lists every Site visible to the current account across Projects and sessions.
The option is intentionally hidden from CLI help. Never use it autonomously. Use it
only when the user explicitly requests an all-Site view; otherwise explain that it
broadens the query beyond the current Project and session, then obtain explicit user
confirmation before invoking it. `--all` and `--current-session` are mutually exclusive.

### sites quota

Returns the current account's active Site count, effective Site limit, and remaining
creatable count. `current_count` includes active Sites from every Project and session,
so it can be greater than the number returned by the default project- or session-scoped
`sites list`.

### sites get

Use before reusing a site remembered from conversation history.

### sites create

`--access-policy` accepts `private` or `public`. Omit it to use the service default
`private` policy.

### sites update

Requires at least one of `--name` or `--screenshot-uri`. The name must contain 1 to 128
characters. Pass an empty `--screenshot-uri` value to clear the current screenshot.

### sites update-config

Requires at least one config option. `--access-policy` accepts `private` or `public`.
Numeric limits must be positive. Omitted fields retain their current desired values.
Resource or route changes can require a redeployment before the effective configuration
matches the desired configuration.

### sites refresh-screenshot

Requires an Online Site with a main visit URL and an available local screenshot service.
The command sends the runtime authorization and lane headers while probing the URL. A 2xx
or 3xx response proceeds immediately. A 4xx or 5xx response is retried for up to five
seconds and then proceeds to capture, because the application may intentionally render an
error response. If no HTTP response is received during that period, the command fails with
`SITE_NOT_READY`. It captures a 1440-pixel-wide PNG, uploads it through a
control-plane-issued destination, updates `screenshot_uri`, and removes the temporary local
image. Run it only after a Deployment reaches `Succeeded`.

This is a best-effort post-deployment operation. A non-zero result does not change the
successful Deployment status and must not trigger a deployment retry or rollback.

### deployments list

The response contains `page_no`, `page_size`, and `total_pages`. Increment `page_no`
until the current page reaches `total_pages`. `--status`, `--operation`, and `--type`
are repeatable and accept only the canonical tokens in the enum table.

### deployments create

Consumes an already prepared source directory. The directory must be under the operating
system temporary directory and must not be the user project or a directory inside it.
`--title` is optional at the CLI compatibility layer, accepts at most 256 characters,
and describes the purpose of this deployment. The deployment Skill always supplies it.

The CLI canonicalizes both `--source-dir` and the temporary root returned by the current
process runtime. These paths must have an ancestor relationship after canonicalization.
On macOS, `$TMPDIR` commonly points under `/var/folders`; a hardcoded `/tmp/...` is
therefore outside the accepted root. Create the source directory with the platform
command in `SKILL.md`, pass the returned absolute path unchanged, and never pass the
temporary root itself.

For `static-web`, the input contains `public/`. The command validates paths, file count,
total size, `public/index.html`, symbolic links, and high-risk files. It then generates
`manifest.json`, obtains batch upload destinations, and uploads the manifest plus every
declared `public/**` file.

For `function-web`, the input root contains the complete package content, including
`build.sh`, `run.sh`, package metadata, lock file, source, and required runtime files. The
command validates the package contract, creates deterministic `package.zip`, obtains an
upload destination, and uploads the archive. Package validation confirms the root
adapter scripts, but it cannot execute the remote build. The runtime later starts from
`build.output_dir` and resolves `runtime.start_script` relative to that directory, so
`build.sh` must place an executable start script and all runtime dependencies in the
configured output directory. Exclude the local workspace's `node_modules` from the
uploaded source package, but do not exclude remotely installed dependencies from the
runtime artifact: when the runtime entry imports external packages, the build must
either emit a self-contained bundle or place production dependencies under
`<output_dir>/node_modules`.

The StaticWeb execution config must be `{}`. The FunctionWeb execution config has
`schema_version=1` plus optional `build` and `runtime` objects. The control plane applies
its current defaults to known omitted fields:

- build: `runtime_key=nodejs20`, `build_script=build.sh`, `output_dir=dist`,
  `timeout_seconds=3600`;
- runtime: `runtime_key=nodejs20`, `start_script=run.sh`, `port=8000`;
- both: empty `environment` and `secret_refs`.

Unknown fields are ignored rather than forwarded. Build `timeout_seconds` is valid only
inside `build`; runtime has no timeout field. See `function-web-nodejs20.md` for the
canonical JSON.

Only after every upload succeeds does the CLI call the control plane to create the
Deployment. The CLI must not inspect the project, choose files, copy source, install
dependencies, run build commands, or generate build and start scripts. Upload
destinations remain in memory and are never returned.

Call once for one source directory and site decision. Record the returned Deployment ID
before querying its progress.

`SOURCE_DIR_OUTSIDE_TEMP` is a pre-upload local validation failure. Discard the prepared
directory, create a new directory from the current process's system temporary root,
recopy the same package, and retry once. Do not retry the rejected path.

When the response is uncertain because of a connection failure, query Deployment history
before creating another Deployment.

### deployments get

Use the service response as the source of truth. When the Deployment is non-terminal,
preserve its ID and current stage, wait a bounded interval, and call `deployments get`
again. Do not query in a tight loop or infer completion from elapsed time.

### deployments retry

Use only when `retryable` is true and source plus execution configuration are unchanged.

### deployments rollback

Requires a historical successful Deployment and explicit user confirmation.

### logs build and logs deploy

Select the log type from the failed stage. The CLI requests a short-lived download
descriptor, downloads the object to a session-isolated system temporary directory,
verifies the expected size and SHA-256, and returns the absolute path as `data.log_file`.

The CLI must:

- stream to an incomplete file and atomically rename only after verification;
- remove partial files after failed or interrupted downloads;
- restrict the file to the current user;
- keep the presigned URL in memory only;
- omit the URL from stdout, stderr, metadata, and errors; and
- never forward deployment-service credentials or routing headers to object storage.

Inspect `data.log_file` with available file or command tools. Search first, read bounded
context around matches, and inspect the file tail when useful. Do not load the full file
into model context unless it is small.

### logs runtime

Runtime logs are returned inline as `data.items`; each item contains `timestamp_ms`,
`content`, `stream`, and `revision_number`. The response also contains `next_cursor` and
`query_start_time_ms`. It does not create a local log file.

The default window is the previous hour. `--since` accepts a positive integer followed
by `ms`, `s`, `m`, `h`, or `d`. Use `--start-time-ms` for an exact lower bound;
`--since` and `--start-time-ms` are mutually exclusive. `--end-time-ms` sets an exact
upper bound. `--keyword` filters log content, `--stream` accepts only `stdout` or
`stderr`, and `--limit` accepts `1` through `100`. A keyword must not exceed 256 bytes
or contain control characters. A cursor must not exceed 4096 bytes.

When `next_cursor` is non-empty, request the next page with the same filters and time
bounds. Pass the returned `query_start_time_ms` as `--start-time-ms` together with
`--cursor`; do not recompute a relative `--since` window. If the first request included
`--end-time-ms`, preserve it for every page. Stop when `next_cursor` is empty.

## Retry Behavior

Retry read operations after temporary failures with bounded backoff.

Do not independently repeat a create command after an uncertain response. Resolve the
operation by querying the relevant site or Deployment first.

Do not use `deployments retry` after changing source or execution configuration.

## Temporary Files

Store prepared source directories, command JSON, and downloaded logs in a
temporary working directory outside the user's project. Delete workflow files after use.
Harness cleans the session directory when the session ends.

Do not commit prepared sources, command output, or downloaded logs to the
user's project.

## Security

- Do not ask the user for credentials or service connection settings.
- Do not print secrets or temporary upload details.
- Do not pass arbitrary request bodies or service URLs to the CLI.
- Do not replace a supported CLI command with a generic HTTP request.
- Do not persist full logs unless the user explicitly requests a diagnostic artifact.
- Do not expose presigned log URLs or forward service authorization to object storage.
- Do not write manifests or archives to the user project.

## User-Facing Errors

For local validation errors, report the invalid project requirement and the affected
relative path when available.

For rejected operations, report the stable error code, summary, and valid next action.

For temporary failures, preserve the site and Deployment IDs needed to resume safely.

For terminal deployment failures, report the failed stage before querying additional
logs.

## Diagnostic Command

### check

`check` validates the runtime context and login, then performs a bounded site-list
request. Its output contains summarized check status and a request ID, without
credentials, identity values, site data, or service addresses.
