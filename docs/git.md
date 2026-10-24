# 源码管理（Git）

左侧图标栏的 **源代码管理**（分支图标）→ 左栏变更列表 → 主区 diff / 历史。形态对齐 VS Code 的 SCM 视图。

## 范围

| 能力 | 说明 |
| --- | --- |
| 变更列表 | 冲突 / 已暂存 / 更改 三组；同一文件两侧都有改动时同时出现在两组 |
| diff | 点击文件看 patch（双行号 + 着色）；untracked 由服务端合成 new-file patch |
| 暂存 | 单文件 +、整组暂存；已暂存可单个/整组取消 |
| 丢弃 | 需确认；tracked 走 `restore --`，untracked 直接删文件（**仅限工作区内**） |
| 提交 | 暂存区为空或仍有冲突时禁用；`Ctrl/Cmd+Enter` 提交；消息走 stdin |
| AI 文案 | 按当前暂存 diff 生成（最近提交语气 + `--cached --stat` + patch 摘要），填进输入框由用户确认 |
| 分支 | 搜索/切换/新建（基于当前 HEAD）；可「贮藏后切换」或「强制切换（丢弃改动）」 |
| 历史 | 分页 50 条，点一条看元信息 + 文件清单 + 该次提交的完整 patch |
| 远端 | 拉取固定 `--ff-only`；推送一次确认，强制推送必须两次确认且只走 `--force-with-lease` |
| 冲突 | 冲突组每行三按钮：采用我方 / 采用对方 / 标记已解决（都会二次确认） |

## 后端

- `src/server/git.ts`：`spawn(git, [args])`，不经 shell；固定前缀 `--no-pager -c core.quotepath=false`；
  环境带 `GIT_TERMINAL_PROMPT=0`（无凭据立刻失败，不挂在等输入）、`GIT_EDITOR=true`、`GIT_OPTIONAL_LOCKS=0`。
- 一次 `status --porcelain=v2 -z --branch --untracked-files=all` 拿齐分支/上游/ahead-behind/文件状态；
  两次 `diff --numstat -z`（工作区 / 暂存区）并行补 +/- 数。
- 读操作 15s、写 30s、commit 120s（钩子可能慢）、pull/push 60s；超时杀进程树（复用 `killProcessTree`）。
- 写操作全部串行（`withLock`），避免 `.git/index.lock` 冲突；只读不进锁。
- 路径守卫：拒绝 `\0`/换行/绝对路径/`..`，`path.resolve` 必须落在仓库根内；**破坏性操作额外要求在工作区内**；
  单请求 ≤2000 条。revision 白名单不允许 `-` 开头（防选项注入）。
- 错误分类 → 稳定错误码（`not_a_repo` / `git_unavailable` / `identity_missing` / `dirty_worktree` /
  `auth_required` / `network_error` / `no_upstream` / `branch_exists` / `timeout` / `invalid_path` / `git_failed`），
  HTTP 映射：参数 400 / 业务冲突 409 / 超时 504 / 没装 git 503。
- 仓库范围以 `--show-toplevel` 为准（工作区是子目录时展示整个仓库），破坏性操作只作用于工作区内路径。

### 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/git/status` | 不是仓库返回 `200 { isRepo:false, reason }`，不抛错 |
| GET | `/git/diff?path=&scope=worktree\|index\|commit&sha=` | patch ≤512KB + `truncated` |
| POST | `/git/stage` `{paths}` · `/git/unstage` · `/git/discard` | 成功后广播 `git_changed` |
| POST | `/git/commit` `{message}` | 返回 `{sha, short, subject}` |
| GET | `/git/branches` · POST `/git/branches/switch` `{name,force?,stash?}` · POST `/git/branches/create` `{name,startPoint?}` | 老 git 无 `switch` 时回退 `checkout` |
| GET | `/git/log?limit=&skip=` · GET `/git/commit?sha=` | 空仓库返回空列表 |
| POST | `/git/pull` · `/git/push` `{setUpstream?,force?}` | 无 origin / 无上游给明确 409 |
| POST | `/git/resolve` `{path, side:ours\|theirs\|mark}` | |
| POST | `/git/commit-message` | 30s 超时；失败 502，前端降级为手写 |

## 前端

- `desktop/src/git/useGitView.ts`：全部状态与动作；在 **App** 调用（视图切走时 body 卸载，选中态与提交草稿不能丢）。
- `desktop/src/components/git/`：`GitNav`（左栏）、`GitBody`（主区）、`DiffView`、`HistoryList`、
  `CommitBox`、`BranchDialog`、`ConfirmDialog`、`git.css`；`desktop/src/git/patch.ts` 是纯函数 patch 解析器。
- 刷新：视图可见时 10s 轮询 + `git_changed` / `file_changed` / `turn_complete` 事件（300ms 防抖）+ 写操作后立即刷新；
  `requestId` 保证只有最新响应落地，选中文件消失时自动清空选择。
- diff 渲染与 `ReviewTab` 的自研 diff 格式**不同**（git 是 `+content` 无空格），因此单独解析，渲染上限 5000 行。

## 边界

- 工作区不是仓库 → 空态提示；没装 git → 503 + 提示安装。
- 空仓库（无 HEAD）→ unstage 走 `rm --cached -r`；历史显示「还没有提交」。
- 超大 diff / 二进制 → 截断 + 占位：diff/show 走「可截断读取」（执行器 640KB 上限，输出 512KB 补丁 + 已截断标记），
  不会因为一个几十 MB 的提交（比如刚 init 的首个提交）整条报错；其他命令超 4MB 才报错并提示收窄范围。
  提交详情文件列表最多 500 条，超出显示「+N 个文件未列出」。
- 中文/空格路径靠 `-z` + `quotepath=false`；截断按字节切，尾部半个多字节字符会被去掉。
- 提交钩子挂起 → commit 120s 超时并杀进程树；`index.lock` 残留不自动删，提示手动处理。
- commit message 目前不计 token 用量（避免为一行文案动 `UsageSource` 与统计 UI）。
