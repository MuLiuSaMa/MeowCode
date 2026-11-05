/**
 * 社区市场条目提交/删除：走 GitCode API（fork → 建分支 → 传文件 → 建 PR）。
 *
 * 收录仓库：https://gitcode.com/MuLiuSaMa/MeowCode-Plugins（结构与条目格式见仓库 README）。
 * 认证复用 `gitcode-community` OAuth 槽位的 token（主进程加密存储，见 oauth-platforms.cjs）。
 * GitCode API v5 与 Gitee 同构：POST 一律 form-urlencoded（branches/contents/pulls 实测），
 * token 走 access_token 查询参数 + Bearer 头，429 按 Retry-After 退避。
 */
const fs = require("node:fs/promises");
const path = require("node:path");

const OWNER = "MuLiuSaMa";
const REPO = "MeowCode-Plugins";
const API_BASE = "https://api.gitcode.com/api/v5";
/** contents API 直传的单文件上限（base64 前的原始字节数） */
const MAX_FILE_BYTES = 1024 * 1024;
/** 用户名/路径片段的安全模式（id 与 login 都按它校验后才能进 URL） */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const TYPE_DIRS = { skill: "skills", plugin: "plugins", mcp: "mcp" };

// ---------------------------------------------------------------------------
// HTTP 基础
// ---------------------------------------------------------------------------

function assertSegment(value, label) {
  if (typeof value !== "string" || !SEGMENT_PATTERN.test(value) || value.includes("..")) {
    throw new Error(`非法的${label}：${value}`);
  }
  return value;
}

function buildUrl(apiPath, { query, token } = {}) {
  const url = new URL(`${API_BASE}/${apiPath}`);
  if (token) url.searchParams.set("access_token", token);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function apiRequest(method, apiPath, { token, query, form, timeoutMs = 60_000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
    try {
      const response = await fetch(buildUrl(apiPath, { query, token }), {
        method,
        headers: {
          authorization: token ? `Bearer ${token}` : undefined,
          "user-agent": "MeowCode-Community",
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 限流：按 Retry-After 等待后重试
      if (response.status === 429 && attempt < 2) {
        const wait = Number(response.headers.get("retry-after")) || 15;
        await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 60) * 1000));
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`GitCode ${response.status}：${text.slice(0, 300) || "(无响应体)"}`);
      }
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return { raw: text };
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------
// GitCode 基本操作
// ---------------------------------------------------------------------------

async function currentLogin(token) {
  const user = await apiRequest("GET", "user", { token });
  const login = typeof user?.login === "string" ? user.login : "";
  if (!login) throw new Error("无法获取 GitCode 用户名（token 可能过期，请重新连接 GitCode 社区）。");
  return login;
}

/** fork 已存在则直接用，否则创建并等待就绪；返回 fork 属主 */
async function ensureFork(token, login) {
  try {
    await apiRequest("GET", `repos/${assertSegment(login, "用户名")}/${REPO}`, { token });
    return login;
  } catch {
    await apiRequest("POST", `repos/${OWNER}/${REPO}/forks`, { token, form: {} });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return login;
  }
}

async function createBranch(token, owner, refs, branchName) {
  await apiRequest("POST", `repos/${assertSegment(owner, "用户名")}/${REPO}/branches`, {
    token,
    form: { branch_name: branchName, refs },
  });
}

async function deleteBranchQuiet(token, owner, branch) {
  try {
    await apiRequest(
      "DELETE",
      `repos/${assertSegment(owner, "用户名")}/${REPO}/branches/${encodeURIComponent(branch)}`,
      { token },
    );
  } catch {
    /* 清理失败忽略 */
  }
}

async function uploadFile(token, owner, repoPath, branch, contentB64, message) {
  await apiRequest(
    "POST",
    `repos/${assertSegment(owner, "用户名")}/${REPO}/contents/${repoPath.split("/").map(encodeURIComponent).join("/")}`,
    { token, form: { content: contentB64, message, branch } },
  );
}

async function createPullRequest(token, headOwner, branch, title, body) {
  const sameRepo = headOwner.toLowerCase() === OWNER.toLowerCase();
  const form = { title, base: "main", body };
  if (sameRepo) {
    form.head = branch;
  } else {
    form.head = `${headOwner}:${branch}`;
    form.fork_path = `${headOwner}/${REPO}`;
  }
  const result = await apiRequest("POST", `repos/${OWNER}/${REPO}/pulls`, { token, form });
  const url =
    (typeof result?.html_url === "string" && result.html_url) ||
    (typeof result?.web_url === "string" && result.web_url) ||
    (result?.number ? `https://gitcode.com/${OWNER}/${REPO}/pulls/${result.number}` : "");
  if (!url) throw new Error(`无法解析 PR 链接，原始响应：${JSON.stringify(result).slice(0, 300)}`);
  return url;
}

/** 递归列出目录下全部文件路径（contents API） */
async function listDirRecursive(token, owner, root, ref) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await apiRequest(
        "GET",
        `repos/${assertSegment(owner, "用户名")}/${REPO}/contents/${dir.split("/").map(encodeURIComponent).join("/")}`,
        { token, query: { ref } },
      );
    } catch (error) {
      if (String(error).includes("404")) {
        throw new Error(
          `条目目录 ${dir} 在 fork 的 main 分支上不存在。fork 可能落后于上游，请先在 GitCode 网页上同步 fork 后重试。`,
        );
      }
      throw error;
    }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry?.type === "dir" && typeof entry.path === "string") stack.push(entry.path);
      else if (typeof entry.path === "string") files.push(entry.path);
    }
  }
  return files;
}

async function deleteFile(token, owner, repoPath, branch, message) {
  const encoded = repoPath.split("/").map(encodeURIComponent).join("/");
  const info = await apiRequest(
    "GET",
    `repos/${assertSegment(owner, "用户名")}/${REPO}/contents/${encoded}`,
    { token, query: { ref: branch } },
  );
  const sha = typeof info?.sha === "string" ? info.sha : "";
  if (!sha) throw new Error(`无法定位文件 ${repoPath} 的 sha`);
  await apiRequest("DELETE", `repos/${OWNER}/${REPO}/contents/${encoded}`, {
    token,
    query: { sha, message, branch },
  });
}

// ---------------------------------------------------------------------------
// 提交载荷 → 仓库文件
// ---------------------------------------------------------------------------

/** 渲染层传来的文件：text 内联内容 或 path 本地路径（主进程读取） */
async function readFileEntries(files) {
  const out = [];
  for (const file of Array.isArray(files) ? files : []) {
    const name = path.posix.basename(String(file?.name ?? ""));
    if (!name) continue;
    if (typeof file.text === "string") {
      out.push({ name, data: Buffer.from(file.text, "utf8") });
      continue;
    }
    if (typeof file.path === "string") {
      const stat = await fs.stat(file.path);
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error(`文件 ${name} 超过 1MB，请精简后重试（GitCode contents API 限制）。`);
      }
      out.push({ name, data: await fs.readFile(file.path) });
    }
  }
  return out;
}

/** 校验条目元数据并生成 item.json 内容 */
function buildItemJson(payload, author) {
  const type = payload?.type;
  if (type !== "skill" && type !== "plugin" && type !== "mcp") {
    throw new Error("条目类型必须是 skill / plugin / mcp。");
  }
  const id = assertSegment(String(payload?.item?.id ?? ""), "条目 id");
  const name = String(payload?.item?.name ?? "").trim();
  if (!name) throw new Error("条目名称不能为空。");
  const description = String(payload?.item?.description ?? "").trim().slice(0, 240);
  const category = String(payload?.item?.category ?? "").trim() || "效率提升";
  const tags = Array.isArray(payload?.item?.tags)
    ? payload.item.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 4)
    : [];
  const version = String(payload?.item?.version ?? "").trim() || "1.0.0";
  const homepage = String(payload?.item?.homepage ?? "").trim();
  const requiresEnv = Array.isArray(payload?.item?.requiresEnv)
    ? payload.item.requiresEnv.map((v) => String(v).trim()).filter(Boolean)
    : undefined;
  const server = payload?.item?.server;

  const item = {
    id,
    type,
    name,
    ...(description ? { description } : {}),
    category,
    tags,
    version,
    author,
    ...(homepage ? { homepage } : {}),
    // 图标文件名（条目目录内 icon.<ext>，渲染层已归一化；服务端按 basename 防穿越）
    ...(typeof payload?.item?.icon === "string" && payload.item.icon.trim()
      ? { icon: path.posix.basename(payload.item.icon.trim()) }
      : {}),
    ...(type === "mcp"
      ? {
          server: server && typeof server === "object" ? server : null,
          ...(requiresEnv?.length ? { requiresEnv } : {}),
        }
      : {}),
    submittedAt: new Date().toISOString(),
  };
  if (type === "mcp" && (!item.server || Object.keys(item.server).length === 0)) {
    throw new Error("MCP 条目必须提供 server 配置（command 或 url）。");
  }
  return { item, id, type };
}

function progress(send, message) {
  if (typeof send === "function") send("meow:community-progress", { message });
}

// ---------------------------------------------------------------------------
// IPC 注册
// ---------------------------------------------------------------------------

/**
 * 注册社区提交/删除/用户 IPC。
 * @param opts ipcMain / 广播函数 / 读 gitcode-community token 的闭包（来自 main.cjs）
 */
function registerCommunitySubmitIpc({ ipcMain, broadcast, readCommunityToken }) {
  const tokenOf = () => {
    const token = readCommunityToken();
    if (!token) {
      throw new Error("尚未连接 GitCode 社区，请先在提交窗口完成授权。");
    }
    return token;
  };

  /** 当前 GitCode 社区登录名（未连接返回 null，渲染层据此显示登录引导） */
  ipcMain.handle("meow:community-user", async () => {
    try {
      const token = readCommunityToken();
      if (!token) return { loggedIn: false, login: null };
      return { loggedIn: true, login: await currentLogin(token) };
    } catch {
      return { loggedIn: false, login: null };
    }
  });

  /** 一键提交：fork → 分支 → 传文件 → item.json → PR；失败清理临时分支 */
  ipcMain.handle("meow:community-submit", async (_event, payload) => {
    const token = tokenOf();
    let branch = "";
    let forkOwner = "";
    try {
      progress(broadcast, "正在获取 GitCode 用户名…");
      const author = await currentLogin(token);
      const { item, id, type } = buildItemJson(payload, author);

      progress(broadcast, "正在准备 fork…");
      forkOwner = await ensureFork(token, author);
      branch = `item/${type}-${id}-${Date.now()}`;
      progress(broadcast, "正在创建提交分支…");
      await createBranch(token, forkOwner, "main", branch);

      const dir = `${TYPE_DIRS[type]}/${id}`;
      const files = await readFileEntries(payload?.files);
      if (type === "skill" && !files.some((file) => file.name === "SKILL.md")) {
        throw new Error("技能条目必须包含 SKILL.md。");
      }
      if (type === "plugin" && !files.some((file) => file.name === `${id}.ts`)) {
        throw new Error(`插件条目必须包含 ${id}.ts 源码文件。`);
      }
      for (const [index, file] of files.entries()) {
        progress(broadcast, `正在上传 ${file.name}（${index + 1}/${files.length}）…`);
        await uploadFile(
          token,
          forkOwner,
          `${dir}/${file.name}`,
          branch,
          file.data.toString("base64"),
          `feat: upload ${file.name}`,
        );
      }

      progress(broadcast, "正在提交条目信息…");
      await uploadFile(
        token,
        forkOwner,
        `${dir}/item.json`,
        branch,
        Buffer.from(`${JSON.stringify(item, null, 2)}\n`, "utf8").toString("base64"),
        `feat: add item - ${id}`,
      );

      progress(broadcast, "正在创建 Pull Request…");
      const prBody = [
        "## 新增社区条目",
        "",
        `- **类型**：${type}`,
        `- **名称**：${item.name}`,
        `- **分类**：${item.category}`,
        `- **描述**：${item.description || "(无)"}`,
        `- **提交者**：@${author}`,
      ].join("\n");
      const prUrl = await createPullRequest(
        token,
        forkOwner,
        branch,
        `[社区条目] ${item.name}`,
        prBody,
      );
      progress(broadcast, "提交成功！");
      return { ok: true, prUrl };
    } catch (error) {
      if (branch && forkOwner) await deleteBranchQuiet(token, forkOwner, branch);
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  /** 删除自己的条目（生成删除 PR，仓库主审核合并后才真正移除） */
  ipcMain.handle("meow:community-delete", async (_event, payload) => {
    const token = tokenOf();
    const id = assertSegment(String(payload?.id ?? ""), "条目 id");
    const type = payload?.type;
    if (type !== "skill" && type !== "plugin" && type !== "mcp") {
      return { ok: false, message: "条目类型不合法。" };
    }
    let branch = "";
    let owner = "";
    try {
      progress(broadcast, "正在获取 GitCode 用户名…");
      const login = await currentLogin(token);
      const author = String(payload?.author ?? "").trim();
      // 只能删自己的条目（仓库主除外）
      if (
        author &&
        login.toLowerCase() !== author.toLowerCase() &&
        login.toLowerCase() !== OWNER.toLowerCase()
      ) {
        return { ok: false, message: "只能删除自己提交的条目。" };
      }

      progress(broadcast, "正在准备 fork…");
      owner = await ensureFork(token, login);
      branch = `delete/${id}-${Date.now()}`;
      progress(broadcast, "正在创建删除分支…");
      await createBranch(token, owner, "main", branch);

      const dir = `${TYPE_DIRS[type]}/${id}`;
      progress(broadcast, "正在枚举条目文件…");
      const files = await listDirRecursive(token, owner, dir, "main");
      for (const [index, filePath] of files.entries()) {
        progress(broadcast, `正在删除 ${filePath}（${index + 1}/${files.length}）…`);
        await deleteFile(token, owner, filePath, branch, `chore: remove ${filePath}`);
      }

      progress(broadcast, "正在创建 Pull Request…");
      const prUrl = await createPullRequest(
        token,
        owner,
        branch,
        `[删除条目] ${payload?.name ?? id}`,
        `## 删除社区条目\n\n- **类型**：${type}\n- **id**：${id}\n- **发起者**：@${login}\n`,
      );
      progress(broadcast, "删除请求已提交！");
      return { ok: true, prUrl };
    } catch (error) {
      if (branch && owner) await deleteBranchQuiet(token, owner, branch);
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
}

module.exports = { registerCommunitySubmitIpc, OWNER, REPO };
