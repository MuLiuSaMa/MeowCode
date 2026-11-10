import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { CodeBlock } from "./ui/CodeBlock";
import { CustomSelect } from "./ui/CustomSelect";
import { Dialog } from "./ui/Dialog";
import "./ApprovalDialog.css";

type RememberScope = "tool" | "path" | "command-exact" | "command-prefix";

export function ApprovalDialog({
  open,
  tool,
  input,
  diff,
  risk,
  stale,
  agentDescription,
  kind,
  command,
  hookEvent,
  matcher,
  source,
  hookReason,
  sandboxEscape,
  onApprove,
  onDeny,
}: {
  open: boolean;
  tool?: string;
  input?: unknown;
  diff?: string;
  risk?: { level: "medium" | "high"; categories?: string[]; reasons: string[] };
  /** 审批期间文件被改动：预览已重新生成，需要重新确认 */
  stale?: boolean;
  /** 子 Agent 发起的审批：显示来源，避免和主对话操作混淆 */
  agentDescription?: string;
  /** tool = 工具审批；hook = 每次询问模式下 hook 命令运行审批 */
  kind?: "tool" | "hook";
  /** hook 命令审批的展示字段 */
  command?: string;
  hookEvent?: string;
  matcher?: string;
  source?: string;
  /** PreToolUse hook 要求人工确认的原因 */
  hookReason?: string;
  /** 沙箱拒绝后的「沙箱外重试」审批 */
  sandboxEscape?: { command: string; detail: string };
  onApprove: (options?: { remember?: RememberScope }) => void;
  onDeny: (feedback?: string) => void;
}) {
  const { t } = useTranslation("shell");
  const [feedback, setFeedback] = useState("");
  const [remember, setRemember] = useState(false);
  const [commandScope, setCommandScope] = useState<"command-exact" | "command-prefix">(
    "command-exact",
  );

  // 每次打开新审批都清空：上一条的理由/勾选不能带到下一条
  useEffect(() => {
    if (open) {
      setFeedback("");
      setRemember(false);
      setCommandScope("command-exact");
    }
  }, [open, tool]);

  if (kind === "hook") {
    return (
      <Dialog open={open} onClose={onDeny} labelledBy="mc-approval-title">
        <span className="mc-dialog__title" id="mc-approval-title">
          {t("approval.hookTitle")}
        </span>
        <p className="mc-dialog__desc">
          {t("approval.hookRequest", { event: hookEvent ?? "" })}
        </p>
        {agentDescription ? (
          <p className="mc-dialog__desc">
            {t("approval.hookFromAgent", { name: agentDescription })}
          </p>
        ) : null}
        {matcher ? (
          <p className="mc-dialog__desc">{t("approval.hookMatcher", { matcher })}</p>
        ) : null}
        {source ? (
          <p className="mc-dialog__desc">{t("approval.hookSource", { source })}</p>
        ) : null}
        <div className="mc-dialog__body">
          <CodeBlock text={command ?? ""} />
        </div>
        <p className="mc-dialog__desc">{t("approval.hookNote")}</p>
        <div className="mc-dialog__footer">
          <Button variant="danger" onClick={() => onDeny()}>
            {t("approval.hookSkip")}
          </Button>
          <Button variant="primary" onClick={() => onApprove()}>
            {t("approval.hookRun")}
          </Button>
        </div>
      </Dialog>
    );
  }

  if (sandboxEscape) {
    return (
      <Dialog open={open} onClose={onDeny} labelledBy="mc-approval-title">
        <span className="mc-dialog__title" id="mc-approval-title">
          {t("approval.sandboxTitle")}
        </span>
        <p className="mc-dialog__desc">{t("approval.sandboxDesc")}</p>
        <div className="mc-dialog__body">
          <CodeBlock label={t("approval.sandboxCommand")} text={sandboxEscape.command} />
          {sandboxEscape.detail ? (
            <CodeBlock label={t("approval.sandboxEvidence")} text={sandboxEscape.detail} />
          ) : null}
        </div>
        <p className="mc-dialog__desc">{t("approval.sandboxNote")}</p>
        <div className="mc-dialog__footer">
          <Button variant="danger" onClick={() => onDeny()}>
            {t("approval.sandboxDeny")}
          </Button>
          <Button variant="primary" onClick={() => onApprove()}>
            {t("approval.sandboxRetry")}
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={() => onDeny()} labelledBy="mc-approval-title">
      <span className="mc-dialog__title" id="mc-approval-title">
        {t("approval.title")}
      </span>
      <p className="mc-dialog__desc">
        {agentDescription
          ? t("approval.requestSubagent", { name: agentDescription, tool: tool ?? "" })
          : t("approval.requestApp", { tool: tool ?? "" })}
      </p>

      {stale ? (
        <p className="mc-dialog__desc" role="status">
          {t("approval.stale")}
        </p>
      ) : null}

      {hookReason ? (
        <div className="mc-dialog__risk" role="alert">
          <span className="mc-dialog__risktitle">{t("approval.hookReasonTitle")}</span>
          <p>{hookReason}</p>
        </div>
      ) : null}

      {risk ? (
        <div className="mc-dialog__risk" role="alert">
          <span className="mc-dialog__risktitle">{t("approval.risk")}</span>
          <ul>
            {risk.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mc-dialog__body">
        <CodeBlock text={JSON.stringify(input ?? {}, null, 2)} />
        {diff ? <CodeBlock label={t("approval.diff")} text={diff} /> : null}
      </div>

      {!stale ? (
        <div className="mc-approval__extras">
          <label className="mc-approval__label" htmlFor="mc-approval-feedback">
            {t("approval.feedbackLabel")}
          </label>
          <textarea
            id="mc-approval-feedback"
            className="mc-approval__feedback"
            rows={2}
            value={feedback}
            placeholder={t("approval.feedbackPlaceholder")}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <Checkbox
            className="mc-approval__remember"
            checked={remember}
            onChange={setRemember}
            label={
              tool === "run_command"
                ? t("approval.rememberCommand")
                : tool === "write_file" || tool === "edit_file" || tool === "multi_edit"
                  ? t("approval.rememberPath")
                  : t("approval.rememberTool")
            }
          />
          {remember && tool === "run_command" ? (
            <CustomSelect
              className="mc-approval__scope"
              value={commandScope}
              options={[
                { value: "command-exact", label: t("approval.rememberExact") },
                { value: "command-prefix", label: t("approval.rememberPrefix") },
              ]}
              onChange={(value) => setCommandScope(value)}
              ariaLabel={t("approval.rememberCommand")}
              placement="top"
            />
          ) : null}
        </div>
      ) : null}

      <div className="mc-dialog__footer">
        <Button variant="danger" onClick={() => onDeny(feedback.trim() || undefined)}>
          {t("approval.deny")}
        </Button>
        <Button
          variant="primary"
          onClick={() =>
            onApprove(
              remember
                ? {
                    remember:
                      tool === "run_command"
                        ? commandScope
                        : tool === "write_file" || tool === "edit_file" || tool === "multi_edit"
                          ? "path"
                          : "tool",
                  }
                : undefined,
            )
          }
        >
          {t("approval.approve")}
        </Button>
      </div>
    </Dialog>
  );
}
