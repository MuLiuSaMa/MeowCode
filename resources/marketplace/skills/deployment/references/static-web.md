# Static Web Deployment

Use this reference after the project has been classified as `StaticWeb`.

## Eligibility

A project is eligible when it is either:

- directly publishable static content; or
- a frontend project with a deterministic production build output.

The published output must contain a non-empty `index.html`. Reject server-rendered or
API-serving applications that require a running process.

## Inspect

Read:

- `package.json`, when present
- the package-manager lock file
- framework configuration
- existing build scripts
- candidate output directories

Determine:

- package manager
- production build command
- final output directory
- whether the output already exists or must be built

Do not infer an output directory only from a framework default when the repository
overrides it.

## Build Selection

Prefer the repository's existing production build script.

When no suitable script exists, create or adjust project build configuration only through
the normal file-editing workflow and only when it does not change application behavior.
The CLI never creates a build adapter.

Do not:

- rewrite frontend features;
- change API endpoints;
- inject environment-specific secrets;
- replace the project's package manager; or
- add an unrelated framework dependency.

## Prepare the Source Directory

Create a fresh directory with the platform-specific temporary-directory command in
`SKILL.md`. Use its returned absolute path as `<source-dir>` without replacing it with
`/tmp/...` or a workspace path.

For an existing publishable output directory, copy its required static files into
`<source-dir>/public/`.

When a build is required:

- run the repository's production build command;
- verify the configured output directory exists; and
- copy that output into `<source-dir>/public/`.

When no build is required, copy the directly publishable project files into
`<source-dir>/public/`.

Exclude caches, VCS metadata, test output, logs, credentials, `.env` files, archives,
source maps that are not intended for publication, and unrelated generated output.

## Output Requirements

The prepared `public/` directory must:

- exist after the required build step;
- contain a non-empty `index.html`;
- contain only regular publishable files;
- contain no absolute paths or parent-directory traversal;
- contain no symbolic links;
- contain no credentials or local environment files;
- contain at most 199 published files; and
- have a total published size no greater than 50 MiB.

The CLI creates `<source-dir>/manifest.json`. Do not create or edit it manually.

## Create Deployment

Write `{}` to the execution config file. StaticWeb does not accept build or runtime
configuration.

Run:

`deployments create --site-id <site-id> --title "<deployment-purpose>" --type static-web --source-dir <directory> --execution-config <file>`

Treat a pre-upload failure as a local project-contract failure. Report the invalid path,
missing entrypoint, object-count limit, size limit, or unsafe file category identified by
the CLI.

The command validates `public/`, generates `manifest.json`, obtains upload destinations,
uploads the manifest plus every declared file, and creates the Deployment only after all
uploads succeed. Do not inspect or display temporary upload details.

Do not patch the temporary copy. If application source is defective, patch the user
project, rebuild or recopy into a fresh source directory, and create again.

## Common Failures

### Missing index

Confirm that the copied directory is the production output root rather than its parent.
Rebuild when required, then copy it into a fresh `public/` directory.

### Too many files

Do not remove arbitrary application assets. Explain the file-count limit and identify
whether generated source maps, reports, caches, or test output were included by mistake.

### Output too large

Identify large generated files. Exclude only files that are not required by the
application. Do not silently compress or remove required assets.

### Unsafe files

Stop when the CLI detects secrets, traversal paths, symbolic links, or unsupported file
types. Explain the path category without printing file contents.

## Completion

After create succeeds, return to the main Skill workflow to monitor the Deployment.
