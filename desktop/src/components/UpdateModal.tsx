import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuDownload, LuFileText, LuRefreshCw } from "react-icons/lu";
import {
  downloadUpdate,
  onUpdateProgress,
  openInstaller,
  type UpdateInfo,
  type UpdateProgress,
} from "../api";
import { formatNumber } from "../i18n/format";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import "./UpdateModal.css";

type Phase = "idle" | "downloading" | "done" | "error";

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 1024))} KB`;
  return `${formatNumber(bytes / (1024 * 1024), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} MB`;
}

/**
 * 更新弹窗：版本号 / 更新说明 / 下载进度 / 打开安装包。
 * 流程参考 NexBox 的 UpdateModal：下载在主进程流式进行，进度经 IPC 推回来，
 * 下完给「打开安装包」——Windows 上启动安装包后应用会退出（安装包要覆盖运行中的文件）。
 */
export function UpdateModal({
  open,
  release,
  currentVersion,
  silent = null,
  onClose,
}: {
  open: boolean;
  release: UpdateInfo | null;
  currentVersion?: string;
  /** 后台静默下载状态：下载中禁用手动下载（避免两路写同一文件），已完成直接给「打开安装包」 */
  silent?: { downloading: boolean; path: string | null } | null;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UpdateProgress>({
    received: 0,
    total: 0,
    percent: 0,
  });
  const [filePath, setFilePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation("shell");

  // 每次打开都从头开始：上一次下载到一半的进度不该带进来
  useEffect(() => {
    if (!open) return;
    setPhase("idle");
    setProgress({ received: 0, total: 0, percent: 0 });
    setFilePath(null);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return onUpdateProgress((next) => setProgress(next));
  }, [open]);

  const asset = release?.asset ?? null;

  const startDownload = async () => {
    if (!asset || phase === "downloading" || silent?.downloading) return;
    setPhase("downloading");
    setError(null);
    try {
      const result = await downloadUpdate({ url: asset.url, fileName: asset.name });
      setFilePath(result.path);
      setPhase("done");
    } catch (downloadError) {
      setPhase("error");
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    }
  };

  // 静默下载进行中/已完成时，手动下载让路
  const silentDonePath = silent && !silent.downloading ? silent.path : null;
  const busy = phase === "downloading" || Boolean(silent?.downloading);
  const finished = phase === "done" || Boolean(silentDonePath);

  const install = async () => {
    // 静默下载已完成的优先用它的产物，否则用本弹窗自己下的
    const target = silentDonePath ?? filePath;
    if (!target) return;
    try {
      await openInstaller(target);
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError));
    }
  };

  const percent = progress.percent || 0;

  return (
    <Dialog open={open} onClose={onClose} className="mc-gitdlg mc-updatemodal">
      <h2 className="mc-gitdlg__title">
        {t("notice.updateAvailable", { version: release?.version ?? "" })}
        {currentVersion ? (
          <span className="mc-updatemodal__current">
            {t("updateModal.currentVersion", { version: currentVersion })}
          </span>
        ) : null}
      </h2>

      {!asset ? (
        <p className="mc-updatemodal__asset" data-kind="warn">
          <LuFileText size={13} />
          {t("updateModal.noAsset")}
        </p>
      ) : null}

      <div className="mc-updatemodal__notes">
        {release?.notes?.trim() ? (
          release.notes.trim()
        ) : (
          <span className="mc-updatemodal__nonotes">{t("updateModal.noNotes")}</span>
        )}
      </div>

      {busy || phase === "done" ? (
        <div className="mc-updatemodal__progress">
          <div className="mc-updatemodal__bar">
            <div className="mc-updatemodal__fill" style={{ width: `${Math.min(100, percent)}%` }} />
          </div>
          <span className="mc-updatemodal__progresstext">
            {finished
              ? t("updateModal.downloadDone")
              : t("updateModal.downloading", { percent: formatNumber(percent) }) +
                (progress.total
                  ? t("updateModal.downloadSize", {
                      received: formatSize(progress.received),
                      total: formatSize(progress.total),
                    })
                  : "")}
          </span>
        </div>
      ) : null}

      {error ? <p className="mc-updatemodal__error">{error}</p> : null}

      <div className="mc-gitdlg__actions">
        {finished ? (
          <>
            <Button onClick={onClose}>{t("updateModal.later")}</Button>
            <Button variant="primary" icon={<LuRefreshCw size={13} />} onClick={() => void install()}>
              {t("updateModal.restart")}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              {t("updateModal.cancel")}
            </Button>
            <Button
              variant="primary"
              icon={<LuDownload size={13} />}
              disabled={!asset || busy}
              onClick={() => void startDownload()}
            >
              {busy ? t("updateModal.downloadingShort") : t("updateModal.download")}
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
