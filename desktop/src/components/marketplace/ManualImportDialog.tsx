import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuFolderOpen, LuInfo, LuTriangleAlert, LuUpload } from "react-icons/lu";
import { importManualItem } from "../../api";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import "./PlatformOauthDialog.css";
import "./CommunitySubmitDialog.css";
import "./AddDialog.css";

const PLUGIN_FILE_ACCEPT = ".ts,.mts,.js,.mjs,.cjs";

function baseName(target: string): string {
  const normalized = target.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/);
  return segments[segments.length - 1] ?? "";
}

function parentName(target: string): string {
  const normalized = target.replace(/[\\/]+$/, "");
  const cut = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return cut >= 0 ? baseName(normalized.slice(0, cut)) : "";
}

type Picked = { path: string; label: string; mode: "file" | "dir" };

/**
 * 手动导入弹窗（「我的」栏）：skill 选 SKILL.md（复制其所在目录），plugin 选源码
 * 单文件或目录。id 由所选路径推导展示，导入动作在 agent server 侧完成。
 *
 * 尺寸与「添加 MCP」弹窗一致（mc-adddlg）：选择区撑满正文，底部按钮常驻。
 */
export function ManualImportDialog({
  open,
  type,
  onClose,
  onImported,
}: {
  open: boolean;
  type: "skill" | "plugin";
  onClose: () => void;
  onImported: (id: string) => void;
}) {
  const { t } = useTranslation("marketplace");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [phase, setPhase] = useState<"form" | "importing">("form");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dirInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setPhase("form");
    setError("");
  }, [open, type]);

  const pickFile = useCallback(
    (list: FileList | null) => {
      const file = list?.[0];
      if (!file) return;
      const filePath = window.meow.getFilePath(file);
      if (!filePath) {
        setError(t("submit.noFilePath"));
        return;
      }
      setError("");
      setPicked({ path: filePath, label: file.name, mode: "file" });
    },
    [t],
  );

  const pickDir = useCallback(
    (list: FileList | null) => {
      const file = list?.[0];
      if (!file) return;
      const filePath = window.meow.getFilePath(file);
      const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      if (!filePath || !relative) {
        setError(t("submit.noFilePath"));
        return;
      }
      // webkitRelativePath = "<根目录>/…"：文件绝对路径截掉尾部相对段即根目录
      const root = filePath.slice(0, filePath.length - relative.length).replace(/[\\/]+$/, "");
      setError("");
      setPicked({ path: root, label: relative.split(/[\\/]/)[0] ?? root, mode: "dir" });
    },
    [t],
  );

  const derivedId = useMemo(() => {
    if (!picked) return "";
    if (type === "skill") return parentName(picked.path);
    return picked.mode === "dir" ? baseName(picked.path) : baseName(picked.path).replace(/\.[^.]+$/, "");
  }, [picked, type]);

  const submit = useCallback(async () => {
    if (!picked || phase !== "form") return;
    setPhase("importing");
    setError("");
    try {
      const result = await importManualItem(type, picked.path);
      onImported(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("form");
    }
  }, [picked, phase, type, onImported]);

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (phase !== "importing") onClose();
      }}
      labelledBy="mc-mine-import-title"
      className="mc-mkt__dialog mc-adddlg"
    >
      <div className="mc-adddlg__head">
        <span className="mc-dialog__title" id="mc-mine-import-title">
          {type === "skill" ? t("mine.import.skillTitle") : t("mine.import.pluginTitle")}
        </span>
        <p className="mc-adddlg__desc">
          {type === "skill" ? t("mine.import.skillDesc") : t("mine.import.pluginDesc")}
        </p>
      </div>

      <div className="mc-adddlg__body">
        <div className="mc-adddlg__pick">
          {type === "skill" ? (
            <LuUpload size={22} aria-hidden />
          ) : (
            <LuFolderOpen size={22} aria-hidden />
          )}
          <span className="mc-adddlg__picktitle">
            {type === "skill" ? t("mine.import.pickSkill") : t("mine.import.pickPlugin")}
          </span>
          <p className="mc-adddlg__pickhint">{picked?.label ?? t("actions.none")}</p>
          <div className="mc-adddlg__pickactions">
            {type === "skill" ? (
              <button
                type="button"
                className="mc-community__pick"
                disabled={phase !== "form"}
                onClick={() => fileInputRef.current?.click()}
              >
                <LuUpload size={14} />
                {t("mine.import.pickSkillBtn")}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="mc-community__pick"
                  disabled={phase !== "form"}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <LuUpload size={14} />
                  {t("mine.import.pickFileBtn")}
                </button>
                <button
                  type="button"
                  className="mc-community__pick"
                  disabled={phase !== "form"}
                  onClick={() => dirInputRef.current?.click()}
                >
                  <LuFolderOpen size={14} />
                  {t("mine.import.pickDirBtn")}
                </button>
              </>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={type === "skill" ? ".md" : PLUGIN_FILE_ACCEPT}
            hidden
            onChange={(event) => {
              pickFile(event.target.files);
              event.target.value = "";
            }}
          />
          {/* 目录导入：webkitDirectory 非标准属性，React 需要散传 */}
          <input
            ref={dirInputRef}
            type="file"
            hidden
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(event) => {
              pickDir(event.target.files);
              event.target.value = "";
            }}
          />
        </div>

        {picked ? (
          <p className="mc-adddlg__summary">
            <LuInfo size={13} aria-hidden />
            {t("mine.import.importAs", { id: derivedId || t("mine.import.idInvalid") })}
          </p>
        ) : null}

        {type === "plugin" ? (
          <p className="mc-oauth__fieldhint mc-mine__risk">
            <LuTriangleAlert size={13} />
            {t("mine.import.pluginRisk")}
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="mc-oauth__error mc-adddlg__error">
          <LuTriangleAlert size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="mc-dialog__footer mc-adddlg__foot">
        <Button variant="ghost" disabled={phase === "importing"} onClick={onClose}>
          {t("actions.cancel")}
        </Button>
        <Button variant="primary" disabled={!picked || phase !== "form"} onClick={() => void submit()}>
          {phase === "importing" ? t("mine.import.importing") : t("mine.import.confirm")}
        </Button>
      </div>
    </Dialog>
  );
}
