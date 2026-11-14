import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuAlarmClock, LuRefreshCw } from "react-icons/lu";
import {
  deleteAutomation,
  listAutomations,
  onAutomationsChanged,
  runAutomationNow,
  toggleAutomation,
  type Automation,
  type AutomationDecisionOutcome,
  type AutomationHistoryStatus,
} from "../../api";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Toggle } from "../ui/Toggle";
import { baseName, describeSchedule, formatDateTime } from "./schedule";
import { AutomationEditDialog } from "./AutomationEditDialog";
import { AutomationHistoryDialog } from "./AutomationHistoryDialog";
import "./automation.css";

/**
 * 自动化页（顶层视图，占主内容槽）：任务列表 + 编辑弹窗 + 运行历史。
 * 数据源是主进程调度器的全量广播（meow:automations-changed），触发/结算也会推过来，
 * 所以订阅一次广播即可保持最新；首次进入主动拉一遍。
 */
export function AutomationPage({
  workspace,
  projects,
}: {
  /** 当前工作区（新建任务的默认目标） */
  workspace: string | null;
  /** 已知项目列表（工作区选择器数据源） */
  projects: string[];
}) {
  const { t } = useTranslation("automation");
  const [list, setList] = useState<Automation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  /** 待确认删除的任务 id（删除有二次确认弹窗） */
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);

  const markBusy = useCallback((key: string, active: boolean) => {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      setList(await listAutomations());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 调度器触发/收尾/启停都会全量广播：直接替换列表
    return onAutomationsChanged((next) => setList(next));
  }, [refresh]);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>): Promise<void> => {
      markBusy(key, true);
      try {
        await action();
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        markBusy(key, false);
      }
    },
    [markBusy],
  );

  const toggleTask = useCallback(
    (automation: Automation, next: boolean) => {
      void run(`toggle:${automation.id}`, () => toggleAutomation(automation.id, next));
    },
    [run],
  );

  const runNow = useCallback(
    (automation: Automation) => {
      void run(`run:${automation.id}`, () => runAutomationNow(automation.id));
    },
    [run],
  );

  const removeTask = useCallback(
    (id: string) => {
      setDeleteId(null);
      void run(`delete:${id}`, () => deleteAutomation(id));
    },
    [run],
  );

  const deleteTarget = list?.find((item) => item.id === deleteId) ?? null;
  const historyTarget = list?.find((item) => item.id === historyId) ?? null;

  return (
    <div className="mc-auto__body">
      <div className="mc-auto__toolbar">
        <button
          type="button"
          className="mc-auto__reload"
          onClick={() => {
            setEditing(null);
            setEditOpen(true);
          }}
        >
          <LuAlarmClock size={13} />
          {t("actions.create")}
        </button>
        <button
          type="button"
          className="mc-auto__reload"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <LuRefreshCw size={13} className={refreshing ? "mc-auto__spin" : undefined} />
          {t("actions.refresh")}
        </button>
      </div>

      {error ? <p className="mc-auto__error">{error}</p> : null}
      {list === null && !error ? <p className="mc-auto__empty">{t("page.loading")}</p> : null}
      {list !== null && list.length === 0 ? <p className="mc-auto__empty">{t("page.empty")}</p> : null}

      <div className="mc-auto__rows">
        {(list ?? []).map((automation) => {
          const last = automation.history[0];
          const lastDecision = automation.decisions?.[0];
          const busy = busyKeys.has(`toggle:${automation.id}`) || busyKeys.has(`run:${automation.id}`);
          return (
            <div className="mc-auto__row" key={automation.id}>
              <div className="mc-auto__icon" data-disabled={!automation.enabled}>
                <LuAlarmClock size={16} />
              </div>
              <div className="mc-auto__rowinfo">
                <div className="mc-auto__rowname">
                  <span>{automation.title}</span>
                  {!automation.enabled ? <Badge>{t("status.disabled")}</Badge> : null}
                  {automation.autonomy !== "auto" ? (
                    <Badge tone={automation.autonomy === "observe" ? "neutral" : "danger"}>
                      {t(`autonomy.${automation.autonomy}`)}
                    </Badge>
                  ) : null}
                </div>
                <p className="mc-auto__rowdesc">
                  {describeSchedule(automation, t)} · {t("page.cwd", { cwd: baseName(automation.cwd) })}
                </p>
                <p className="mc-auto__rowsub">
                  {automation.enabled && automation.nextRunAt
                    ? t("page.nextRun", { time: formatDateTime(automation.nextRunAt) })
                    : t("page.noNextRun")}
                  {" · "}
                  {last
                    ? t("page.lastRun", {
                        status: t(`status.${last.status}`),
                        time: formatDateTime(last.at),
                      })
                    : t("page.neverRun")}
                  {lastDecision
                    ? ` · ${t("decision.last", {
                        outcome: t(`decision.outcome.${lastDecision.outcome}`),
                        time: formatDateTime(lastDecision.at),
                      })}`
                    : ""}
                  {" · "}
                  {t("page.runs", { count: automation.fireCount })}
                </p>
              </div>
              <div className="mc-auto__badges">
                <button
                  type="button"
                  className="mc-auto__ghost"
                  onClick={() => setHistoryId(automation.id)}
                >
                  {t("actions.history")}
                </button>
                <button
                  type="button"
                  className="mc-auto__ghost"
                  disabled={busy}
                  title={t("actions.runNow")}
                  onClick={() => runNow(automation)}
                >
                  {busyKeys.has(`run:${automation.id}`) ? t("actions.running") : t("actions.runNow")}
                </button>
                <button
                  type="button"
                  className="mc-auto__ghost"
                  onClick={() => {
                    setEditing(automation);
                    setEditOpen(true);
                  }}
                >
                  {t("actions.edit")}
                </button>
                <Toggle
                  checked={automation.enabled}
                  disabled={busyKeys.has(`toggle:${automation.id}`)}
                  label={t("actions.enable")}
                  onChange={(next) => toggleTask(automation, next)}
                />
                <button
                  type="button"
                  className="mc-auto__ghost"
                  onClick={() => setDeleteId(automation.id)}
                >
                  {t("actions.delete")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <AutomationEditDialog
        open={editOpen}
        initial={editing}
        workspace={workspace}
        projects={projects}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          void refresh();
        }}
      />

      <AutomationHistoryDialog
        automation={historyTarget}
        onClose={() => setHistoryId(null)}
      />

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteId(null)}
        labelledBy="mc-auto-delete-title"
      >
        <span className="mc-dialog__title" id="mc-auto-delete-title">
          {t("deleteDialog.title")}
        </span>
        <p className="mc-dialog__desc">{t("deleteDialog.desc", { title: deleteTarget?.title ?? "" })}</p>
        <div className="mc-dialog__footer">
          <Button variant="ghost" onClick={() => setDeleteId(null)}>
            {t("actions.cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={busyKeys.has(`delete:${deleteTarget?.id}`)}
            onClick={() => {
              if (deleteTarget) void removeTask(deleteTarget.id);
            }}
          >
            {t("actions.delete")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/** 状态徽标色调：历史弹窗与行内共用（started=running 其余按语义） */
export function statusTone(status: AutomationHistoryStatus): "success" | "danger" | "running" | "neutral" {
  if (status === "ok") return "success";
  if (status === "error") return "danger";
  if (status === "started") return "running";
  return "neutral";
}

/** 决策结果色调：没执行（observed / skipped）不是失败，别用红色 */
export function decisionTone(
  outcome: AutomationDecisionOutcome,
): "success" | "danger" | "running" | "neutral" {
  if (outcome === "executed") return "success";
  if (outcome === "failed") return "danger";
  if (outcome === "uncertain") return "running";
  return "neutral";
}
