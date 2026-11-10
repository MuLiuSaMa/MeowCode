import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LuBraces, LuGlobe, LuTerminal, LuTriangleAlert } from "react-icons/lu";
import { saveManualMcp } from "../../api";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { Dialog } from "../ui/Dialog";
import { SegmentedControl } from "../ui/SegmentedControl";
import "./PlatformOauthDialog.css";
import "./CommunitySubmitDialog.css";
import "./AddDialog.css";

/** 三种接入方式：小导航里的三段 */
type McpMode = "stdio" | "http" | "json";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

const DEFAULT_MCP_JSON = `{
  "mcpServers": {
    "example": {
      "command": "npx",
      "args": ["-y", "example-mcp"]
    }
  }
}`;

/**
 * 手动添加 MCP 弹窗（「我的」栏）：顶部小导航在「本地命令（Stdio）/ 远程地址（HTTP）/ JSON」之间切换。
 *  - Stdio：命令 + 参数（每行一个）+ 环境变量
 *  - HTTP：服务地址 + 请求头 + 环境变量，可选 OAuth 浏览器授权
 *  - JSON：直接粘贴配置，接受 { "mcpServers": { … } } 包裹（可批量）或裸 server 对象
 *
 * HTTP 表单修过嵌套：headers 写进 `headers` 字段而不是摊在根上；env 同理只进 `env`。
 * OAuth 开关产出 `auth: { type: "oauth", scopes?, clientId?, clientMetadataUrl? }`，
 * Undermind 这类 CIMD 远程 MCP 勾上即可，浏览器授权不需要手动 token。
 */
export function ManualMcpDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("marketplace");
  const [mode, setMode] = useState<McpMode>("stdio");
  const [id, setId] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [headersJson, setHeadersJson] = useState("{}");
  const [envJson, setEnvJson] = useState("{}");
  const [oauth, setOauth] = useState(false);
  const [scopesText, setScopesText] = useState("");
  const [clientId, setClientId] = useState("");
  const [cimdUrl, setCimdUrl] = useState("");
  const [jsonText, setJsonText] = useState(DEFAULT_MCP_JSON);
  const [phase, setPhase] = useState<"form" | "saving">("form");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setMode("stdio");
    setId("");
    setCommand("");
    setArgsText("");
    setUrl("");
    setHeadersJson("{}");
    setEnvJson("{}");
    setOauth(false);
    setScopesText("");
    setClientId("");
    setCimdUrl("");
    setJsonText(DEFAULT_MCP_JSON);
    setPhase("form");
    setError("");
  }, [open]);

  /** 小导航三项：图标 + 短标题 */
  const modeOptions = useMemo<Array<{ value: McpMode; label: ReactNode }>>(
    () => [
      {
        value: "stdio",
        label: (
          <>
            <LuTerminal size={13} aria-hidden />
            {t("mine.mcp.navStdio")}
          </>
        ),
      },
      {
        value: "http",
        label: (
          <>
            <LuGlobe size={13} aria-hidden />
            {t("mine.mcp.navHttp")}
          </>
        ),
      },
      {
        value: "json",
        label: (
          <>
            <LuBraces size={13} aria-hidden />
            {t("mine.mcp.navJson")}
          </>
        ),
      },
    ],
    [t],
  );

  /** JSON 字段 → 对象；空串视为 {}，非法时报错返回 null */
  const parseObjectField = useCallback(
    (text: string, errorKey: string): Record<string, unknown> | null => {
      const trimmed = text.trim();
      if (!trimmed) return {};
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setError(t(errorKey));
          return null;
        }
        return parsed as Record<string, unknown>;
      } catch {
        setError(t(errorKey));
        return null;
      }
    },
    [t],
  );

  const buildServers = useCallback((): Array<{ id: string; server: Record<string, unknown> }> | null => {
    if (mode === "json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        setError(t("mine.mcp.jsonInvalid"));
        return null;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError(t("mine.mcp.jsonInvalid"));
        return null;
      }
      const obj = parsed as Record<string, unknown>;
      if (
        obj.mcpServers &&
        typeof obj.mcpServers === "object" &&
        !Array.isArray(obj.mcpServers)
      ) {
        const entries = Object.entries(obj.mcpServers as Record<string, unknown>);
        if (entries.length === 0) {
          setError(t("mine.mcp.jsonEmpty"));
          return null;
        }
        const out: Array<{ id: string; server: Record<string, unknown> }> = [];
        for (const [key, server] of entries) {
          if (!ID_PATTERN.test(key)) {
            setError(t("mine.mcp.jsonIdInvalid", { id: key }));
            return null;
          }
          if (!server || typeof server !== "object" || Array.isArray(server)) {
            setError(t("mine.mcp.jsonServerInvalid", { id: key }));
            return null;
          }
          const record = server as Record<string, unknown>;
          if (!record.url && !record.command) {
            setError(t("mine.mcp.serverMissingField", { id: key }));
            return null;
          }
          out.push({ id: key, server: record });
        }
        return out;
      }
      // 裸 server 对象：id 取「名称」字段
      if (!obj.url && !obj.command) {
        setError(t("mine.mcp.serverMissingField", { id: id.trim() || "-" }));
        return null;
      }
      if (!id.trim() || !ID_PATTERN.test(id.trim())) {
        setError(t("submit.invalidId"));
        return null;
      }
      return [{ id: id.trim(), server: obj }];
    }

    if (!id.trim() || !ID_PATTERN.test(id.trim())) {
      setError(t("submit.invalidId"));
      return null;
    }
    const env = parseObjectField(envJson, "mine.mcp.envInvalid");
    if (env === null) return null;
    if (mode === "stdio") {
      if (!command.trim()) {
        setError(t("mine.mcp.needCommand"));
        return null;
      }
      const args = argsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      return [
        {
          id: id.trim(),
          server: {
            command: command.trim(),
            ...(args.length ? { args } : {}),
            ...(Object.keys(env).length ? { env } : {}),
          },
        },
      ];
    }
    if (!url.trim()) {
      setError(t("mine.mcp.needUrl"));
      return null;
    }
    const headers = parseObjectField(headersJson, "mine.mcp.headersInvalid");
    if (headers === null) return null;
    const auth: Record<string, unknown> = { type: "oauth" };
    const scopes = scopesText
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (scopes.length) auth.scopes = scopes;
    if (clientId.trim()) auth.clientId = clientId.trim();
    if (cimdUrl.trim()) auth.clientMetadataUrl = cimdUrl.trim();
    return [
      {
        id: id.trim(),
        server: {
          url: url.trim(),
          ...(Object.keys(headers).length ? { headers } : {}),
          ...(Object.keys(env).length ? { env } : {}),
          ...(oauth ? { auth } : {}),
        },
      },
    ];
  }, [
    mode,
    jsonText,
    id,
    command,
    argsText,
    url,
    envJson,
    headersJson,
    oauth,
    scopesText,
    clientId,
    cimdUrl,
    parseObjectField,
    t,
  ]);

  const submit = useCallback(async () => {
    const servers = buildServers();
    if (!servers || phase !== "form") return;
    setPhase("saving");
    setError("");
    try {
      for (const entry of servers) {
        await saveManualMcp(entry.id, entry.server);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("form");
    }
  }, [buildServers, phase, onSaved]);

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (phase !== "saving") onClose();
      }}
      labelledBy="mc-mine-mcp-title"
      className="mc-mkt__dialog mc-adddlg"
    >
      <div className="mc-adddlg__head">
        <span className="mc-dialog__title" id="mc-mine-mcp-title">
          {t("mine.mcp.title")}
        </span>
        <p className="mc-adddlg__desc">{t("mine.mcp.desc")}</p>
      </div>

      <div className="mc-adddlg__nav">
        <SegmentedControl<McpMode>
          value={mode}
          options={modeOptions}
          onChange={(next) => {
            setMode(next);
            setError("");
          }}
          disabled={phase !== "form"}
          ariaLabel={t("mine.mcp.navLabel")}
        />
      </div>

      <div className="mc-adddlg__body">
        <fieldset className="mc-adddlg__form" disabled={phase !== "form"}>
          <label className="mc-oauth__field">
            <span className="mc-oauth__fieldlabel">{t("mine.mcp.idLabel")}</span>
            <input
              className="mc-dialog__input"
              value={id}
              placeholder="my-mcp"
              spellCheck={false}
              onChange={(event) => setId(event.target.value)}
            />
          </label>

          {mode === "stdio" ? (
            <>
              <label className="mc-oauth__field">
                <span className="mc-oauth__fieldlabel">{t("mine.mcp.commandLabel")}</span>
                <input
                  className="mc-dialog__input"
                  value={command}
                  placeholder="npx"
                  spellCheck={false}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </label>
              <label className="mc-oauth__field">
                <span className="mc-oauth__fieldlabel">{t("mine.mcp.argsLabel")}</span>
                <textarea
                  className="mc-dialog__input mc-community__textarea"
                  rows={3}
                  value={argsText}
                  placeholder={"-y\nexample-mcp"}
                  spellCheck={false}
                  onChange={(event) => setArgsText(event.target.value)}
                />
              </label>
            </>
          ) : null}

          {mode === "http" ? (
            <>
              <label className="mc-oauth__field">
                <span className="mc-oauth__fieldlabel">{t("mine.mcp.urlLabel")}</span>
                <input
                  className="mc-dialog__input"
                  value={url}
                  placeholder="https://mcp.undermind.ai/mcp"
                  spellCheck={false}
                  onChange={(event) => {
                    const next = event.target.value;
                    setUrl(next);
                    // Undermind 这类远程 MCP：粘 URL 即自动带 Bearer 头（token 由市场「连接」注入），
                    // 不走 agent 内 OAuth——那条路在 Undermind 上会卡 DCR/回调。
                    if (/undermind\.ai/i.test(next)) {
                      setOauth(false);
                      setHeadersJson('{\n  "Authorization": "Bearer ${MEOWCODE_UNDERMIND_TOKEN}"\n}');
                    }
                  }}
                />
              </label>
              <label className="mc-oauth__field">
                <span className="mc-oauth__fieldlabel">{t("mine.mcp.headersLabel")}</span>
                <textarea
                  className="mc-dialog__input mc-community__textarea"
                  rows={3}
                  value={headersJson}
                  placeholder='{"Authorization": "Bearer ${MY_TOKEN}"}'
                  spellCheck={false}
                  onChange={(event) => setHeadersJson(event.target.value)}
                />
              </label>
            </>
          ) : null}

          {mode === "json" ? (
            <label className="mc-oauth__field">
              <span className="mc-oauth__fieldlabel">{t("mine.mcp.jsonLabel")}</span>
              <textarea
                className="mc-dialog__input mc-community__textarea"
                rows={9}
                value={jsonText}
                spellCheck={false}
                onChange={(event) => setJsonText(event.target.value)}
              />
              <span className="mc-oauth__fieldhint">{t("mine.mcp.jsonHint")}</span>
            </label>
          ) : null}

          {mode === "http" ? (
            <p className="mc-adddlg__group">{t("mine.mcp.authGroup")}</p>
          ) : null}

          {mode === "http" ? (
            <Checkbox
              className="mc-oauth__check"
              checked={oauth}
              onChange={setOauth}
              label={t("mine.mcp.oauthToggle")}
            />
          ) : null}

          {mode === "http" && oauth ? (
            <>
              <p className="mc-oauth__fieldhint">{t("mine.mcp.oauthHint")}</p>
              <div className="mc-adddlg__row">
                <label className="mc-oauth__field">
                  <span className="mc-oauth__fieldlabel">{t("mine.mcp.oauthScopesLabel")}</span>
                  <input
                    className="mc-dialog__input"
                    value={scopesText}
                    placeholder="mcp"
                    spellCheck={false}
                    onChange={(event) => setScopesText(event.target.value)}
                  />
                </label>
                <label className="mc-oauth__field">
                  <span className="mc-oauth__fieldlabel">{t("mine.mcp.oauthClientIdLabel")}</span>
                  <input
                    className="mc-dialog__input"
                    value={clientId}
                    placeholder="meowcode-pre-registered"
                    spellCheck={false}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                </label>
              </div>
              <label className="mc-oauth__field">
                <span className="mc-oauth__fieldlabel">{t("mine.mcp.oauthCimdLabel")}</span>
                <input
                  className="mc-dialog__input"
                  value={cimdUrl}
                  placeholder="https://meowcode.cn/.well-known/oauth-client"
                  spellCheck={false}
                  onChange={(event) => setCimdUrl(event.target.value)}
                />
                <span className="mc-oauth__fieldhint">{t("mine.mcp.oauthCimdHint")}</span>
              </label>
            </>
          ) : null}

          {mode !== "json" ? (
            <label className="mc-oauth__field">
              <span className="mc-oauth__fieldlabel">{t("mine.mcp.envLabel")}</span>
              <textarea
                className="mc-dialog__input mc-community__textarea"
                rows={3}
                value={envJson}
                placeholder={'{ "MY_TOKEN": "${MY_TOKEN}" }'}
                spellCheck={false}
                onChange={(event) => setEnvJson(event.target.value)}
              />
              <span className="mc-oauth__fieldhint">{t("mine.mcp.envHint")}</span>
            </label>
          ) : null}
        </fieldset>
      </div>

      {error ? (
        <div className="mc-oauth__error mc-adddlg__error">
          <LuTriangleAlert size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="mc-dialog__footer mc-adddlg__foot">
        <Button variant="ghost" disabled={phase === "saving"} onClick={onClose}>
          {t("actions.cancel")}
        </Button>
        <Button variant="primary" disabled={phase !== "form"} onClick={() => void submit()}>
          {phase === "saving" ? t("actions.saving") : t("actions.save")}
        </Button>
      </div>
    </Dialog>
  );
}
