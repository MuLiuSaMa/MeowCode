import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuExternalLink, LuImagePlus, LuTriangleAlert, LuUpload } from "react-icons/lu";
import type { CommunitySubmitPayload } from "../../api";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { CustomSelect, type CustomSelectOption } from "../ui/CustomSelect";
import {
  SUBMITTABLE_CATEGORIES,
  categoryValue,
  type MarketplaceCategoryId,
} from "./marketplace-categories";
import "./PlatformOauthDialog.css";
import "./CommunitySubmitDialog.css";

type SubmitType = "skill" | "plugin" | "mcp";

/** 表里只存值与 key：标签在组件里查表，切语言才会跟着刷新 */
const TYPE_OPTIONS: Array<{ value: SubmitType; labelKey: string }> = [
  { value: "skill", labelKey: "entryType.skills" },
  { value: "plugin", labelKey: "entryType.plugins" },
  { value: "mcp", labelKey: "entryType.mcp" },
];

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const DEFAULT_SERVER_JSON = '{\n  "command": "npx",\n  "args": ["-y", "example-mcp"]\n}';

/** 由名称粗略推导条目 id（用户可改）：非字母数字折叠成 - */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 48) || ""
  );
}

/**
 * 社区条目提交弹窗：连接 GitCode 社区 → 填表 → 主进程 fork/分支/上传/PR。
 * 提交的文件经 IPC 传本地路径（主进程读取并做大小校验），文本类内容（SKILL.md /
 * MCP server 配置）直接内联。
 */
export function CommunitySubmitDialog({
  open,
  defaultType,
  onClose,
}: {
  open: boolean;
  defaultType: SubmitType;
  onClose: () => void;
}) {
  const { t } = useTranslation("marketplace");
  const [login, setLogin] = useState<{ loggedIn: boolean; login: string | null } | null>(null);
  /** 本应用在 GitCode 应登记的回调地址（来自主进程，展示给用户防抄错） */
  const [callbackUri, setCallbackUri] = useState("");
  /** 浏览器授权进行中（starting=打开浏览器，pending=等待回跳） */
  const [oauthPhase, setOauthPhase] = useState<"starting" | "pending" | null>(null);
  const [type, setType] = useState<SubmitType>(defaultType);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<MarketplaceCategoryId>("devTools");
  const [tags, setTags] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [homepage, setHomepage] = useState("");
  /** skill：SKILL.md 正文（粘贴） */
  const [skillText, setSkillText] = useState("");
  /** skill：本地资源文件（SKILL.md 未粘贴时必须含 SKILL.md） */
  const [skillFiles, setSkillFiles] = useState<Array<{ name: string; path: string }>>([]);
  /** plugin：选中的 .ts 源文件 */
  const [pluginFile, setPluginFile] = useState<{ name: string; path: string } | null>(null);
  /** mcp：server 配置 JSON 文本 */
  const [serverJson, setServerJson] = useState(DEFAULT_SERVER_JSON);
  const [requiresEnv, setRequiresEnv] = useState("");
  /** Logo（可选）：统一改名为 icon.<ext> 存进条目目录 */
  const [iconFile, setIconFile] = useState<{ uploadName: string; path: string } | null>(null);
  const [phase, setPhase] = useState<"form" | "submitting" | "done">("form");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [prUrl, setPrUrl] = useState("");
  /** 解除登录：两次点击确认（防误触），执行中禁用 */
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const iconInputRef = useRef<HTMLInputElement | null>(null);

  // 分类选项：value 是提交用的分类 id，label 查 categories.* 词条
  const categoryOptions = useMemo<CustomSelectOption<MarketplaceCategoryId>[]>(
    () =>
      SUBMITTABLE_CATEGORIES.map((value) => ({
        value,
        label: t(`categories.${value}`),
      })),
    [t],
  );

  const refreshUser = useCallback(async () => {
    try {
      setLogin(await window.meow.communityUser());
    } catch {
      setLogin({ loggedIn: false, login: null });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // 每次打开都是全新表单：关闭弹窗不保留任何已填写内容
    setType(defaultType);
    setId("");
    setName("");
    setDescription("");
    setCategory("devTools");
    setTags("");
    setVersion("1.0.0");
    setHomepage("");
    setSkillText("");
    setSkillFiles([]);
    setPluginFile(null);
    setServerJson(DEFAULT_SERVER_JSON);
    setRequiresEnv("");
    setIconFile(null);
    setPhase("form");
    setError("");
    setProgress("");
    setPrUrl("");
    setDisconnectArmed(false);
    setDisconnecting(false);
    setLogin(null);
    void refreshUser();
    void window.meow
      .oauthStatus()
      .then((status) => setCallbackUri(status["gitcode-community"]?.redirectUri ?? ""))
      .catch(() => undefined);
  }, [open, defaultType, refreshUser]);

  /** 浏览器授权：开始 → 打开系统浏览器 → 轮询结果（与市场 MCP 连接同一套主进程机制） */
  const connectGitcode = useCallback(async () => {
    if (oauthPhase) return;
    setError("");
    setOauthPhase("starting");
    try {
      const result = await window.meow.oauthConnectStart({ platform: "gitcode-community" });
      if (!result.ok) {
        setOauthPhase(null);
        setError(result.message ?? t("submit.authStartFailed"));
        return;
      }
      setOauthPhase("pending");
      const openError = await window.meow.openExternal(result.authorizeUrl);
      if (openError) {
        setOauthPhase(null);
        void window.meow.oauthConnectCancel?.({ platform: "gitcode-community" });
        setError(t("submit.browserOpenFailed", { reason: openError }));
        return;
      }
      const deadline = Date.now() + 5 * 60 * 1000;
      const tick = async (): Promise<void> => {
        try {
          const poll = await window.meow.oauthConnectPoll({ platform: "gitcode-community" });
          if (poll.status === "pending") {
            if (Date.now() > deadline) {
              setOauthPhase(null);
              void window.meow.oauthConnectCancel?.({ platform: "gitcode-community" });
              setError(t("submit.authTimeout"));
              return;
            }
            window.setTimeout(() => void tick(), 1000);
            return;
          }
          setOauthPhase(null);
          if (poll.status === "success") {
            await refreshUser();
            return;
          }
          setError(poll.message || t("oauth.authFailed"));
        } catch {
          setOauthPhase(null);
          setError(t("submit.sessionEnded"));
        }
      };
      window.setTimeout(() => void tick(), 1000);
    } catch (err) {
      setOauthPhase(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [oauthPhase, refreshUser, t]);

  /**
   * 解除 GitCode 社区授权：第一次点击进入确认态（3 秒后自动还原防误触），
   * 第二次真正删除本机令牌（只清 gitcode-community 槽位，不影响 MCP 连接的 gitcode 授权）。
   */
  const disconnectGitcode = useCallback(async () => {
    if (disconnecting) return;
    if (!disconnectArmed) {
      setDisconnectArmed(true);
      window.setTimeout(() => setDisconnectArmed(false), 3000);
      return;
    }
    setDisconnectArmed(false);
    setDisconnecting(true);
    setError("");
    try {
      const result = await window.meow.oauthDisconnect({ platform: "gitcode-community" });
      if (result?.warning) setError(result.warning);
      await refreshUser();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDisconnecting(false);
    }
  }, [disconnectArmed, disconnecting, refreshUser]);

  /** 主进程推送的提交进度 */
  useEffect(() => {
    if (!open) return;
    const unsubscribe = window.meow.onCommunityProgress?.((payload) => {
      setProgress(payload.message);
    });
    return unsubscribe;
  }, [open]);

  const pickFiles = useCallback((list: FileList | null, mode: "skill" | "plugin") => {
    const picked: Array<{ name: string; path: string }> = [];
    for (const file of Array.from(list ?? [])) {
      const filePath = window.meow.getFilePath(file);
      if (!filePath) continue;
      const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      picked.push({ name: relative || file.name, path: filePath });
    }
    if (mode === "plugin") setPluginFile(picked[0] ?? null);
    else setSkillFiles(picked);
  }, []);

  /** 选 Logo：svg/png/jpg/webp/gif，≤64KB；统一改名为 icon.<ext> */
  const pickIcon = useCallback(
    (list: FileList | null) => {
      const file = list?.[0];
      if (!file) return;
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!["svg", "png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
        setError(t("submit.iconFormat"));
        return;
      }
      if (file.size > 64 * 1024) {
        setError(t("submit.iconTooLarge"));
        return;
      }
      const filePath = window.meow.getFilePath(file);
      if (!filePath) {
        setError(t("submit.noFilePath"));
        return;
      }
      setError("");
      setIconFile({ uploadName: ext === "jpeg" ? "icon.jpg" : `icon.${ext}`, path: filePath });
    },
    [t],
  );

  const buildPayload = useCallback((): CommunitySubmitPayload | null => {
    if (!id.trim() || !ID_PATTERN.test(id.trim())) {
      setError(t("submit.invalidId"));
      return null;
    }
    if (!name.trim()) {
      setError(t("submit.needName"));
      return null;
    }
    const itemId = id.trim();
    const iconField = iconFile ? { icon: iconFile.uploadName } : {};
    const files: CommunitySubmitPayload["files"] = [];
    if (iconFile) files.push({ name: iconFile.uploadName, path: iconFile.path });
    if (type === "skill") {
      if (skillText.trim()) files.push({ name: "SKILL.md", text: skillText });
      for (const file of skillFiles) {
        if (files.some((existing) => existing.name === file.name)) continue;
        files.push({ name: file.name, path: file.path });
      }
      if (!files.some((file) => file.name === "SKILL.md")) {
        setError(t("submit.needSkillMd"));
        return null;
      }
    } else if (type === "plugin") {
      if (!pluginFile) {
        setError(t("submit.needPluginFile"));
        return null;
      }
      files.push({ name: `${itemId}.ts`, path: pluginFile.path });
    } else {
      try {
        const server = JSON.parse(serverJson) as Record<string, unknown>;
        if (!server || typeof server !== "object" || (!server.url && !server.command)) {
          setError(t("submit.serverMissingField"));
          return null;
        }
        const envList = requiresEnv
          .split(/[,，;；]/)
          .map((value) => value.trim())
          .filter(Boolean);
        return {
          type,
          item: {
            id: itemId,
            name: name.trim(),
            description: description.trim(),
            // 提交给后端的是市场索引里的规范分类值，不随界面语言变化
            category: categoryValue(category) ?? "",
            tags: tags.split(/[,，;；]/).map((value) => value.trim()).filter(Boolean).slice(0, 4),
            version: version.trim() || "1.0.0",
            homepage: homepage.trim() || undefined,
            ...iconField,
            ...(envList.length ? { requiresEnv: envList } : {}),
            server,
          },
          files,
        };
      } catch {
        setError(t("submit.serverInvalidJson"));
        return null;
      }
    }
    return {
      type,
      item: {
        id: itemId,
        name: name.trim(),
        description: description.trim(),
        category: categoryValue(category) ?? "",
        tags: tags.split(/[,，;；]/).map((value) => value.trim()).filter(Boolean).slice(0, 4),
        version: version.trim() || "1.0.0",
        homepage: homepage.trim() || undefined,
        ...iconField,
      },
      files,
    };
  }, [
    category,
    description,
    homepage,
    iconFile,
    id,
    name,
    pluginFile,
    requiresEnv,
    serverJson,
    skillFiles,
    skillText,
    tags,
    type,
    version,
    t,
  ]);

  const submit = useCallback(async () => {
    const payload = buildPayload();
    if (!payload) return;
    setPhase("submitting");
    setError("");
    try {
      const result = await window.meow.communitySubmit(payload);
      if (result.ok && result.prUrl) {
        setPrUrl(result.prUrl);
        setPhase("done");
      } else {
        setError(result.message ?? t("submit.failed"));
        setPhase("form");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("form");
    }
  }, [buildPayload, t]);

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (phase !== "submitting") onClose();
      }}
      labelledBy="mc-community-submit-title"
      className="mc-mkt__dialog"
    >
      <span className="mc-dialog__title" id="mc-community-submit-title">
        {t("submit.title")}
      </span>
      <p className="mc-dialog__desc">{t("submit.desc")}</p>

      {phase === "done" ? (
        <div className="mc-community__done">
          <p>{t("submit.done")}</p>
          <div className="mc-community__prrow">
            <code className="mc-community__prurl">{prUrl}</code>
            <Button
              variant="ghost"
              onClick={() => void window.meow.openExternal(prUrl)}
              title={t("submit.openPr")}
            >
              <LuExternalLink size={14} />
              {t("actions.open")}
            </Button>
          </div>
          <div className="mc-dialog__footer">
            <Button variant="primary" onClick={onClose}>
              {t("actions.done")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* 登录状态：login=null 表示还在查询，避免已登录用户闪见红色警告 */}
          {login === null ? (
            <p className="mc-oauth__fieldhint">{t("submit.checkingLogin")}</p>
          ) : !login.loggedIn ? (
            <div className="mc-oauth__error">
              <LuTriangleAlert size={15} />
              <span>
                {t("submit.needConnect")}
                <button
                  type="button"
                  className="mc-mkt__connect"
                  disabled={oauthPhase !== null}
                  onClick={() => void connectGitcode()}
                >
                  {oauthPhase === "starting"
                    ? t("oauth.openingBrowser")
                    : oauthPhase === "pending"
                      ? t("oauth.awaitingBrowser")
                      : t("oauth.connectPlatform", {
                          platform: t("platforms.gitcode-community"),
                        })}
                </button>
                <span className="mc-oauth__fieldhint">
                  {t("submit.callbackHint")}
                  <code className="mc-community__callback">
                    {callbackUri || "http://127.0.0.1:53682/oauth/gitcode-community/callback"}
                  </code>
                  {t("submit.callbackNote")}
                </span>
              </span>
            </div>
          ) : (
            <div className="mc-community__loginrow">
              <p className="mc-oauth__fieldhint">{t("submit.account", { login: login.login ?? "" })}</p>
              <button
                type="button"
                className="mc-mkt__ghost"
                disabled={oauthPhase !== null || disconnecting}
                title={t("submit.disconnectTitle")}
                onClick={() => void disconnectGitcode()}
              >
                {disconnecting
                  ? t("actions.disconnecting")
                  : disconnectArmed
                    ? t("submit.confirmDisconnect")
                    : t("submit.disconnectLogin")}
              </button>
            </div>
          )}

          <fieldset className="mc-community__fieldset" disabled={phase !== "form" || !login?.loggedIn}>
            {/* 类型选择 */}
            <label className="mc-oauth__field">
              <span className="mc-oauth__fieldlabel">{t("submit.typeLabel")}</span>
              <div className="mc-mkt__channels">
                {TYPE_OPTIONS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className="mc-mkt__chip"
                    data-active={type === item.value}
                    onClick={() => setType(item.value)}
                  >
                    {t(item.labelKey)}
                  </button>
                ))}
              </div>
            </label>

            <label className="mc-oauth__field">
              <span className="mc-oauth__fieldlabel">{t("submit.nameLabel")}</span>
              <input
                className="mc-dialog__input"
                value={name}
                placeholder={t("submit.namePlaceholder")}
                onChange={(event) => {
                  setName(event.target.value);
                  if (!id.trim()) setId(slugify(event.target.value));
                }}
              />
            </label>

            <label className="mc-oauth__field">
              <span className="mc-oauth__fieldlabel">{t("submit.idLabel")}</span>
              <input
                className="mc-dialog__input"
                value={id}
                placeholder={t("submit.idPlaceholder")}
                spellCheck={false}
                onChange={(event) => setId(event.target.value)}
              />
            </label>

            <label className="mc-oauth__field">
              <span className="mc-oauth__fieldlabel">{t("submit.descLabel")}</span>
              <input
                className="mc-dialog__input"
                value={description}
                placeholder={t("submit.descPlaceholder")}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>

            <div className="mc-community__row">
              <label className="mc-oauth__field">
                <span className="mc-oauth__fieldlabel">{t("submit.categoryLabel")}</span>
                <CustomSelect
                  value={category}
                  options={categoryOptions}
                  onChange={setCategory}
                  ariaLabel={t("submit.categoryLabel")}
                  disabled={phase !== "form" || !login?.loggedIn}
                />
              </label>
              <label className="mc-oauth__field">
                <span className="mc-oauth__fieldlabel">{t("submit.versionLabel")}</span>
                <input
                  className="mc-dialog__input"
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                />
              </label>
            </div>

            <label className="mc-oauth__field">
              <span className="mc-oauth__fieldlabel">{t("submit.tagsLabel")}</span>
              <input
                className="mc-dialog__input"
                value={tags}
                placeholder={t("submit.tagsPlaceholder")}
                onChange={(event) => setTags(event.target.value)}
              />
            </label>

            <label className="mc-oauth__field">
              <span className="mc-oauth__fieldlabel">{t("submit.homepageLabel")}</span>
              <input
                className="mc-dialog__input"
                value={homepage}
                placeholder="https://…"
                onChange={(event) => setHomepage(event.target.value)}
              />
            </label>

            <div className="mc-oauth__field">
              <span className="mc-oauth__fieldlabel">{t("submit.logoLabel")}</span>
              <div className="mc-community__filerow">
                <button type="button" className="mc-community__pick" onClick={() => iconInputRef.current?.click()}>
                  <LuImagePlus size={14} />
                  {t("submit.pickLogo")}
                </button>
                {iconFile ? (
                  <>
                    <span className="mc-oauth__fieldhint">{iconFile.uploadName}</span>
                    <button
                      type="button"
                      className="mc-mkt__ghost"
                      onClick={() => setIconFile(null)}
                    >
                      {t("actions.remove")}
                    </button>
                  </>
                ) : (
                  <span className="mc-oauth__fieldhint">{t("submit.logoNone")}</span>
                )}
              </div>
              <input
                ref={iconInputRef}
                type="file"
                accept=".svg,.png,.jpg,.jpeg,.webp,.gif"
                hidden
                onChange={(event) => {
                  pickIcon(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>

            {/* 类型专属区 */}
            {type === "skill" ? (
              <>
                <label className="mc-oauth__field">
                  <span className="mc-oauth__fieldlabel">{t("submit.skillBodyLabel")}</span>
                  <textarea
                    className="mc-dialog__input mc-community__textarea"
                    rows={6}
                    value={skillText}
                    placeholder={t("submit.skillBodyPlaceholder")}
                    spellCheck={false}
                    onChange={(event) => setSkillText(event.target.value)}
                  />
                </label>
                <div className="mc-oauth__field">
                  <span className="mc-oauth__fieldlabel">{t("submit.extraFilesLabel")}</span>
                  <div className="mc-community__filerow">
                    <button type="button" className="mc-community__pick" onClick={() => fileInputRef.current?.click()}>
                      <LuUpload size={14} />
                      {t("submit.pickFiles")}
                    </button>
                    <span className="mc-oauth__fieldhint">
                      {skillFiles.length > 0
                        ? t("submit.filesSelected", { count: skillFiles.length })
                        : t("actions.none")}
                    </span>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    hidden
                    onChange={(event) => pickFiles(event.target.files, "skill")}
                  />
                </div>
              </>
            ) : null}

            {type === "plugin" ? (
              <div className="mc-oauth__field">
                <span className="mc-oauth__fieldlabel">{t("submit.pluginFileLabel")}</span>
                <div className="mc-community__filerow">
                  <button type="button" className="mc-community__pick" onClick={() => fileInputRef.current?.click()}>
                    <LuUpload size={14} />
                    {t("submit.pickPluginFile")}
                  </button>
                  <span className="mc-oauth__fieldhint">{pluginFile?.name ?? t("actions.none")}</span>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".ts"
                  hidden
                  onChange={(event) => pickFiles(event.target.files, "plugin")}
                />
              </div>
            ) : null}

            {type === "mcp" ? (
              <>
                <label className="mc-oauth__field">
                  <span className="mc-oauth__fieldlabel">{t("submit.serverLabel")}</span>
                  <textarea
                    className="mc-dialog__input mc-community__textarea"
                    rows={6}
                    value={serverJson}
                    spellCheck={false}
                    onChange={(event) => setServerJson(event.target.value)}
                  />
                  <span className="mc-oauth__fieldhint">{t("submit.serverConfigHint")}</span>
                </label>
                <label className="mc-oauth__field">
                  <span className="mc-oauth__fieldlabel">{t("submit.requiresEnvLabel")}</span>
                  <input
                    className="mc-dialog__input"
                    value={requiresEnv}
                    placeholder="MEOWCODE_XXX_TOKEN, MEOWCODE_YYY_TOKEN"
                    spellCheck={false}
                    onChange={(event) => setRequiresEnv(event.target.value)}
                  />
                </label>
              </>
            ) : null}
          </fieldset>

          {error ? (
            <div className="mc-oauth__error">
              <LuTriangleAlert size={15} />
              <span>{error}</span>
            </div>
          ) : null}
          {phase === "submitting" && progress ? <p className="mc-oauth__fieldhint">{progress}</p> : null}

          <div className="mc-dialog__footer">
            <Button variant="ghost" disabled={phase === "submitting"} onClick={onClose}>
              {t("actions.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={phase !== "form" || !login?.loggedIn}
              onClick={() => void submit()}
            >
              {phase === "submitting" ? t("actions.submitting") : t("submit.prButton")}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
