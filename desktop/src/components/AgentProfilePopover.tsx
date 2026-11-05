import { useEffect, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuPuzzle } from "react-icons/lu";
import { AGENT_PROFILES, AGENT_PROFILE_ORDER } from "../agentProfiles";
import type { AgentProfileId, HarnessArchitectureSummary } from "../api";
import "./AgentProfilePopover.css";

/**
 * 主 Agent 菜单（贴在 Composer 的档位胶囊上方）：
 * 上半 = 内置三档（切档位，连带换图）；下半 = 工作区里的自定义架构（只换图）。
 * 自定义架构是用户从架构页新建的，选中后运行时仍按当前档位的提示词/工具走。
 */
export function AgentProfilePopover({
  value,
  onChange,
  onClose,
  anchorRef,
  architectures,
  activeArchitecture,
  onSelectArchitecture,
}: {
  value: AgentProfileId;
  onChange: (profile: AgentProfileId) => void;
  onClose: () => void;
  /** 触发按钮的 ref；点击它不算「点外部」，交给按钮自己切换开关 */
  anchorRef?: RefObject<HTMLElement | null>;
  /** 内置三档 + 自定义架构（架构页同一份列表） */
  architectures?: HarnessArchitectureSummary[];
  /** 当前生效的架构图 id（自定义架构时与 value 不同） */
  activeArchitecture?: string;
  /** 选中自定义架构：只换图，不改档位 */
  onSelectArchitecture?: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useTranslation("shell");
  const customs = (architectures ?? []).filter((item) => !item.builtin);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, anchorRef]);

  return (
    <div
      className="mc-permmenu mc-agentmenu"
      ref={ref}
      role="menu"
      aria-label={t("agentProfile.aria")}
    >
      {AGENT_PROFILE_ORDER.map((id) => {
        const profile = AGENT_PROFILES[id];
        const Icon = profile.icon;
        const active = value === id && activeArchitecture === id;
        return (
          <button
            key={id}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            className="mc-permmenu__item"
            data-active={active}
            onClick={() => {
              onChange(id);
              onClose();
            }}
          >
            <span className="mc-permmenu__label">
              <Icon size={14} />
              {profile.label}
            </span>
            <span className="mc-permmenu__desc">
              {t("agentProfile.dispatchable", {
                tagline: profile.tagline,
                count: profile.roles.length,
              })}
            </span>
            {active ? <LuCheck size={14} className="mc-permmenu__check" /> : null}
          </button>
        );
      })}
      {customs.length ? (
        <>
          <div className="mc-agentmenu__sep" />
          {customs.map((item) => {
            const active = activeArchitecture === item.id;
            const label = item.name ?? item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className="mc-permmenu__item"
                data-active={active}
                onClick={() => {
                  onSelectArchitecture?.(item.id);
                  onClose();
                }}
              >
                <span className="mc-permmenu__label">
                  <LuPuzzle size={14} />
                  {label}
                </span>
                <span className="mc-permmenu__desc">{t("agentProfile.customDesc")}</span>
                {active ? <LuCheck size={14} className="mc-permmenu__check" /> : null}
              </button>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
