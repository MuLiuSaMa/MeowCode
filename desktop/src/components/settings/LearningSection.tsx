import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuSparkles, LuRotateCcw, LuTrash2, LuUndo2 } from "react-icons/lu";
import {
  clearLearning,
  consolidateLearning,
  getLearning,
  getLearningSnapshot,
  manageLearnedSkill,
  setLearning,
  type LearnedSkillItem,
  type LearningSnapshot,
} from "../../api";
import { Button } from "../ui/Button";
import { FieldRow, Section } from "../ui/Section";
import { Spinner } from "../ui/Spinner";
import { Toggle } from "../ui/Toggle";
import "./LearningSection.css";

const STATUS_LABEL: Record<string, string> = {
  tentative: "learning.status.tentative",
  active: "learning.status.active",
  retired: "learning.status.retired",
};

/**
 * 自我学习分区。
 *
 * 与记忆分区的区别：记忆是用户可以直接改的事实，学习产物是 agent 自己写的、
 * 带试用期的经验 —— 所以这里以「看成效 + 一键退役」为主，不做全文编辑。
 * helped/hurt 是唯一需要人判断的东西：帮着忙的就留着，帮倒忙的让它退场。
 */
export function LearningSection({ onToast }: { onToast: (text: string) => void }) {
  const { t } = useTranslation("settings");
  const [snapshot, setSnapshot] = useState<LearningSnapshot | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /** 清除所有学到的：二次确认，4 秒后自动复位（与记忆删除同范式） */
  const [confirmingClear, setConfirmingClear] = useState(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getLearningSnapshot();
      setSnapshot(result);
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("learning.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [onToast, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    getLearning()
      .then((result) => {
        if (!cancelled) setEnabled(result.enabled);
      })
      .catch(() => {
        // 查询失败按默认值（关）展示：这是实验性能力，不该因为读失败就默认打开
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    [],
  );

  const toggle = async (value: boolean) => {
    const previous = enabled;
    setEnabled(value);
    try {
      await setLearning(value);
      await window.meow.saveProviderPrefs({ selfLearning: value });
    } catch (error) {
      setEnabled(previous ?? true);
      onToast(error instanceof Error ? error.message : t("learning.toggleFailed"));
    }
  };

  const act = async (action: "delete" | "reactivate" | "rollback", skill: LearnedSkillItem) => {
    setBusy(true);
    try {
      const result = await manageLearnedSkill(action, skill.scope, skill.name);
      if (!result.ok) onToast(t("learning.actionFailed"));
      await refresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("learning.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const consolidate = async () => {
    setBusy(true);
    try {
      const result = await consolidateLearning();
      onToast(
        result.applied.length
          ? t("learning.consolidated", { count: result.applied.length })
          : t("learning.consolidatedEmpty"),
      );
      await refresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("learning.consolidateFailed"));
    } finally {
      setBusy(false);
    }
  };

  /** 二次确认后才真的清：这个动作不可撤销，点错一次就全没了 */
  const clearAll = async () => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
    if (!confirmingClear) {
      setConfirmingClear(true);
      clearTimer.current = setTimeout(() => setConfirmingClear(false), 4000);
      return;
    }
    setConfirmingClear(false);
    setBusy(true);
    try {
      const result = await clearLearning();
      onToast(
        result.cleared.length
          ? t("learning.cleared", { scopes: result.cleared.length })
          : t("learning.clearedNothing"),
      );
      await refresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("learning.clearFailed"));
    } finally {
      setBusy(false);
    }
  };

  const skills = snapshot?.skills ?? [];
  const guidelines = (snapshot?.guidelines ?? []).filter((item) => item.status !== "retired");
  const traits = (snapshot?.profile ?? []).filter((item) => item.status !== "retired");

  const renderSkills = () => (
    <Section title={t("learning.skillsTitle")} description={t("learning.skillsDesc")}>
      <div className="mc-learning">
        <div className="mc-learning__toolbar">
          <span className="mc-learning__count">
            {loading ? null : <strong>{t("learning.skillCount", { count: skills.length })}</strong>}
          </span>
          <Button
            size="sm"
            variant="outline"
            icon={<LuSparkles size={14} />}
            disabled={busy || !enabled}
            onClick={() => void consolidate()}
          >
            {t("learning.consolidate")}
          </Button>
        </div>
        {loading ? (
          <div className="mc-learning__loading">
            <Spinner size={16} />
          </div>
        ) : skills.length === 0 ? (
          <p className="mc-learning__empty">{t("learning.skillsEmpty")}</p>
        ) : (
          <ul className="mc-learning__list">
            {skills.map((skill) => {
              const stats = snapshot?.ledger[`${skill.scope}:skill:${skill.name}`];
              return (
                <li key={`${skill.scope}:${skill.name}`} className="mc-learning__row">
                  <div className="mc-learning__main">
                    <span className="mc-learning__name">{skill.name}</span>
                    <span className="mc-learning__desc">{skill.description}</span>
                  </div>
                  <span className={`mc-learning__badge mc-learning__badge--${skill.status}`}>
                    {t(STATUS_LABEL[skill.status] ?? skill.status)}
                  </span>
                  <span className="mc-learning__stats" title={t("learning.statsHint")}>
                    <span className="mc-learning__helped">+{stats?.helped ?? 0}</span>
                    <span className="mc-learning__hurt">−{stats?.hurt ?? 0}</span>
                  </span>
                  <div className="mc-learning__actions">
                    {skill.revision > 1 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={t("learning.rollbackAria", { name: skill.name })}
                        onClick={() => void act("rollback", skill)}
                      >
                        <LuUndo2 size={14} />
                      </Button>
                    ) : null}
                    {skill.status === "retired" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={t("learning.reactivateAria", { name: skill.name })}
                        onClick={() => void act("reactivate", skill)}
                      >
                        <LuRotateCcw size={14} />
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t("learning.deleteAria", { name: skill.name })}
                      onClick={() => void act("delete", skill)}
                    >
                      <LuTrash2 size={14} />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );

  return (
    <div className="mc-settings__inner">
      <Section
        title={t("learning.title")}
        description={t("learning.desc")}
        badge={<span className="mc-learning__beta">BETA</span>}
      >
        <FieldRow label={t("learning.toggleField")}>
          {enabled === null ? (
            <Spinner size={16} />
          ) : (
            <Toggle checked={enabled} onChange={(value) => void toggle(value)} label={t("learning.toggleField")} />
          )}
        </FieldRow>
        <FieldRow label={t("learning.budgetField")}>
          <span className="mc-learning__muted">
            {snapshot
              ? t("learning.budgetValue", { count: snapshot.dailyCalls.count, date: snapshot.dailyCalls.date || "—" })
              : "—"}
          </span>
        </FieldRow>
        <FieldRow label={t("learning.clearField")} hint={t("learning.clearHint")}>
          <Button
            size="sm"
            variant={confirmingClear ? "danger" : "outline"}
            disabled={busy}
            onClick={() => void clearAll()}
          >
            {confirmingClear ? t("learning.clearConfirm") : t("learning.clearAction")}
          </Button>
        </FieldRow>
      </Section>

      {renderSkills()}

      <Section title={t("learning.guidelinesTitle")} description={t("learning.guidelinesDesc")}>
        {loading ? (
          <div className="mc-learning__loading">
            <Spinner size={16} />
          </div>
        ) : guidelines.length === 0 ? (
          <p className="mc-learning__empty">{t("learning.guidelinesEmpty")}</p>
        ) : (
          <ul className="mc-learning__plain">
            {guidelines.map((item) => (
              <li key={item.id}>
                <span className="mc-learning__name">{item.text}</span>
                <span className="mc-learning__trigger">
                  {Object.entries(item.trigger)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("learning.profileTitle")} description={t("learning.profileDesc")}>
        {loading ? (
          <div className="mc-learning__loading">
            <Spinner size={16} />
          </div>
        ) : traits.length === 0 ? (
          <p className="mc-learning__empty">{t("learning.profileEmpty")}</p>
        ) : (
          <ul className="mc-learning__plain">
            {traits.map((item) => (
              <li key={`${item.dimension}:${item.statement}`}>
                <span className="mc-learning__name">{item.statement}</span>
                <span className="mc-learning__trigger">
                  {t(`learning.dimension.${item.dimension}`, item.dimension)} · {item.confidence.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
