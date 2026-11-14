import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuFolder, LuListChecks, LuPencil, LuPlus, LuTrash2 } from "react-icons/lu";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Checkbox, CheckboxBox } from "../ui/Checkbox";
import { Dialog } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Section } from "../ui/Section";
import "./ProjectsSection.css";

function projectName(cwd: string, names: Record<string, string>): string {
  const custom = names[cwd]?.trim();
  if (custom) return custom;
  return folderName(cwd);
}

function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

export function ProjectsSection({
  projects,
  activeProject,
  projectNames,
  onAddProject,
  onRenameProject,
  onRemoveProject,
  onRemoveProjects,
}: {
  projects: string[];
  /** 当前项目（会话 cwd 优先，其次默认工作区） */
  activeProject: string;
  projectNames: Record<string, string>;
  onAddProject: () => void;
  /** 只改显示名；空名恢复文件夹名 */
  onRenameProject: (cwd: string, name: string) => void;
  /** 只从列表隐藏，不删除会话与磁盘文件 */
  onRemoveProject: (cwd: string) => void;
  /** 批量移除：一次写入，避免逐条保存互相覆盖 */
  onRemoveProjects?: (cwds: string[]) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tChat } = useTranslation("chat");
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  /** 批量管理：多选后一次移除（当前项目不可选，与单条删除一致） */
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingBatchRemove, setPendingBatchRemove] = useState(false);
  const selectable = projects.filter((cwd) => cwd !== activeProject);

  const startRename = (cwd: string) => {
    setEditingProject(cwd);
    setNameDraft(projectNames[cwd] ?? "");
  };

  const toggleSelect = (cwd: string) =>
    setSelected((prev) =>
      prev.includes(cwd) ? prev.filter((item) => item !== cwd) : [...prev, cwd],
    );

  const commitRename = () => {
    if (!editingProject) return;
    onRenameProject(editingProject, nameDraft);
    setEditingProject(null);
  };

  return (
    <div className="mc-settings__inner">
      <Section
        title={t("sections.projects")}
        description={t("projects.desc")}
        action={
          batchMode ? (
            <div className="mc-projects__batchactions">
              <Checkbox
                checked={selectable.length > 0 && selected.length === selectable.length}
                disabled={selectable.length === 0}
                label={t("projects.batchSelectAll")}
                ariaLabel={t("projects.batchSelectAll")}
                onChange={(next) => setSelected(next ? selectable : [])}
              />
              <span className="mc-projects__batchcount">
                {t("projects.batchSelected", { count: selected.length })}
              </span>
              <Button size="sm" onClick={() => setBatchMode(false)}>
                {t("projects.batchCancel")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={selected.length === 0}
                onClick={() => setPendingBatchRemove(true)}
              >
                {selected.length
                  ? t("projects.batchRemoveCount", { count: selected.length })
                  : t("projects.batchRemove")}
              </Button>
            </div>
          ) : (
            <div className="mc-projects__batchactions">
              {selectable.length > 0 ? (
                <Button
                  size="sm"
                  icon={<LuListChecks size={14} />}
                  onClick={() => {
                    setSelected([]);
                    setBatchMode(true);
                  }}
                >
                  {t("projects.batchManage")}
                </Button>
              ) : null}
              <Button
                variant="primary"
                size="sm"
                icon={<LuPlus size={14} />}
                onClick={onAddProject}
              >
                {t("projects.add")}
              </Button>
            </div>
          )
        }
      >
        <div className="mc-projects">
          {projects.length === 0 ? (
            <p className="mc-projects__empty">{t("projects.empty")}</p>
          ) : (
            <div className="mc-projects__list">
              {projects.map((cwd) => {
                const active = cwd === activeProject;
                const checked = selected.includes(cwd);
                return (
                  <div
                    className="mc-projects__row"
                    key={cwd}
                    data-active={active}
                    data-batch={batchMode || undefined}
                    data-selected={batchMode && checked ? "true" : undefined}
                    data-disabled={batchMode && active ? "true" : undefined}
                    role={batchMode ? "checkbox" : undefined}
                    aria-checked={batchMode ? checked : undefined}
                    aria-disabled={batchMode && active ? true : undefined}
                    tabIndex={batchMode && !active ? 0 : -1}
                    title={batchMode && active ? t("projects.batchActiveHint") : undefined}
                    onClick={batchMode && !active ? () => toggleSelect(cwd) : undefined}
                    onKeyDown={(event) => {
                      if (!batchMode || active) return;
                      if (event.key !== " " && event.key !== "Enter") return;
                      event.preventDefault();
                      toggleSelect(cwd);
                    }}
                  >
                    <span className="mc-projects__select" aria-hidden="true">
                      <CheckboxBox checked={batchMode && checked} />
                    </span>
                    <LuFolder size={16} className="mc-projects__icon" />
                    <span className="mc-projects__text">
                      <span className="mc-projects__name">
                        <span className="mc-truncate" title={cwd}>
                          {projectName(cwd, projectNames)}
                        </span>
                        {active ? <Badge tone="running">{t("models.active")}</Badge> : null}
                      </span>
                      <span className="mc-projects__path mc-truncate" title={cwd}>
                        {cwd}
                      </span>
                    </span>
                    {batchMode ? null : (
                      <span className="mc-projects__actions">
                        <IconButton
                          label={tChat("conversation.renameProject.title")}
                          size="sm"
                          onClick={() => startRename(cwd)}
                        >
                          <LuPencil size={14} />
                        </IconButton>
                        {active ? null : (
                          <IconButton
                            label={t("projects.removeTitle")}
                            size="sm"
                            onClick={() => setPendingRemove(cwd)}
                          >
                            <LuTrash2 size={14} />
                          </IconButton>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <Dialog
        open={editingProject !== null}
        onClose={() => setEditingProject(null)}
        labelledBy="mc-project-rename-title"
      >
        <span className="mc-dialog__title" id="mc-project-rename-title">
          {tChat("conversation.renameProject.title")}
        </span>
        <p className="mc-dialog__desc">{tChat("conversation.renameProject.description")}</p>
        <input
          className="mc-dialog__input"
          value={nameDraft}
          placeholder={editingProject ? folderName(editingProject) : ""}
          onChange={(event) => setNameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename();
          }}
          autoFocus
        />
        <div className="mc-dialog__footer">
          <Button onClick={() => setEditingProject(null)}>{t("actions.cancel")}</Button>
          <Button variant="primary" onClick={commitRename}>
            {t("actions.save")}
          </Button>
        </div>
      </Dialog>

      <Dialog open={pendingRemove !== null} onClose={() => setPendingRemove(null)}>
          <h2 className="mc-dialog__title">{t("projects.removeTitle")}</h2>
          <p className="mc-dialog__desc">
            {t("projects.removeMessage", {
              name: pendingRemove ? projectName(pendingRemove, projectNames) : "",
            })}
          </p>
          <div className="mc-dialog__footer">
            <Button onClick={() => setPendingRemove(null)}>{t("actions.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingRemove) onRemoveProject(pendingRemove);
                setPendingRemove(null);
              }}
            >
              {t("projects.removeConfirm")}
            </Button>
          </div>
        </Dialog>

      <Dialog open={pendingBatchRemove} onClose={() => setPendingBatchRemove(false)}>
        <h2 className="mc-dialog__title">{t("projects.batchRemoveTitle")}</h2>
        <p className="mc-dialog__desc">
          {t("projects.batchRemoveMessage", { count: selected.length })}
        </p>
        <div className="mc-dialog__footer">
          <Button onClick={() => setPendingBatchRemove(false)}>{t("actions.cancel")}</Button>
          <Button
            variant="danger"
            onClick={() => {
              const cwds = [...selected];
              setPendingBatchRemove(false);
              setBatchMode(false);
              setSelected([]);
              if (!cwds.length) return;
              if (onRemoveProjects) onRemoveProjects(cwds);
              else for (const cwd of cwds) onRemoveProject(cwd);
            }}
          >
            {t("projects.removeConfirm")}
          </Button>
        </div>
      </Dialog>
      </Section>
    </div>
  );
}
