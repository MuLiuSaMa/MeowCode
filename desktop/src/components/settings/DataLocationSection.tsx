import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Section } from "../ui/Section";
import "./DataLocationSection.css";

/**
 * 本地数据：展示 userData 的实际位置，支持打开文件夹和迁移到新位置。
 * 迁移由主进程复制必要数据并写位置指针，随后重启应用生效。
 */
export function DataLocationSection({ onToast }: { onToast: (text: string) => void }) {
  const { t } = useTranslation("settings");
  const [path, setPath] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.meow
      .getDataLocation()
      .then((result) => {
        if (!cancelled) setPath(result.path);
      })
      .catch(() => {
        // 读不到位置不影响其它设置项
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openFolder = async () => {
    if (!path) return;
    const error = await window.meow.openPath(path);
    if (error) onToast(error);
  };

  const chooseFolder = async () => {
    const selected = await window.meow.pickDataDirectory().catch(() => null);
    if (selected) setTarget(selected);
  };

  const confirmMove = async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      const result = await window.meow.changeDataLocation(target);
      if (!result.ok) {
        const key =
          result.code === "not_empty"
            ? "errors.not_empty"
            : result.code === "same_path"
              ? "errors.same_path"
              : "errors.failed";
        onToast(t(`dataLocation.${key}`));
        setBusy(false);
        setTarget(null);
        return;
      }
      onToast(t("dataLocation.restarting"));
      // 主进程随后 relaunch；保持 busy，避免重复点击
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("dataLocation.errors.failed"));
      setBusy(false);
      setTarget(null);
    }
  };

  return (
    <>
      <Section title={t("dataLocation.section")} description={t("dataLocation.desc")}>
        <div className="mc-dataloc">
          <div className="mc-dataloc__text">
            <span className="mc-dataloc__label">{t("dataLocation.field")}</span>
            <span className="mc-dataloc__path" title={path ?? undefined}>
              {path ?? t("dataLocation.loading")}
            </span>
          </div>
          <div className="mc-dataloc__actions">
            <Button
              size="sm"
              variant="outline"
              disabled={!path || busy}
              onClick={() => void openFolder()}
            >
              {t("dataLocation.open")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!path || busy}
              onClick={() => void chooseFolder()}
            >
              {t("dataLocation.change")}
            </Button>
          </div>
        </div>
      </Section>

      <Dialog
        open={target !== null}
        onClose={() => {
          if (!busy) setTarget(null);
        }}
        labelledBy="mc-dataloc-confirm-title"
      >
        <span className="mc-dialog__title" id="mc-dataloc-confirm-title">
          {t("dataLocation.confirmTitle")}
        </span>
        <p className="mc-dialog__desc">{t("dataLocation.confirmDesc")}</p>
        <p className="mc-dataloc__target" title={target ?? undefined}>
          {target}
        </p>
        <div className="mc-dialog__footer">
          <Button disabled={busy} onClick={() => setTarget(null)}>
            {t("actions.cancel")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void confirmMove()}>
            {busy ? t("dataLocation.moving") : t("dataLocation.move")}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
