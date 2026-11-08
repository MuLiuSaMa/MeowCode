import { useTranslation } from "react-i18next";
import { openAutomationSession, type Automation } from "../../api";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { formatDateTime } from "./schedule";
import { statusTone } from "./AutomationPage";

/** 运行历史弹窗：最新在前（主进程已排好），「打开会话」走托盘切换通道跳回那次运行 */
export function AutomationHistoryDialog({
  automation,
  onClose,
}: {
  automation: Automation | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("automation");
  if (!automation) return null;
  return (
    <Dialog open={automation !== null} onClose={onClose} labelledBy="mc-auto-history-title">
      <span className="mc-dialog__title" id="mc-auto-history-title">
        {t("history.title", { title: automation.title })}
      </span>
      {automation.history.length === 0 ? (
        <p className="mc-dialog__desc">{t("history.empty")}</p>
      ) : (
        <div className="mc-auto__history">
          {automation.history.map((entry, index) => (
            <div className="mc-auto__historyrow" key={`${entry.at}-${index}`}>
              <span className="mc-auto__historytime">{formatDateTime(entry.at)}</span>
              <Badge tone={statusTone(entry.status)}>{t(`status.${entry.status}`)}</Badge>
              {entry.error ? <span className="mc-auto__historyerror">{entry.error}</span> : null}
              {entry.sessionId ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void openAutomationSession(entry.sessionId ?? "")}
                >
                  {t("actions.openSession")}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <div className="mc-dialog__footer">
        <Button variant="ghost" onClick={onClose}>
          {t("actions.close")}
        </Button>
      </div>
    </Dialog>
  );
}
