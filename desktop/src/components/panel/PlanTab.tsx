import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuFileText, LuListChecks, LuRotateCw } from "react-icons/lu";
import { api, type WorkflowRoadmap } from "../../api";
import { MarkdownDocument } from "../ui/MarkdownDocument";
import { OpenWithButton } from "./OpenWithButton";
import "./PlanTab.css";

function joinWorkspacePath(workspace: string, relative: string): string {
  const base = workspace.replace(/[\\/]+$/, "");
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base}${separator}${relative.replace(/[\\/]+/g, separator)}`;
}

type PlanDocState = {
  status: "idle" | "loading" | "ready" | "error";
  content?: string;
  message?: string;
};

const LANE_STATUS_KEYS: Record<string, string> = {
  queued: "laneStatus.queued",
  active: "laneStatus.active",
  done: "laneStatus.done",
  blocked: "laneStatus.blocked",
};

/** 治理 roadmap：tier 徽章 + 每个 lane 的 G4/G5/G6 门禁状态。 */
function RoadmapSection({ roadmap }: { roadmap: WorkflowRoadmap }) {
  const { t } = useTranslation("panel");
  return (
    <section className="mc-plan__roadmap" data-completed={roadmap.completed}>
      <div className="mc-plan__roadmaphead">
        <LuListChecks size={13} />
        <span>{t("plan.governance", { tier: roadmap.tier })}</span>
        <span className="mc-plan__roadmapstate">
          {roadmap.completed ? t("plan.allPassed") : t("plan.inProgress")}
        </span>
      </div>
      {roadmap.lanes.length ? (
        <div className="mc-plan__lanes">
          {roadmap.lanes.map((lane) => (
            <div className="mc-plan__lane" key={lane.id} data-status={lane.status}>
              <div className="mc-plan__lanehead">
                <span className="mc-plan__laneid">{lane.id}</span>
                <span className="mc-plan__laneobjective mc-truncate" title={lane.objective}>
                  {lane.objective}
                </span>
                <span className="mc-plan__lanestate">
                  {LANE_STATUS_KEYS[lane.status] ? t(LANE_STATUS_KEYS[lane.status]) : lane.status}
                </span>
              </div>
              <div className="mc-plan__gates">
                {Object.keys(lane.gates ?? {}).map((gate) => (
                  <span
                    className="mc-plan__gate"
                    data-state={lane.gates?.[gate] ?? "pending"}
                    key={gate}
                  >
                    {gate}
                  </span>
                ))}
                {lane.repairCount ? (
                  <span className="mc-plan__repairs">{t("plan.repairs", { count: lane.repairCount })}</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mc-plan__hint">{t("plan.trivial")}</p>
      )}
    </section>
  );
}

/**
 * 计划页签：显示计划模式下写出的 Markdown 计划文档。
 * 写入过程中（plans/ 下的写工具进行中）顶部显示「正在写入」，内容区保留上一版并压暗；
 * 每次 plan_documented（version 变化）重新读盘，保证看到的是落盘后的最新版本。
 * 治理 run 活跃时，顶部额外展示 roadmap（lanes 与 gate 状态）。
 */
export function PlanTab({
  path,
  writing,
  version,
  workspace,
  roadmap,
}: {
  /** 计划文档的工作区相对路径；空 = 还没生成过 */
  path?: string | null;
  /** plans/ 下的写操作正在进行 */
  writing?: boolean;
  /** 每次写完后递增：强制重新读取文件 */
  version?: number;
  workspace?: string;
  /** 治理 roadmap 快照；无治理 run 时为空 */
  roadmap?: WorkflowRoadmap | null;
}) {
  const { t } = useTranslation("panel");
  const [state, setState] = useState<PlanDocState>({ status: "idle" });
  const [reload, setReload] = useState(0);
  /** 写入中首次读盘必然 ENOENT：不当作错误，等写完的 version 变化再读 */
  const writingRef = useRef(Boolean(writing));
  useEffect(() => {
    writingRef.current = Boolean(writing);
  }, [writing]);

  useEffect(() => {
    if (!path) {
      setState({ status: "idle" });
      return;
    }
    let disposed = false;
    // 有旧内容时保留（写入中页面不闪白），首次加载才显示 loading
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    void api<{ content: string }>(`/workspace/file?path=${encodeURIComponent(path)}`)
      .then((result) => {
        if (!disposed) setState({ status: "ready", content: result.content });
      })
      .catch((error: unknown) => {
        if (disposed || writingRef.current) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
    };
    // writing 变化时也重读：写入失败（没有 plan_documented）时能把错误显示出来
  }, [path, version, reload, writing]);

  if (!path) {
    return (
      <div className="mc-plan">
        {roadmap ? <RoadmapSection roadmap={roadmap} /> : null}
        <div className="mc-plan__empty">
          <span className="mc-plan__emptyicon" aria-hidden>
            <LuFileText size={20} />
          </span>
          <p className="mc-plan__emptytitle">{t("plan.emptyTitle")}</p>
          <p className="mc-plan__emptyhint">
            {t("plan.emptyHint")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mc-plan" data-writing={Boolean(writing)}>
      {roadmap ? <RoadmapSection roadmap={roadmap} /> : null}
      <div className="mc-plan__head">
        <LuFileText size={13} className="mc-plan__headicon" />
        <span className="mc-plan__path mc-truncate" title={path}>
          {path}
        </span>
        {writing ? (
          <span className="mc-plan__status">
            <span className="mc-plan__spinner" aria-hidden />
            {state.status === "ready" ? t("plan.updating") : t("plan.writing")}
          </span>
        ) : null}
        <button
          type="button"
          className="mc-plan__btn"
          aria-label={t("plan.reload")}
          title={t("plan.reload")}
          onClick={() => setReload((current) => current + 1)}
        >
          <LuRotateCw size={13} />
        </button>
        <OpenWithButton
          target={workspace ? joinWorkspacePath(workspace, path) : null}
          disabled={!workspace}
        />
      </div>

      <div className="mc-plan__body">
        {state.status === "error" ? (
          <p className="mc-plan__hint">{state.message}</p>
        ) : writing && !state.content ? (
          <p className="mc-plan__hint">{t("plan.writingBody")}</p>
        ) : state.status === "loading" ? (
          <p className="mc-plan__hint">{t("plan.loadingBody")}</p>
        ) : (
          <MarkdownDocument
            content={state.content ?? ""}
            docPath={path}
            workspace={workspace}
            className="mc-plan__markdown"
          />
        )}
      </div>
    </div>
  );
}
