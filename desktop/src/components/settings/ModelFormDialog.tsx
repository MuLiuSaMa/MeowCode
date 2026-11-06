import { useTranslation } from "react-i18next";
import { findTemplate } from "../../data/providerCatalog";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { ProviderFormBody, useProviderForm } from "./ProviderFormBody";
import type { ProviderSettings } from "../../api";
import "./ModelsSection.css";

/**
 * 服务商弹层：表单体与首次启动引导共用，这里只负责弹窗外壳与页脚。
 * 存储仍是「一条 = 一个模型」，保存时统一展开成多条 ProviderSettings。
 */
export function ModelFormDialog({
  draft,
  entries,
  onClose,
  onSave,
}: {
  draft: ProviderSettings;
  /** 同一服务商下已有的模型条目（编辑时传入；新建为空） */
  entries: ProviderSettings[];
  onClose: () => void;
  onSave: (entries: ProviderSettings[]) => void;
}) {
  const { t } = useTranslation("settings");
  const controller = useProviderForm({ draft, entries, onSave });
  const template = findTemplate(draft.templateId);

  return (
    <Dialog open onClose={onClose} className="mc-dialog--wide">
      <h2 className="mc-dialog__title">
        {template ? t("models.form.addTitle", { name: template.name }) : t("models.form.editTitle")}
      </h2>
      <p className="mc-dialog__desc">{t("models.form.desc")}</p>

      <ProviderFormBody controller={controller} />

      <div className="mc-dialog__footer">
        <Button variant="ghost" onClick={onClose}>
          {t("actions.cancel")}
        </Button>
        <Button variant="primary" onClick={controller.submit}>
          {t("actions.save")}
        </Button>
      </div>
    </Dialog>
  );
}
