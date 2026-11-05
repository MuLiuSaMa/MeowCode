import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuTriangleAlert } from "react-icons/lu";
import { saveManualMcp } from "../../api";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { CustomSelect, type CustomSelectOption } from "../ui/CustomSelect";
import "./PlatformOauthDialog.css";
import "./CommunitySubmitDialog.css";

type ConnType = "stdio" | "http";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const DEFAULT_MCP_JSON = `{
  "mcpServers": {
    "example": {
      "command": "npx",
      "args": ["-y", "example-mcp"]
    }
  }
}`;

const CONN_OPTIONS: Array<{ value: ConnType; labelKey: string }> = [
  { value: "stdio", labelKey: "mine.mcp.connStdio" },
  { value: "http", labelKey: "mine.mcp.connHttp" },
];

/**
 * 手动添加 MCP 弹窗（「我的」栏）：默认结构化表单（Stdio 命令 / HTTP 地址），
 * 「高级」切换为粘贴 JSON——接受 { "mcpServers": { … } } 包裹（可批量）或裸 server 对象。
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
  const [id, setId] = useState("");
  const [connType, setConnType] = useState<ConnType>("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [headersJson, setHeadersJson] = useState("{}");
  const [envJson, setEnvJson] = useState("{}");
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState(DEFAULT_MCP_JSON);
  const [phase, setPhase] = useState<"form" | "saving">("form");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setId("");
    setConnType("stdio");
    setCommand("");
    setArgsText("");
    setUrl("");
    setHeadersJson("{}");
    setEnvJson("{}");
    setJsonMode(false);
    setJsonText(DEFAULT_MCP_JSON);
    setPhase("form");
    setError("");
  }, [open]);

  const connOptions = useCallback(
    () =>
      CONN_OPTIONS.map(
        (option): CustomSelectOption<ConnType> => ({ value: option.value, label: t(option.labelKey) }),
      ),
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
    if (jsonMode) {
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
    if (connType === "stdio") {
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
          server: { command: command.trim(), ...(args.length ? { args } : {}), ...env },
        },
      ];
    }
    if (!url.trim()) {
      setError(t("mine.mcp.needUrl"));
      return null;
    }
    const headers = parseObjectField(headersJson, "mine.mcp.headersInvalid");
    if (headers === null) return null;
    return [{ id: id.trim(), server: { url: url.trim(), ...headers, ...env } }];
  }, [jsonMode, jsonText, id, connType, command, argsText, url, envJson, headersJson, parseObjectField, t]);

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
      className="mc-mkt__dialog"
    >
      <span className="mc-dialog__title" id="mc-mine-mcp-title">
        {t("mine.mcp.title")}
      </span>
      <p className="mc-dialog__desc">{t("mine.mcp.desc")}</p>

      <fieldset className="mc-community__form" disabled={phase !== "form"}>
        <div className="mc-community__row">
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
          {!jsonMode ? (
            <label className="mc-oauth__field">
              <span className="mc-oauth__fieldlabel">{t("mine.mcp.connTypeLabel")}</span>
              <CustomSelect
                value={connType}
                options={connOptions()}
                onChange={setConnType}
                ariaLabel={t("mine.mcp.connTypeLabel")}
                disabled={phase !== "form"}
              />
            </label>
          ) : null}
        </div>

        {!jsonMode ? (
          <>
            {connType === "stdio" ? (
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
            ) : (
              <label className="mc-oauth__field">
                <span className="mc-oauth__fieldlabel">{t("mine.mcp.urlLabel")}</span>
                <input
                  className="mc-dialog__input"
                  value={url}
                  placeholder="https://…"
                  spellCheck={false}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
            )}
            {connType === "http" ? (
              <label className="mc-oauth__field">
                <span className="mc-oauth__fieldlabel">{t("mine.mcp.headersLabel")}</span>
                <textarea
                  className="mc-dialog__input mc-community__textarea"
                  rows={3}
                  value={headersJson}
                  spellCheck={false}
                  onChange={(event) => setHeadersJson(event.target.value)}
                />
              </label>
            ) : null}
            <label className="mc-oauth__field">
              <span className="mc-oauth__fieldlabel">{t("mine.mcp.envLabel")}</span>
              <textarea
                className="mc-dialog__input mc-community__textarea"
                rows={3}
                value={envJson}
                placeholder={'{ "MY_TOKEN": "${MEOWCODE_MY_TOKEN}" }'}
                spellCheck={false}
                onChange={(event) => setEnvJson(event.target.value)}
              />
              <span className="mc-oauth__fieldhint">{t("mine.mcp.envHint")}</span>
            </label>
          </>
        ) : (
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
        )}
      </fieldset>

      <button
        type="button"
        className="mc-mkt__chip mc-mine__advanced"
        data-active={jsonMode}
        onClick={() => {
          setJsonMode((prev) => !prev);
          setError("");
        }}
      >
        {t("mine.mcp.advancedToggle")}
      </button>

      {error ? (
        <div className="mc-oauth__error">
          <LuTriangleAlert size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="mc-dialog__footer">
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
