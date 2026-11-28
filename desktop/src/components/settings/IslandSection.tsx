import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getIslandModel, setIslandModel, type ProviderSettings } from "../../api";
import { CustomSelect, type CustomSelectOption } from "../ui/CustomSelect";
import { FieldRow, Section } from "../ui/Section";
import { Toggle } from "../ui/Toggle";

/** AI 悬浮岛：屏幕顶部胶囊聚合显示所有运行中会话，可展开查看/继续对话（默认关）。 */
export function IslandSection({
  floatingIsland,
  onFloatingIslandChange,
  providers,
  onToast,
}: {
  floatingIsland: boolean;
  onFloatingIslandChange: (value: boolean) => void;
  /** 已配置的服务商列表：悬浮岛模型下拉的候选 */
  providers: ProviderSettings[];
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("settings");
  /** 悬浮岛模型："" = 跟随会话当前模型；null = 还没从服务端拿到当前值 */
  const [islandProviderId, setIslandProviderIdState] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getIslandModel()
      .then((result) => {
        if (!cancelled) setIslandProviderIdState(result.providerId ?? "");
      })
      .catch(() => {
        // 查询失败按默认值（跟随会话模型）展示，避免下拉卡在加载态
        if (!cancelled) setIslandProviderIdState("");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const changeIslandModel = async (value: string) => {
    const previous = islandProviderId;
    setIslandProviderIdState(value); // 乐观更新：失败回滚
    try {
      await setIslandModel(value || null); // 运行中的 server 立即生效
      // 落盘供下次启动传 env；走 saveProviderPrefs，不重启 agent server
      await window.meow.saveProviderPrefs({ islandProviderId: value || null });
    } catch (error) {
      setIslandProviderIdState(previous ?? "");
      onToast(error instanceof Error ? error.message : t("island.model.saveFailed"));
    }
  };

  /** 停用的服务商保留但置灰（选中它发送时会自动回退会话当前模型），便于识别当前配置 */
  const islandModelOptions = useMemo<CustomSelectOption<string>[]>(() => {
    const options = providers.map((provider) => ({
      value: provider.id,
      label: `${provider.displayName || provider.name} · ${provider.model}`,
      disabled: provider.enabled === false,
    }));
    return [{ value: "", label: t("island.model.followMain") }, ...options];
  }, [providers, t]);

  return (
    <div className="mc-settings__inner">
      <Section title={t("island.section")} description={t("island.desc")}>
        <FieldRow label={t("island.field")}>
          <Toggle checked={floatingIsland} onChange={onFloatingIslandChange} label={t("island.field")} />
        </FieldRow>
        <FieldRow label={t("island.model.field")} hint={t("island.model.desc")}>
          <CustomSelect
            value={islandProviderId ?? ""}
            options={islandModelOptions}
            onChange={(value) => void changeIslandModel(value)}
            ariaLabel={t("island.model.field")}
          />
        </FieldRow>
      </Section>
    </div>
  );
}
