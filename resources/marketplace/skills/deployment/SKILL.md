---
name: deployment
description: Deploy and manage supported applications in Trae. Use when the user asks to deploy, publish, redeploy, inspect, pause, resume, delete, cancel, retry, or roll back an application.
description_zh: 在用户要求部署、发布、重新部署、检查、暂停、恢复、删除、取消、重试或回滚应用时使用。
description_en: Deploy and manage supported applications when the user asks to publish, inspect, pause, resume, delete, cancel, retry, or roll back an application.
version: "0.1.17"
---

# Deployment

Use the bundled `trae-deploy` CLI to deploy the current workspace. Keep intent
recognition, project classification, user decisions, and result explanation in this
Skill. Use the CLI for every deployment operation and treat its structured output as the
deployment result.

## Supported Applications

This Skill supports:

- `StaticWeb`: plain static files or a project with a deterministic static output directory.
- `FunctionWeb`: a server-side Node.js application compatible with `nodejs20`.

Stop before creating a site or uploading source when the project cannot satisfy either
contract. State the unsupported runtime or missing project fact explicitly.

## CLI

Resolve the platform launcher relative to this Skill directory:

- Linux and macOS: run `sh "<skill-dir>/scripts/trae-deploy"`.
- Windows: run `cmd.exe /d /s /c call "<skill-dir>\scripts\trae-deploy.cmd"`.

The workflow below refers to the selected command as `<trae-deploy>`. Always invoke the
launcher through the platform shell as shown above so package extraction does not need to
preserve executable permissions. Do not depend on a program with the same name from the
workspace `PATH`.
Do not replace CLI operations with manually constructed HTTP requests.

## References

Read references progressively:

- Read `references/static-web.md` after classifying the project as `StaticWeb`.
- Read `references/function-web-nodejs20.md` after classifying it as `FunctionWeb`.
- Read `references/cli-contract.md` before interpreting CLI JSON, exit codes, or errors.
- Read `references/error-codes.md` whenever the CLI returns a `SERVICE_*` error.
- Do not load application-specific references before classification.

## Core Rules

- When the user asks to deploy, prioritize creating the Deployment. Move from a bounded
  project inspection directly to source preparation and `deployments create`.
- Before deployment, perform only the checks needed to classify the application,
  construct a valid source package and execution config, resolve the Site, and avoid
  uploading credentials or known-invalid input.
- Do not start a local development or preview server, open the application in a browser,
  invoke browser automation, or run local UI, end-to-end, smoke, or network tests before
  deployment unless the user explicitly requests that validation.
- Do not install dependencies, run tests, or run a local build solely to increase
  confidence before deployment. A production build remains required when it is the only
  way to produce the `StaticWeb` files that will be uploaded.
- For `FunctionWeb`, use the deployment service's remote build and runtime as the first
  integration validation. If deployment fails, diagnose the actual structured error and
  relevant deployment log, then make the smallest targeted fix and deploy again.
- Do not investigate hypothetical failures before the first deployment attempt. Do not
  broaden post-failure diagnosis beyond the failed stage unless evidence requires it.
- Treat CLI JSON as the protocol source. Treat stderr as progress text only.
- Treat conversation history as a lookup hint, never as authorization evidence.
- Validate every remembered site ID with `sites get`.
- Do not construct service URLs or upload destinations manually.
- Prepare deployable content before calling the CLI. The CLI does not inspect the project,
  copy source, install dependencies, run builds, or create build and start scripts.
- Keep deployment-only manifests and archives out of the user project.
- If application code is defective, stop deployment, patch the real project through the
  normal file-editing workflow, then prepare a fresh temporary source directory.
- Do not create a second Deployment while the selected site has an active Deployment.
- Do not report success until the deployment service returns a successful terminal state.
- Every CLI command validates deployment access before performing its operation. If a
  command reports that access is unavailable, stop and follow its sign-in or
  project-access instruction.

## Deployment Workflow

### Inspect the Project

Perform one bounded, read-only inspection of the files needed to prepare the deployment:

- `package.json`
- package-manager lock files
- framework configuration
- build and start scripts
- existing deployment scripts
- static entrypoints and candidate output directories
- declared Node.js engine version

Determine:

- project root
- deployment type
- package manager
- build command, when needed
- static output directory, for `StaticWeb`
- start command and listening behavior, for `FunctionWeb`

Stop inspecting once these facts are known. Do not run a build, start the application,
or validate it in a browser during classification.

### Classify the Application

Classify as `StaticWeb` when:

- the project is directly publishable static content with an `index.html`; or
- the existing build produces a deterministic static directory; or
- a framework is explicitly configured for static export.

Classify as `FunctionWeb` when:

- the project requires a server-side Node.js process;
- the production start entry is deterministic;
- the runtime is compatible with `nodejs20`; and
- the effective production listening port can be proven and matched by `runtime.port`.

Ask the user to choose static or dynamic deployment only when both modes are valid and
the repository does not identify the intended production mode.

Reject the project when it requires:

- a non-Node.js dynamic runtime;
- an incompatible Node.js version;
- multiple independently deployed services;
- a required database migration during deployment;
- a background worker outside the web process; or
- an unknown build output or start entry.

### Resolve the Site

If the conversation contains a previously used site ID:

1. Run `sites get --site-id <id>`.
2. Reuse it only when the CLI confirms it belongs to the current project and is accessible.
3. Ignore the remembered ID when validation fails.

Otherwise run:

`sites list`

Apply these rules:

- No site: create one with an explicit access policy using **Resolve Site Visibility** below.
- One site with the same deployment type: reuse it.
- One site without deployment history: reuse it.
- One site with a different deployment type: ask whether to create a new site or reuse
  the existing site and switch its deployment type.
- Multiple sites with exactly one same-type candidate: show that candidate and reuse it.
- Multiple same-type candidates: show their name, URL, type, latest status, and update time,
  then ask the user to choose.
- No same-type candidate: ask whether to create a new site or select an existing site and
  switch its deployment type.

Never select the first list item automatically.

Before reusing a different-type site, restate:

- site name
- current deployment type
- new deployment type
- that the same site URL will switch execution paths

Continue only after explicit confirmation.

### Resolve Site Visibility

Resolve visibility before creating a site or deploying to a reused site. A site URL
alone does not mean the site is public. Always pass `--access-policy` explicitly when
creating a site; do not rely on the bundled CLI's default.

Determine the requested policy from the user's request:

- A request to publish publicly, provide a link to share with other people, or let other
  people open the site without signing in means `public`, unless the user also requests
  restricted access.
- A request for private, owner-only, or restricted access means `private`. The current
  private policy permits only the owner; if the user needs team access, explain this
  limitation and clarify the intended audience.
- A generic request to deploy, publish, or return a URL does not specify visibility.
  For a new site, use `public` and state that the deployed site is publicly accessible.
  For a reused site, preserve its verified policy.
- If the requested audience is unclear or the request contains conflicting visibility
  requirements, ask one concise question before creating the site or changing its policy.

For a new site, always pass the resolved policy explicitly:

`sites create --name <name> --access-policy <public|private>`

Then run `sites get --site-id <id>` and verify `access_policy` against the requested
policy using the enum mapping in `references/cli-contract.md`.

For a reused site, run `sites get --site-id <id>` and inspect `access_policy`. If the user
explicitly requested a different policy, run
`sites update-config --site-id <id> --access-policy <public|private>` and verify with
`sites get`. That explicit visibility request authorizes the change; do not ask again.
Otherwise preserve the policy. Never change visibility solely because a redeployment
is requested. If the policy is unknown or verification fails, resolve that failure
before continuing; do not assume the requested visibility took effect.

### Check Active Deployment

Run:

`deployments list --site-id <site-id>`

If an active Deployment exists:

- do not create a new Deployment;
- show its ID, current stage, status, and creation time;
- offer to wait for it; or
- offer cancellation only when the CLI reports a cancellable stage.

Do not bypass the conflict by changing an idempotency key.

### Prepare the Deployment Directory

Determine the files required to publish, build, and run the selected application. Create a
fresh directory under the operating system temporary directory and copy only those files.
Use a unique directory for every attempt and delete it after upload or failure.

Create `<source-dir>` from the current process's system temporary root. Do not hardcode
`/tmp`: on macOS the CLI usually resolves the system temporary root from `TMPDIR` to a
directory under `/var/folders`, so `/tmp/...` fails validation.

On Linux and macOS, run:

```bash
temp_root="${TMPDIR:-/tmp}"
source_dir="$(mktemp -d "${temp_root%/}/trae-deploy.XXXXXX")"
```

On Windows PowerShell, run:

```powershell
$sourceDir = Join-Path ([System.IO.Path]::GetTempPath()) ("trae-deploy-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $sourceDir | Out-Null
```

Use the returned absolute directory as `--source-dir`. Do not substitute a visually
similar temporary path, create the directory in the workspace, or pass the temporary
root itself.

Always exclude the local workspace's `node_modules`, package-manager caches, VCS metadata,
IDE settings, logs, test reports, coverage, credentials, `.env` files, existing deployment
archives, and unrelated build output. This source-package rule does not exempt a
FunctionWeb build from placing remotely installed production dependencies inside its
configured output directory.

For `StaticWeb`, determine:

- project root;
- existing publishable output, or the production build command and output directory;
- package manager and lock file when a build is required; and
- the non-empty `index.html` entrypoint.

When a build is required, run the repository's production build first. Copy the resulting
static files into `<source-dir>/public/`. When no build is required, copy the directly
publishable files into that directory. Ensure the final entrypoint is
`<source-dir>/public/index.html`.

For `FunctionWeb`, determine:

- project root and `nodejs20` compatibility;
- package manager, lock file, and dependency installation behavior;
- deterministic build and foreground start commands;
- build output directory; and
- the effective application listening port and how the production start path selects it.

Inspect the selected lockfile for dependencies that dispatch to native packages by
operating system, CPU architecture, or libc. Before creating the Deployment, confirm
that the lockfile contains the Linux-compatible optional dependency records required by
the remote build. A successful install on the local platform is not sufficient evidence.
Follow the cross-platform native dependency procedure in
`references/function-web-nodejs20.md`.

For an npm project, inspect `package-lock.json` plus project and workspace `.npmrc`
registry settings before copying the package. Require dependency installation to use
`https://registry.npmjs.org/` explicitly unless the user explicitly requests another
registry. Never infer permission to use a mirror or private registry from local npm
configuration or lockfile contents. Follow the inspection and regeneration procedure in
`references/function-web-nodejs20.md`.

Copy the required FunctionWeb package content directly into `<source-dir>/`. Create
POSIX-compatible executable `build.sh` and `run.sh` there when the project does not
already provide suitable scripts. Do not expect the CLI to generate or correct them.
The runtime starts from `build.output_dir`, not the package root. Ensure `build.sh`
places the executable `runtime.start_script` and every runtime dependency inside that
output directory; a root-only `run.sh` is insufficient. When the runtime entry imports
packages such as `express`, `build.sh` must either produce a verified self-contained
bundle or copy the remotely installed production `node_modules` to
`<output_dir>/node_modules`. Never assume dependencies installed at the package root
remain visible after the runtime artifact is reduced to `build.output_dir`.

Before creating the Deployment, inspect `build.sh` against the runtime entry. If the
entry has external package imports and the script neither bundles those dependencies nor
places production dependencies under `build.output_dir`, correct the adapter script
first. Apply the deterministic package checks in
`references/function-web-nodejs20.md` under **Pre-deployment Artifact Validation** only
to files and existing output already available during source preparation. Do not run a
local build, install dependencies, start the application, or invoke browser automation
to materialize additional evidence. Let the remote build and runtime surface failures
that cannot be established from the prepared source.

Before writing `<execution-config>`, trace `runtime.start_script` through its shell
wrapper, package script, framework configuration, and server entrypoint. Confirm that
`runtime.port` equals the port the production process actually listens on. When the
application reads `process.env.PORT`, set `runtime.port` explicitly and verify that no
wrapper overrides it. When the application uses a fixed port, use that exact value or
patch the real project to consume `PORT`. If the effective port cannot be proven, stop
before `deployments create`; never assume the example or default port is correct.

Write `<execution-config>` using the exact FunctionWeb schema in
`references/function-web-nodejs20.md`. Do not invent fields or copy timeout settings
between the `build` and `runtime` objects.

### Create the Deployment

Run `deployments create` once with:

- selected site ID;
- a concise title describing the purpose of this deployment;
- deployment type;
- prepared source directory; and
- execution config required by the selected deployment type.

Infer the title from the user's request and the change being deployed. The title is
required in this workflow: always pass `--title`, keep it within 256 characters, and do
not ask the user for a title when the deployment purpose is already clear.

For `StaticWeb`, the command scans `public/`, validates the file contract, creates
`manifest.json`, requests upload destinations, uploads the manifest plus static files,
and creates the Deployment.

For `FunctionWeb`, the command validates the prepared package root, creates and uploads
`package.zip`, and creates the Deployment.

If local validation or upload fails, apply the specific recovery below when it matches;
otherwise explain the contract violation and stop. The CLI must not create a Deployment
from a partially validated or partially uploaded source.

If the CLI returns `SOURCE_DIR_OUTSIDE_TEMP`, discard that prepared directory, create a
new one with the platform command above, recopy the package, and retry once. Do not retry
the same path or replace `$TMPDIR` with `/tmp`.

When the failure is caused by application code, patch the user project first, discard the
failed temporary directory, rebuild or recopy from the project, and run create again.
Never patch only the temporary copy.

Record the returned Deployment ID in the conversation state. If the command response is
lost or the CLI exits after an uncertain network result, query the selected site's
Deployment history before attempting another create.

### Query Progress

Run `deployments get --deployment-id <deployment-id>`.

Use the service status as the source of truth. When the Deployment is non-terminal,
preserve its ID and current stage, wait a bounded interval, and call `deployments get`
again. Do not infer completion from elapsed time, query in a tight loop, or create a
replacement Deployment while the original is active.

### Handle Success

After the Deployment reaches the successful terminal state, run:

`sites refresh-screenshot --site-id <site-id>`

This command checks the main site URL before capture. A 2xx or 3xx response proceeds
immediately; a 4xx or 5xx response receives a five-second startup grace period and then
also proceeds so application-defined error responses can still be rendered. It captures
the rendered page through the local screenshot service, uploads the PNG, and updates the
Site metadata.
Treat this as a best-effort post-deployment action. Do not retry, roll back, or change the
successful Deployment result when screenshot refresh fails. Mention the screenshot failure
briefly and continue reporting the deployment as successful.

Return:

- site name and URL
- site ID
- Deployment ID
- deployment type
- final status
- verified visibility: public, or private with access restricted to the owner

Run `sites get --site-id <id>` after deployment and use its verified policy for visibility
in both the response and the card. Do not describe a private URL as publicly accessible
or infer public access from screenshot capture or a successful Deployment. If this
query fails, report the Deployment as successful but visibility as unverified; do not
claim the requested policy was confirmed.

After all requested Deployment outcomes are known, call `show_deployment_card` exactly
once with a complete snapshot for every successful Site in `sites`, preserving deployment
order. Each snapshot must contain:

- `site_id`: the Site ID from CLI structured output
- `name`: the Site name from CLI structured output
- `url`: the absolute HTTP or HTTPS Site URL from CLI structured output
- `visibility`: `private` or `public`, decoded from the CLI `access_policy` enum
- `version`: the Site version when the CLI structured output provides one

Use the latest trusted CLI result from the current workflow. Do not guess a missing
field from conversation text. If a required snapshot field is unavailable, run
`sites get --site-id <id>` and use its structured output before calling the card tool.
For a partial success, include only successful Site snapshots. When no Deployment
succeeded, do not call the card tool. The card is a read-only snapshot: rendering it
must not trigger a Site query, mutate visibility, or change or retry an otherwise
successful Deployment.

Keep the response concise. Do not include internal service details.

### Handle Failure

When the CLI returns a `SERVICE_*` error, match it against
`references/error-codes.md` before replying or choosing a recovery action. Use the
recommended user-facing meaning instead of forwarding the raw service message alone.
Do not automatically replay a write operation unless the table explicitly permits it.

First explain:

- failed stage
- failure code
- failure summary
- whether the failure is retryable

When the structured failure is insufficient:

- query `logs build` for dependency installation, compilation, or artifact failures;
- query `logs deploy` for resource preparation, review, or publication failures;
- query `logs runtime` for FunctionWeb startup or runtime failures.

Each logs command downloads the selected log and returns `data.log_file`. Use the
available file and command tools to inspect that local file:

- search for the failure code, `error`, `failed`, exception names, or the failed stage;
- read bounded context around matching lines;
- inspect the end of the file when startup or build termination failed; and
- use `cat` only when the file is small.

Do not ask the CLI to parse the log. Do not place the full log in model context. Summarize
only relevant lines and redact sensitive values.

Apply a project fix only when the detailed log identifies an actionable project or
deployment-configuration cause. If the log does not reveal one, stop, preserve the site
and Deployment IDs plus the failed stage and failure code, and report that platform
diagnosis is required. Do not retry an unchanged Deployment repeatedly.

Do not automatically retry audit rejection or invalid project configuration.

## Follow-up Operations

### Update Site

Use `sites update` when the user explicitly asks to rename a site or change its
screenshot URI. Use `sites update-config` when the user explicitly asks to change access
policy, compute limits, memory limits, QPS, or daily egress limits. Supply only fields the
user asked to change, then verify the result with `sites get`.
An explicit request to make the existing link public or private is an access-policy
change even when it accompanies a deployment request; follow **Resolve Site Visibility**.

### Redeploy

Reinspect the project, reuse the validated site, prepare a new source directory, create a
new Deployment, and query it with `deployments get` until it reaches a terminal state.

### Retry

Use `deployments retry` only when:

- the CLI marks the failed Deployment as retryable; and
- source and execution configuration are unchanged.

When source or configuration changes, prepare a new source directory and create a new
Deployment.

### Cancel

Cancel only an active Deployment in a cancellable stage. After requesting cancellation,
query the same Deployment until the deployment service confirms its resulting state.

### Roll Back

Show the target historical Deployment and request explicit confirmation before rollback.
Create the rollback through the CLI and query the returned rollback Deployment ID with
`deployments get` until it reaches a terminal state.

## Conversation State

After a validated operation, retain:

- selected site ID and site name
- latest Deployment ID
- deployment type

Revalidate the site before using this state in a later turn.

## Security

- Never ask the user to paste login credentials or temporary upload links.
- Never display secrets or temporary upload details returned by the CLI.
- Never use a generic HTTP client when the bundled CLI supports the operation.

## Response Style

For success, state what was deployed, provide the site URL and Deployment ID, and state
the verified visibility. For a private site, explain that only the owner can access it.

For unsupported projects, state the detected project facts and the exact unsupported
requirement.

For failures, state the failed stage, actionable cause, and next valid action. Avoid
dumping raw CLI JSON or full logs unless the user explicitly asks for them.
