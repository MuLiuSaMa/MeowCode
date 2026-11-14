import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openAutomationSession, type Automation } from "../../api";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { SegmentedControl } from "../ui/SegmentedControl";
import { formatDateTime } from "./schedule";
import { decisionTone, statusTone } from "./AutomationPage";

/** 运行历史 / 决策记录：前者是「跑成了什么」，后者是「为什么没跑」 */
type HistoryTab = "history" | "decisions";

export function AutomationHistoryDialog({
  automation,
  onClose,
}: {
  automation: Automation | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("automation");
  const [tab, setTab] = useState<HistoryTab>("history");
  if (!automation) return null;
  const decisions = automation.decisions ?? [];
  return (
    <Dialog open={automation !== null} onClose={onClose} labelledBy="mc-auto-history-title">
      <span className="mc-dialog__title" id="mc-auto-history-title">
        {t("history.title", { title: automation.title })}
      </span>

      <SegmentedControl<HistoryTab>
        value={tab}
        ariaLabel={t("history.title", { title: automation.title })}
        options={[
          { value: "history", label: t("decision.tabHistory") },
          { value: "decisions", label: t("decision.tabDecision") },
        ]}
        onChange={setTab}
      />

      {tab === "history" ? (
        automation.history.length === 0 ? (
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
        )
      ) : decisions.length === 0 ? (
        <p className="mc-dialog__desc">{t("decision.empty")}</p>
      ) : (
        <div className="mc-auto__history">
          {decisions.map((entry) => (
            <div className="mc-auto__historyrow" key={entry.triggerId}>
              <span className="mc-auto__historytime">{formatDateTime(entry.at)}</span>
              <Badge tone={decisionTone(entry.outcome)}>
                {t(`decision.outcome.${entry.outcome}`)}
              </Badge>
              <span className="mc-auto__historyerror">{t(`autonomy.${entry.autonomy}`)}</span>
              {entry.plannedMessage ? (
                <span className="mc-auto__historyerror" title={entry.plannedMessage}>
                  {t("decision.planned")}: {entry.plannedMessage.slice(0, 120)}
                </span>
              ) : null}
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
