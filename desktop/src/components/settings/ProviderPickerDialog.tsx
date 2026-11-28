import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuSearch } from "react-icons/lu";
import { CUSTOM_TEMPLATE, PROVIDER_CATALOG, type ProviderTemplate } from "../../data/providerCatalog";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { TextField } from "../ui/TextField";
import { ProviderIcon } from "../ui/ProviderIcon";

export function ProviderPickerDialog({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (template: ProviderTemplate) => void;
}) {
  const { t } = useTranslation("settings");
  const customName = t("models.picker.custom");
  const [query, setQuery] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollIdleRef = useRef<number | null>(null);

  /*
   * 滚动期间给 grid 挂 data-scrolling：CSS 会把卡片的 hover 过渡暂时改瞬切。
   * 指针压在列表上滚动时，卡片逐张从光标下经过，每张都会开局一次 160ms 底色
   * 过渡 —— 滚动时等于连环重绘。悬停变色本身保留，只是不做淡入，运动中不可辨。
   * passive 监听：React 的 onWheel 在根节点上非 passive，主线程忙时会拖住滚动。
   */
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const markScrolling = () => {
      if (el.dataset.scrolling !== "true") el.dataset.scrolling = "true";
      if (scrollIdleRef.current !== null) window.clearTimeout(scrollIdleRef.current);
      scrollIdleRef.current = window.setTimeout(() => {
        scrollIdleRef.current = null;
        delete el.dataset.scrolling;
      }, 140);
    };
    el.addEventListener("wheel", markScrolling, { passive: true });
    el.addEventListener("scroll", markScrolling, { passive: true });
    return () => {
      el.removeEventListener("wheel", markScrolling);
      el.removeEventListener("scroll", markScrolling);
      if (scrollIdleRef.current !== null) window.clearTimeout(scrollIdleRef.current);
    };
  }, []);

  const list = useMemo(() => {
    const key = query.trim().toLowerCase();
    if (!key) return PROVIDER_CATALOG;
    return PROVIDER_CATALOG.filter(
      (item) => item.id.toLowerCase().includes(key) || item.name.toLowerCase().includes(key),
    );
  }, [query]);

  // 搜索时只在没有命中任何内置服务商（或搜索词本身就是自定义入口的名称/id）时展示自定义入口
  const showCustom = useMemo(() => {
    const key = query.trim().toLowerCase();
    return !key || "custom".includes(key) || customName.toLowerCase().includes(key);
  }, [query, customName]);

  // meta 行显示端点域名（没有预设端点的提示需填写）
  const metaOf = (template: ProviderTemplate) => {
    if (!template.baseUrl) return t("models.picker.needEndpoint");
    try {
      return new URL(template.baseUrl).host;
    } catch {
      return template.baseUrl;
    }
  };

  return (
    <Dialog open onClose={onClose} labelledBy="mc-picker-title" className="mc-dialog--wide">
      <span className="mc-dialog__title" id="mc-picker-title">
        {t("models.picker.title")}
      </span>
      <p className="mc-dialog__desc">{t("models.picker.desc")}</p>
      <TextField
        label={t("models.picker.search")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("models.picker.searchPlaceholder")}
      />
      <div className="mc-picker__grid" ref={gridRef}>
        {showCustom ? (
          <button
            key={CUSTOM_TEMPLATE.id}
            type="button"
            className="mc-picker__item mc-picker__item--custom"
            onClick={() => onPick(CUSTOM_TEMPLATE)}
          >
            <ProviderIcon template={CUSTOM_TEMPLATE} size={24} />
            <span className="mc-picker__text">
              <span className="mc-picker__name">{customName}</span>
              <span className="mc-picker__meta">{t("models.picker.customMeta")}</span>
            </span>
          </button>
        ) : null}
        {list.map((template) => (
          <button
            key={template.id}
            type="button"
            className="mc-picker__item"
            onClick={() => onPick(template)}
          >
            <ProviderIcon template={template} size={24} />
            <span className="mc-picker__text">
              <span className="mc-picker__name">{template.name}</span>
              <span className="mc-picker__meta">
                {metaOf(template)}
              </span>
            </span>
          </button>
        ))}
        {list.length === 0 && !showCustom ? (
          <p className="mc-models__empty" style={{ gridColumn: "1 / -1" }}>
            <LuSearch size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {t("models.picker.noMatch")}
          </p>
        ) : null}
      </div>
      <div className="mc-dialog__footer">
        <Button variant="ghost" onClick={onClose}>
          {t("actions.cancel")}
        </Button>
      </div>
    </Dialog>
  );
}
