import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuAppWindow, LuChevronDown, LuFolderOpen } from "react-icons/lu";
import { Spinner } from "../ui/Spinner";
import "./OpenWithButton.css";

type AppEntry = {
  name: string;
  exe: string;
  icon?: string | null;
  default?: boolean;
  recommended?: boolean;
};

type Detection = {
  default: AppEntry | null;
  apps: AppEntry[];
  explorerIcon?: string | null;
};

type Selection = { kind: "explorer" } | { kind: "app"; exe: string; name: string };

const STORAGE_KEY = "meow:open-with:last";

function loadSelection(): Selection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { kind?: string; exe?: unknown; name?: unknown };
    // 旧版本保存的「系统默认」在菜单里已移除：回到资源管理器
    if (parsed?.kind === "explorer") return { kind: "explorer" };
    if (parsed?.kind === "app" && typeof parsed.exe === "string" && typeof parsed.name === "string") {
      return { kind: "app", exe: parsed.exe, name: parsed.name };
    }
  } catch {
    // 损坏的本地偏好按未选择处理
  }
  return null;
}

function AppIcon({
  icon,
  fallback,
}: {
  icon?: string | null;
  fallback: "app" | "folder";
}) {
  if (icon) return <img className="mc-openwith__icon" src={icon} alt="" />;
  return fallback === "folder" ? (
    <LuFolderOpen className="mc-openwith__icon" size={14} />
  ) : (
    <LuAppWindow className="mc-openwith__icon" size={14} />
  );
}

/**
 * 「打开方式」：主按钮显示 应用图标 + 名称，右侧箭头展开系统关联应用。
 * 默认选中资源管理器（与 OpenMD 一致）；选择某个应用后，主按钮固定显示
 * 该应用的图标与名称，再点即用该应用打开。
 */
export function OpenWithButton({
  target,
  disabled,
}: {
  /** 文件的绝对路径；为空时不可用 */
  target: string | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation("panel");
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(() => loadSelection());
  const [detection, setDetection] = useState<Detection | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!target) {
      setDetection(null);
      return;
    }
    let cancelled = false;
    void window.meow
      .detectOpenWith(target)
      .then((result) => {
        if (cancelled) return;
        setDetection(result);
        // 名称先到、图标后到：菜单立即出现，图标并行提取后回填
        const missing = result.apps.filter((app) => !app.icon).map((app) => app.exe);
        if (!missing.length) return;
        void window.meow
          .openWithIcons(missing)
          .then((icons) => {
            if (cancelled) return;
            setDetection((current) =>
              current
                ? {
                    ...current,
                    apps: current.apps.map((app) =>
                      app.icon ? app : { ...app, icon: icons[app.exe] ?? null },
                    ),
                  }
                : current,
            );
          })
          .catch(() => undefined);
      })
      .catch(() => {
        if (!cancelled) setDetection({ default: null, apps: [], explorerIcon: null });
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selectedApp =
    selection?.kind === "app"
      ? detection?.apps.find((app) => app.exe === selection.exe) ?? {
          name: selection.name,
          exe: selection.exe,
          icon: null,
        }
      : null;
  const isExplorer = !selection || selection.kind === "explorer";
  const mainName = isExplorer ? t("filePreview.explorerShort") : selectedApp?.name ?? "";
  const mainIcon = isExplorer ? detection?.explorerIcon : selectedApp?.icon;

  const remember = (next: Selection) => {
    setSelection(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage 不可用时只在本次会话生效
    }
  };

  const run = (action: () => Promise<unknown> | unknown) => {
    setOpen(false);
    void action();
  };

  const launchApp = (app: AppEntry) => {
    if (!target) return;
    void window.meow.openWithApp(app.exe, target).then((error) => {
      // 选中的程序被卸载/移动时退回资源管理器，而不是静默失败
      if (error) void window.meow.showInFolder(target);
    });
  };

  const openMain = () => {
    if (!target) return;
    if (isExplorer) {
      void window.meow.showInFolder(target);
      return;
    }
    if (selectedApp) launchApp(selectedApp);
  };

  const pickApp = (app: AppEntry) => {
    remember({ kind: "app", exe: app.exe, name: app.name });
    run(() => launchApp(app));
  };

  const pickExplorer = () => {
    remember({ kind: "explorer" });
    run(() => (target ? window.meow.showInFolder(target) : undefined));
  };

  return (
    <div className="mc-openwith" ref={wrapRef}>
      <button
        type="button"
        className="mc-openwith__main"
        aria-label={isExplorer ? t("filePreview.showInFolder") : t("filePreview.openWithApp", { name: mainName })}
        title={isExplorer ? t("filePreview.showInFolder") : t("filePreview.openWithApp", { name: mainName })}
        disabled={disabled || !target}
        onClick={openMain}
      >
        <AppIcon icon={mainIcon} fallback={isExplorer ? "folder" : "app"} />
        <span className="mc-openwith__name">{mainName}</span>
      </button>
      <button
        type="button"
        className="mc-openwith__chev"
        aria-label={t("filePreview.openWith")}
        title={t("filePreview.openWith")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || !target}
        onClick={() => setOpen((value) => !value)}
      >
        <LuChevronDown size={11} />
      </button>

      {open ? (
        <div className="mc-openwith__menu" role="menu">
          {detection === null ? (
            <div className="mc-openwith__loading">
              <Spinner size={14} />
              <span>{t("filePreview.detectingApps")}</span>
            </div>
          ) : detection.apps.length ? (
            <>
              <div className="mc-openwith__apps">
                {detection.apps.map((app) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={app.exe}
                    className="mc-openwith__item"
                    data-active={selection?.kind === "app" && selection.exe === app.exe}
                    onClick={() => pickApp(app)}
                  >
                    <AppIcon icon={app.icon} fallback="app" />
                    <span className="mc-openwith__itemname">{app.name}</span>
                  </button>
                ))}
              </div>
              <div className="mc-openwith__sep" />
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="mc-openwith__item"
            data-active={isExplorer}
            onClick={pickExplorer}
          >
            <AppIcon icon={detection?.explorerIcon} fallback="folder" />
            <span className="mc-openwith__itemname">{t("filePreview.explorerShort")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
