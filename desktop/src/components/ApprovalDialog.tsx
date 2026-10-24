import { Button } from "./ui/Button";
import { CodeBlock } from "./ui/CodeBlock";
import { Dialog } from "./ui/Dialog";

export function ApprovalDialog({
  open,
  tool,
  input,
  diff,
  risk,
  stale,
  agentDescription,
  onApprove,
  onDeny,
}: {
  open: boolean;
  tool?: string;
  input?: unknown;
  diff?: string;
  risk?: { level: "high"; reasons: string[] };
  /** 审批期间文件被改动：预览已重新生成，需要重新确认 */
  stale?: boolean;
  /** 子 Agent 发起的审批：显示来源，避免和主对话操作混淆 */
  agentDescription?: string;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <Dialog open={open} onClose={onDeny} labelledBy="mc-approval-title">
      <span className="mc-dialog__title" id="mc-approval-title">
        需要授权
      </span>
      <p className="mc-dialog__desc">
        {agentDescription ? (
          <>
            子 Agent「<strong>{agentDescription}</strong>」想使用{" "}
            <strong className="mc-mono">{tool}</strong>。
          </>
        ) : (
          <>
            MeowCode 想使用 <strong className="mc-mono">{tool}</strong>。
          </>
        )}
      </p>

      {stale ? (
        <p className="mc-dialog__desc" role="status">
          文件在审批期间被改动，下面的预览已重新生成，请重新确认。
        </p>
      ) : null}

      {risk ? (
        <div className="mc-dialog__risk" role="alert">
          <span className="mc-dialog__risktitle">高风险命令</span>
          <ul>
            {risk.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mc-dialog__body">
        <CodeBlock text={JSON.stringify(input ?? {}, null, 2)} />
        {diff ? <CodeBlock label="改动预览" text={diff} /> : null}
      </div>

      <div className="mc-dialog__footer">
        <Button variant="danger" onClick={onDeny}>
          拒绝
        </Button>
        <Button variant="primary" onClick={onApprove}>
          允许
        </Button>
      </div>
    </Dialog>
  );
}
