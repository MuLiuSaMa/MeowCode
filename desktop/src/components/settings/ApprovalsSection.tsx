import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuTrash2 } from "react-icons/lu";
import {
  clearApprovalRules,
  deleteApprovalRule,
  getApprovalRules,
  type ApprovalRule,
} from "../../api";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Section } from "../ui/Section";
import "./ApprovalsSection.css";

/** 设置 → 审批规则：列出本项目「不再询问」的规则，可逐条撤销或全部清空。 */
export function ApprovalsSection({
  workspace,
  onToast,
}: {
  workspace: string | null;
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getApprovalRules();
      setRules(result.rules);
    } catch {
      // 没有工作区或读取失败时按空列表展示
      setRules([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, workspace]);

  const remove = async (id: string) => {
    try {
      await deleteApprovalRule(id);
      setRules((current) => current.filter((rule) => rule.id !== id));
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error));
    }
  };

  const clearAll = async () => {
    setConfirmClear(false);
    try {
      await clearApprovalRules();
      setRules([]);
      onToast(t("approvals.cleared"));
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <div className="mc-settings__inner">
        <Section
          title={t("approvals.section")}
          description={t("approvals.desc")}
          action={
            <Button
              size="sm"
              variant="ghost"
              disabled={!rules.length}
              onClick={() => setConfirmClear(true)}
            >
              {t("approvals.clearAll")}
            </Button>
          }
        >
          {rules.length === 0 ? (
            <div className="mc-approvals__empty">
              {loading ? t("approvals.loading") : t("approvals.empty")}
            </div>
          ) : (
            <ul className="mc-approvals__list">
              {rules.map((rule) => (
                <li className="mc-approvals__item" key={rule.id}>
                  <div className="mc-approvals__text">
                    <span className="mc-approvals__tool">
                      {rule.tool}
                      <span className="mc-approvals__kind">
                        {t(`approvals.kind.${rule.match.kind}`)}
                      </span>
                    </span>
                    <span className="mc-approvals__value" title={rule.match.value}>
                      {rule.match.value}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("approvals.remove")}
                    title={t("approvals.remove")}
                    icon={<LuTrash2 size={13} />}
                    onClick={() => void remove(rule.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        labelledBy="mc-approvals-clear-title"
      >
        <span className="mc-dialog__title" id="mc-approvals-clear-title">
          {t("approvals.clearConfirmTitle")}
        </span>
        <p className="mc-dialog__desc">{t("approvals.clearConfirmDesc")}</p>
        <div className="mc-dialog__footer">
          <Button onClick={() => setConfirmClear(false)}>{t("actions.cancel")}</Button>
          <Button variant="danger" onClick={() => void clearAll()}>
            {t("approvals.clearAll")}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
