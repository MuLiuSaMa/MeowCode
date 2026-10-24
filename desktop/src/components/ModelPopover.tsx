import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { LuCheck, LuChevronRight, LuRotateCcw, LuSettings2 } from "react-icons/lu";
import { findTemplate } from "../data/providerCatalog";
import { effortFromIndex, effortIndex, effortLabel, effortLevelsForModel, effortLevelsFromValues, type EffortLevel } from "../effort";
import type { ProviderSettings } from "../api";
import { ProviderIcon } from "./ui/ProviderIcon";
import "./ModelPopover.css";

/** 滑块直径。轨道两端各内缩 (THUMB - TRACK_H) / 2，让两端圆头正好被滑块圆心盖住。 */
const THUMB = 42;
const THUMB_HALF = THUMB / 2;
const TRACK_H = 36;
const TRACK_INSET = (THUMB - TRACK_H) / 2;

/** 把 0..1 的比例换算成滑块圆心位置（两端各留出滑块半径，所以永不溢出）。 */
function thumbCenter(fraction: number): string {
  return `calc(${THUMB_HALF}px + ${fraction} * (100% - ${THUMB}px))`;
}

/** 满档时的粒子。用固定种子的伪随机，保证每次渲染位置一致（不能用 Math.random，否则会跳动）。 */
const PARTICLES = Array.from({ length: 20 }, (_, i) => {
  const rand = (salt: number) => {
    const v = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  const duration = 2.8 + rand(6) * 1.8;
  return {
    left: 4 + rand(1) * 92,
    top: 16 + rand(2) * 68,
    size: 1.4 + rand(3) * 1.5,
    opacity: 0.35 + rand(4) * 0.55,
    duration,
    // 负延迟：让粒子一开始就散布在各自行程的不同位置上，不会整批同时出现
    delay: -rand(5) * duration,
  };
});

/** 当前模型可用的档位：用户手动指定优先，否则按模型名匹配。 */
export function levelsFor(provider: ProviderSettings | undefined): EffortLevel[] {
  if (!provider) return effortLevelsFromValues(["low", "medium", "high"]);
  return provider.reasoningLevels?.length
    ? effortLevelsFromValues(provider.reasoningLevels)
    : effortLevelsForModel(provider.model);
}

/**
 * 模型弹层，两视图：
 *  1. 模型列表（默认）—— 点某个模型即切为当前模型，并跳到强度滑杆
 *  2. 思考强度滑杆 —— 点中间的档位名 / 模型名返回列表
 */
export function ModelPopover({
  providers,
  activeProviderId,
  model,
  effort,
  levels,
  onChange,
  onChangeActive,
  onManageModels,
  onClose,
  anchorRef,
}: {
  /** 已启用的模型 */
  providers: ProviderSettings[];
  activeProviderId: string;
  model: string;
  effort?: string;
  levels: EffortLevel[];
  onChange: (value: string) => void;
  onChangeActive: (providerId: string) => void;
  /** 打开 设置 → 模型 管理模型列表 */
  onManageModels: () => void;
  onClose: () => void;
  /** 触发按钮的 ref；点击它不算「点外部」，交给按钮自己切换开关。 */
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [showList, setShowList] = useState(true);
  /** 相对触发按钮（模型 chip）水平居中、底部贴 chip 上沿；超宽时夹紧在视口内。 */
  const [fixedStyle, setFixedStyle] = useState<CSSProperties>({});
  const index = effortIndex(effort, levels);
  const max = levels.length - 1;
  const fraction = max === 0 ? 0 : index / max;
  const atMax = max > 0 && index === max;

  useLayoutEffect(() => {
    const anchor = anchorRef?.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = ref.current?.offsetWidth || 320;
    const vw = window.innerWidth;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, vw - width - 8));
    setFixedStyle({
      position: "fixed",
      left: Math.round(left),
      bottom: Math.round(window.innerHeight - rect.top + 10),
    });
    // 弹层打开时锚点不会动，算一次即可；视图切换（列表↔滑杆）只改高度，
    // fixed + bottom 锚定会自动向上伸展。
  }, [anchorRef]);

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
    <div className="mc-popover" style={fixedStyle} ref={ref} role="dialog" aria-label="模型与思考强度">
      {showList ? (
        <>
          <div className="mc-popover__head">
            <span className="mc-popover__title">选择模型</span>
            <span className="mc-popover__count">{providers.length}</span>
          </div>
          <div className="mc-popover__list">
            {providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className="mc-popover__item"
                data-active={provider.id === activeProviderId}
                onClick={() => {
                  onChangeActive(provider.id);
                  setShowList(false);
                }}
              >
                <ProviderIcon template={findTemplate(provider.templateId)} size={20} />
                <span className="mc-popover__itemtext">
                  <span className="mc-popover__itemname">{provider.displayName || provider.model}</span>
                  <span className="mc-popover__itemmeta mc-truncate">{provider.name}</span>
                </span>
                {provider.id === activeProviderId ? (
                  <LuCheck size={14} className="mc-popover__check" />
                ) : null}
              </button>
            ))}
            {providers.length === 0 ? (
              <p className="mc-popover__empty">还没有启用任何模型。到 设置 → 模型 里添加。</p>
            ) : null}
          </div>
          {/* 管理入口：无模型时引导添加，有模型时固定在列表下方 */}
          <div className="mc-popover__manage">
            <button
              type="button"
              className="mc-popover__managebtn"
              onClick={onManageModels}
            >
              <LuSettings2 size={14} />
              管理模型
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mc-popover__head mc-popover__head--slider">
            {/* 左侧 26px 占位，保证中间块相对弹层严格居中 */}
            <span aria-hidden />
            {/* 点中间的思考强度 + 模型名 = 返回模型列表 */}
            <button
              type="button"
              className="mc-popover__levelbtn"
              aria-label="返回模型列表"
              title="返回模型列表"
              onClick={() => setShowList(true)}
            >
              <span className="mc-popover__level" data-max={atMax}>
                {effortLabel(effort, levels)}
              </span>
              <span className="mc-popover__model">
                <span className="mc-truncate" title={model}>
                  {model}
                </span>
                <LuChevronRight size={12} className="mc-popover__modelchev" />
              </span>
            </button>
            <button
              type="button"
              className="mc-popover__reset"
              aria-label="重置为默认"
              title="重置为默认"
              onClick={() => onChange("")}
            >
              <LuRotateCcw size={15} />
            </button>
          </div>

          <div className="mc-slider">
            <div className="mc-slider__track" />
            <div
              className="mc-slider__fill"
              data-max={atMax}
              style={{
                left: `${TRACK_INSET}px`,
                width: `calc(${THUMB_HALF - TRACK_INSET}px + ${fraction} * (100% - ${THUMB}px))`,
              }}
            >
              {atMax
                ? PARTICLES.map((particle, i) => (
                    <span
                      key={i}
                      className="mc-slider__particle"
                      style={
                        {
                          left: `${particle.left}%`,
                          top: `${particle.top}%`,
                          width: `${particle.size}px`,
                          height: `${particle.size}px`,
                          // 基色透明度交给 CSS 变量，这样关键帧里可以用 calc 做闪烁
                          "--o": particle.opacity,
                          animationDuration: `${particle.duration}s`,
                          animationDelay: `${particle.delay}s`,
                        } as CSSProperties
                      }
                    />
                  ))
                : null}
            </div>
            {levels.map((level, i) => (
              <span
                key={level.value}
                className="mc-slider__dot"
                data-in={i <= index}
                style={{ left: thumbCenter(max === 0 ? 0 : i / max) }}
              />
            ))}
            <div className="mc-slider__thumb" style={{ left: thumbCenter(fraction) }} />
            <input
              className="mc-slider__input"
              type="range"
              min={0}
              max={max}
              step={1}
              value={index}
              aria-label="思考强度"
              onChange={(event) => onChange(effortFromIndex(Number(event.target.value), levels))}
            />
          </div>
        </>
      )}
    </div>
  );
}
