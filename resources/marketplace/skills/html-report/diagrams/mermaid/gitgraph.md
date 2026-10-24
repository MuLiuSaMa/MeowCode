# Gitgraph

Use for branching strategies, release flows, version control workflows, and CI/CD pipeline visualization.

## Basic Example

```mermaid
gitGraph
    commit id: "init"
    branch develop
    commit id: "feat-1"
    branch feature/login
    commit id: "login-ui"
    commit id: "login-api"
    checkout develop
    merge feature/login
    checkout main
    merge develop tag: "v1.0"
```

## Syntax

| Command | Description |
|---------|-------------|
| `commit` | Add a commit to current branch |
| `branch name` | Create and switch to new branch |
| `checkout name` | Switch to existing branch |
| `merge name` | Merge named branch into current |
| `cherry-pick id: "x"` | Cherry-pick a commit |

### Commit Options

```
commit id: "msg" tag: "v1.0" type: NORMAL
```

| Option | Values |
|--------|--------|
| `id` | Commit message/ID string |
| `tag` | Version tag to display |
| `type` | `NORMAL`, `REVERSE`, `HIGHLIGHT` |

## Git Flow Example

```mermaid
gitGraph
    commit id: "initial"
    branch develop
    commit id: "dev-setup"

    branch feature/auth
    commit id: "auth-model"
    commit id: "auth-api"
    commit id: "auth-tests"
    checkout develop
    merge feature/auth id: "merge-auth"

    branch feature/dashboard
    commit id: "dash-ui"
    commit id: "dash-charts"
    checkout develop
    merge feature/dashboard id: "merge-dash"

    branch release/1.0
    commit id: "bump-version"
    commit id: "fix-typo" type: REVERSE

    checkout main
    merge release/1.0 tag: "v1.0.0"
    checkout develop
    merge release/1.0

    branch hotfix/security
    commit id: "patch-xss" type: HIGHLIGHT
    checkout main
    merge hotfix/security tag: "v1.0.1"
    checkout develop
    merge hotfix/security
```

## Trunk-Based Development

```mermaid
gitGraph
    commit id: "feat-A"
    commit id: "feat-B"
    branch short-lived/feature-C
    commit id: "wip"
    commit id: "done"
    checkout main
    merge short-lived/feature-C
    commit id: "feat-D"
    commit id: "feat-E" tag: "v2.1"
    branch short-lived/bugfix
    commit id: "fix" type: REVERSE
    checkout main
    merge short-lived/bugfix tag: "v2.1.1"
    commit id: "feat-F"
```

## Release Train

```mermaid
gitGraph
    commit id: "sprint-start"
    branch release/2024.01
    commit id: "freeze"
    checkout main
    commit id: "feat-1"
    commit id: "feat-2"
    checkout release/2024.01
    commit id: "hotfix-1" type: REVERSE
    commit id: "rc-1" tag: "v2024.01-rc1"
    commit id: "rc-2" tag: "v2024.01"
    checkout main
    merge release/2024.01
    commit id: "feat-3"
    branch release/2024.02
    commit id: "freeze-2"
```

## Configuration

```mermaid
%%{init: {
    'gitGraph': {
        'mainBranchName': 'production',
        'showCommitLabel': true,
        'showBranches': true
    }
}}%%
gitGraph
    commit id: "deploy-1"
    branch staging
    commit id: "test-1"
    branch feature/x
    commit id: "dev-1"
    checkout staging
    merge feature/x
    checkout production
    merge staging tag: "v3.0"
```

## Best Practices

1. **Show the strategy** — make branching intent clear (Git Flow, trunk-based, etc.)
2. **Use meaningful commit IDs** — describe what each commit represents
3. **Tag releases** — mark release points with version tags
4. **Highlight special commits** — use `type: HIGHLIGHT` for important changes, `REVERSE` for fixes
5. **Keep branch names short** — `feature/auth` not `feature/implement-oauth2-authentication`
6. **Show merge direction** — merge into the correct target branch
7. **Limit branches** — show 3-5 branches max per diagram
