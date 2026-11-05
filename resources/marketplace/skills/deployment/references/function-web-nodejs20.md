# Function Web Deployment with Node.js 20

Use this reference after the project has been classified as `FunctionWeb`.

## Eligibility

A project is eligible when:

- it runs as one server-side Node.js web process;
- its runtime is compatible with `nodejs20`;
- its production build and start commands are deterministic;
- its effective production listening port can be proven and matched by `runtime.port`;
- it does not require a separate worker or deployment-time database migration.

Reject projects that require another language runtime, multiple independently deployed
services, or an unknown production entrypoint.

## Inspect

Read:

- `package.json`
- the package-manager lock file
- project and workspace `.npmrc` registry settings that can affect dependency resolution
- the declared Node.js engine range
- framework configuration
- build and start scripts
- server entrypoints
- existing `build.sh` and `run.sh`
- the expected build output directory

Determine:

- package manager
- dependency installation behavior
- configured package registry and lockfile dependency hosts
- build command
- runtime start command
- output directory
- the effective application listening port and every configuration or wrapper that can
  override it

Do not classify a project as FunctionWeb only because it has a `package.json`.

## Runtime Requirements

The application must:

- run on Node.js 20;
- start one foreground process;
- listen on the configured `runtime.port`, preferably by consuming `PORT`;
- bind to an interface reachable by the runtime;
- keep running after startup; and
- exit non-zero when startup fails.

The process must not daemonize or depend on an interactive terminal.

## Adapter Scripts

Use `build.sh` and `run.sh` at the prepared package root. Create them in the temporary
source directory from the detected build and start commands when the project does not
already provide suitable scripts. The CLI validates these files but never generates or
corrects them.

Both scripts must:

- start with `#!/bin/sh`;
- use POSIX `sh` syntax;
- avoid `bash`, arrays, `[[ ... ]]`, and `pipefail`;
- avoid machine-specific absolute paths; and
- preserve executable permissions.

`build.sh` must produce the configured output directory deterministically. The runtime
uses that output directory as its working root and resolves `runtime.start_script`
relative to it. Before deployment, ensure the build creates an executable
`<output_dir>/<start_script>` and copies every file needed at runtime into
`<output_dir>`. A `run.sh` that exists only at the package root passes local package
validation but is not automatically included in the built runtime artifact.

The uploaded source package must not contain the local workspace's `node_modules`.
Dependencies are installed by the remote build instead. After installation, `build.sh`
must make the runtime artifact complete using one of these explicit strategies:

- produce a self-contained or framework standalone bundle that includes every external
  runtime dependency; or
- copy the remotely installed production dependencies to
  `<output_dir>/node_modules`.

The runtime artifact contains only `build.output_dir`. Node.js cannot resolve packages
from the package root after that boundary is applied. If the runtime entry contains
`require("express")`, `import ... from "express"`, or any other external package import,
leaving `node_modules` only at the package root will fail startup with
`MODULE_NOT_FOUND`.

For a self-contained application with no external runtime packages,
`output_dir=dist` and `start_script=run.sh` may use:

```sh
mkdir -p dist
cp server.js run.sh dist/
chmod 755 dist/run.sh
```

For an ordinary npm application whose runtime entry imports dependencies, use the
project's actual build command and then copy production dependencies explicitly. A
typical pattern is:

```sh
#!/bin/sh
set -eu

export NPM_CONFIG_REGISTRY='https://registry.npmjs.org/'
npm ci --registry='https://registry.npmjs.org/'
npm run build
npm prune --omit=dev
mkdir -p dist
cp run.sh package.json package-lock.json dist/
cp -R node_modules dist/node_modules
chmod 755 dist/run.sh
```

Adapt the copied entrypoint and metadata to the real project. Do not use this pattern
when the framework's documented standalone output is already self-contained; copy that
standalone output instead. In either case, inspect the resulting build logic and account
for every external import before creating the Deployment.

`run.sh` must start the production server in the foreground and pass through the runtime
exit status.

Do not add application features or rewrite business logic while creating adapter scripts.
Do not copy deployment-only scripts back to the user project.

## npm Dependency Source

Apply this section when the package uses npm to install dependencies.

By default, the remote build must fetch npm packages only from the official registry:

`https://registry.npmjs.org/`

Use another registry only when the user explicitly requests that registry. Do not treat
an existing `.npmrc`, the local effective npm configuration, or lockfile URLs as user
authorization to use a mirror or private registry.

Before preparing the package:

1. Run `npm config get registry` and inspect project and workspace `.npmrc` files for
   `registry` and `<scope>:registry`. Do not read or print authentication token values.
2. Recursively inspect every `resolved` value in `package-lock.json`, including both
   legacy `dependencies` entries and modern `packages` entries.
3. Accept URLs from the selected registry, which is the official registry by default,
   plus local `file:` or workspace references whose content is included in the prepared
   package.
4. Reject URLs from any other remote registry. Reject Git URLs and direct tarball hosts
   unless the user explicitly requests that exact dependency source.

Do not assume that `npm ci --registry=...` overrides absolute `resolved` URLs already
stored in `package-lock.json`. If the lockfile contains another registry host, regenerate
its resolution metadata in the real project with the repository's selected npm version:

```bash
npm install --package-lock-only --ignore-scripts \
  --registry=https://registry.npmjs.org/ \
  --replace-registry-host=always
```

Only when the user explicitly selected another registry, replace the official URL in
this command with the exact user-requested registry URL.

Inspect the resulting diff. Dependency names and versions must remain unchanged; do not
silently upgrade the dependency graph. Recheck all `resolved` values, then copy the
corrected `package-lock.json` into the prepared package. Do not rewrite lockfiles with
regular expressions or patch only the temporary deployment copy.

The prepared package may include a project `.npmrc`. By default, every `registry` and
`<scope>:registry` entry in that file must be exactly
`https://registry.npmjs.org/`. A minimal valid file is:

```ini
registry=https://registry.npmjs.org/
```

When the user explicitly requests another registry, apply that registry consistently to
`.npmrc`, `build.sh`, and the lockfile. Never package registry credentials,
authentication tokens, or user-level `.npmrc` files. If a required package exists only
on a non-official registry and the user did not explicitly request that registry, stop
before creating the Deployment and report that the dependency is unavailable under the
default official-registry policy.

The prepared `build.sh` must select the user-approved registry explicitly. Under the
default official-registry policy, use:

```sh
#!/bin/sh
set -eu

export NPM_CONFIG_REGISTRY='https://registry.npmjs.org/'
npm ci --registry='https://registry.npmjs.org/'
npm run build
```

If the user explicitly selected another registry, replace both official URLs with the
exact user-requested registry URL.

Preserve the repository's actual build command after `npm ci`. Do not replace `npm ci`
with `npm install` when a valid `package-lock.json` is present.

## Cross-platform Native Dependencies

Apply this section when any direct or transitive dependency selects a native package by
operating system, CPU architecture, or libc. These platform packages are commonly
declared as optional dependencies and can be omitted from a lockfile generated from an
existing dependency tree on another platform.

Before preparing the deployment package:

1. Inspect the selected lockfile and relevant package metadata for optional native
   package variants.
2. Confirm that the lockfile includes the Linux-compatible variant required by the
   remote build. Do not treat a successful macOS or Windows install as proof that the
   Linux records exist.
3. If the Linux record is missing, repair or regenerate the lockfile in the real project
   from a clean dependency state using the repository's selected package manager and
   package-manager version, with optional dependencies enabled.
4. Inspect the resulting diff. The declared dependency intent and unrelated resolved
   versions must remain unchanged. If regenerating the lockfile changes the dependency
   graph beyond the required platform records and metadata, stop and report the change
   instead of silently accepting it.
5. Recheck the Linux-compatible records, discard the previous temporary source
   directory, and prepare a fresh package.

Do not hand-edit the lockfile, add a transitive platform package as a new direct
dependency, install a package chosen only for the local platform, or patch only the
temporary deployment copy.

## Package Requirements

The package must include:

- application source required by the build;
- package metadata and the selected lock file;
- deployment adapter scripts;
- runtime files required after build; and
- configuration files required for deterministic build and startup.

The package must exclude:

- `.git`;
- the local workspace's `node_modules` (the remote build installs dependencies and must
  then include production dependencies in `build.output_dir` unless it emits a
  self-contained bundle);
- dependency caches;
- local logs;
- test reports;
- existing deployment archives;
- `.npmrc` files that select a registry other than the user-approved registry or contain
  credentials;
- `.env` files;
- credentials; and
- unrelated generated output.

Create a fresh directory with the platform-specific temporary-directory command in
`SKILL.md`. Use its returned absolute path without replacing it with `/tmp/...` or a
workspace path. Copy package metadata, the selected lock file, application source,
runtime assets, framework configuration, referenced local workspace packages, and the
two adapter scripts into its root. Fail when a monorepo dependency cannot be resolved;
do not fall back to copying the whole repository.

## Runtime Port Verification

Complete this verification before creating the execution config or calling
`deployments create`:

1. Trace `runtime.start_script` through `run.sh`, package-manager scripts, framework
   configuration, and the production server entrypoint.
2. Identify the effective listening port used by the foreground server process. Do not
   infer it from a development server, package metadata alone, or the example value
   `8000`.
3. If the server reads `process.env.PORT`, set `runtime.port` explicitly to the intended
   value and verify that no shell wrapper, package script, or framework option replaces
   it.
4. If the server listens on a fixed numeric port, set `runtime.port` to that exact value,
   or patch the real project to read `PORT` and then prepare a fresh source directory.
5. If the server reads another environment variable, verify that the production start
   path maps `PORT` to that variable without changing the value.
6. Inspect every reachable production start branch. Reject configurations where
   different branches can listen on different ports.

The value in `runtime.port` is the routing and health-check port. It must equal the
application's effective listening port. If this equality cannot be proven from the
production start path, stop before creating the Deployment and ask the user to clarify
or fix the listening configuration. Never guess a port or deploy first to discover the
mismatch through a health timeout.

## Pre-deployment Artifact Validation

Complete the npm dependency-source checks above and every applicable artifact check
before `deployments create`:

- confirm `build.sh` copies the start script, application files, runtime assets, and
  remotely installed production dependencies into `build.output_dir`;
- reject absolute symlinks and any symlink that escapes the output directory, is
  dangling, or participates in a cycle;
- reject sockets, devices, FIFOs, and other special files;
- reject duplicate, absolute, or parent-traversal archive paths;
- confirm the output entry count, expanded size, and ZIP size remain within the platform
  limits; and
- confirm `runtime.start_script` is a regular executable file inside the output
  directory; and
- confirm `runtime.port` exactly matches the effective listening port established by
  **Runtime Port Verification**; and
- confirm platform-specific native dependencies have the required Linux-compatible
  lockfile records.

Inspect an existing build output when one is available. Otherwise inspect the package and
build scripts for each condition above. Do not claim that the built artifact passed
validation until an actual output has been inspected. Do not run a local frontend build
solely for this validation unless the user explicitly requested compilation.

Treat any deterministic failure in this section as blocking. Fix the user project or its
deployment adapter, discard the temporary source directory, and prepare a fresh one
before creating a Deployment.

## Execution Config

Create the execution config as JSON with this exact shape:

```json
{
  "schema_version": 1,
  "build": {
    "runtime_key": "nodejs20",
    "build_script": "build.sh",
    "output_dir": "dist",
    "environment": {},
    "secret_refs": [],
    "timeout_seconds": 3600
  },
  "runtime": {
    "runtime_key": "nodejs20",
    "start_script": "run.sh",
    "port": 8000,
    "environment": {},
    "secret_refs": []
  }
}
```

Set `build_script`, `output_dir`, and `start_script` to the package-relative paths
prepared above. Keep both `runtime_key` values equal to `nodejs20`. Build
`timeout_seconds` must be between 60 and 7200; runtime `port` must be between 1 and
65535 and must equal the verified application listening port. `environment` and
`secret_refs` may be omitted when empty.

`timeout_seconds` is a build-only field. Do not put it under `runtime`. Do not add fields
outside this schema. Omitted known fields are defaulted by the control plane, but the
deployment workflow should write them explicitly so the package and runtime contract
remain reviewable.

## Create Deployment

Run:

`deployments create --site-id <site-id> --title "<deployment-purpose>" --type function-web --source-dir <directory> --execution-config <file>`

The command validates the prepared directory, creates deterministic `package.zip`,
requests an upload destination, uploads the package, and creates the Deployment only
after upload succeeds. It does not inspect the project, copy source, generate scripts,
install dependencies, or run a build.

Treat a pre-upload failure as a local contract failure. Report the incompatible runtime,
missing script, non-POSIX script, invalid archive path, unsafe file, or missing executable
permission identified by the CLI.

Never patch only the temporary copy. If application source must change, patch the user
project, discard the source directory, and create again. Do not inspect or display
temporary upload details.

## Actionable Failure Codes

Document only failure codes that can be resolved by changing the project, build scripts,
or deployment adapter. Do not expose control-plane, scheduler, Agent, container, node, or
other infrastructure failures in this project-repair guide.

| Code | Meaning | Typical causes | Next action |
|---|---|---|---|
| `BUILD_SCRIPT_FAILED` | The build script exited unsuccessfully. | Dependency installation or build command failure; a target-platform native optional dependency is missing from the lockfile; another project-level build error. | Inspect the build log. When a native module or binary is missing, follow **Cross-platform Native Dependencies**, repair the real project lockfile, prepare a fresh source directory, and create a new Deployment. Do not retry unchanged source. |
| `BUILD_OUTPUT_INVALID` | The build completed, but its deterministic output validation failed. | Absolute or unsafe symlink; symlink escape, dangling target, or cycle; special file; output entry count, expanded size, or ZIP size over the platform limit; another deterministic artifact validation error. | Do not retry unchanged source. Inspect the build log, fix the project or `build.sh`, repeat pre-deployment artifact validation, and create a fresh Deployment. |

The expected summary is:

```json
{
  "error_code": "BUILD_OUTPUT_INVALID",
  "error_message": "Build output is invalid; see build log"
}
```

For any other failure code, inspect the detailed log for the failed stage. Change the
project only when the log identifies an actionable project, dependency, build-script, or
runtime-configuration cause. If the log does not reveal an actionable cause, stop and
preserve the site ID, Deployment ID, failed stage, and failure code for platform
diagnosis. Do not retry an unchanged Deployment repeatedly.

## Common Failures

### Runtime mismatch

Report the project's declared Node.js requirement. Do not silently modify the declared
engine range or force an incompatible dependency tree.

### Build failure

Use build logs to identify dependency installation, compilation, or output-generation
errors. Classify `BUILD_OUTPUT_INVALID` as deterministic. When the application source is
defective, patch the user project and prepare a new source directory. When the failure
is caused by deployment integration, correct the temporary adapter scripts before
calling the CLI again.

### Platform-specific native dependency missing

When `BUILD_SCRIPT_FAILED` is accompanied by a missing native module or native binary,
inspect the dependency's platform selection and the lockfile before changing build
scripts. If the required Linux-compatible optional dependency record is absent, follow
**Cross-platform Native Dependencies** to repair the real lockfile, prepare a fresh
source directory, and create a new Deployment. Do not retry the unchanged package or
install the named missing binary as an ad hoc direct dependency.

### Dependency registry unavailable

Check `build.sh`, applicable `.npmrc` files, and every lockfile `resolved` value. Correct
the real project lockfile with the official-registry procedure above and prepare a fresh
source directory. Do not add credentials or switch registries unless the user explicitly
requests the alternative registry.

### Startup failure

Use deploy or runtime logs to verify the start entry, executable permissions, output
directory, foreground-process behavior, and `PORT` handling. For
`./run.sh: No such file or directory`, inspect the built output rather than the package
root and correct `build.sh` so it places the executable start script and its dependencies
under `build.output_dir`. For `MODULE_NOT_FOUND`, compare the missing package with the
runtime entry and verify that the built output either bundles it or contains
`<output_dir>/node_modules/<package>`. Correct `build.sh`; do not fix this by uploading
the local workspace's `node_modules`.

### Health timeout

Confirm that the server binds promptly and does not wait for interactive input or an
unavailable local dependency.

## Completion

After create succeeds, return to the main Skill workflow to monitor the Deployment.
