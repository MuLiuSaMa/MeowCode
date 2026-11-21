import { useEffect, useRef, useState } from "react";
import appIcon from "../../assets/icon.webp";
import catUrl from "../../assets/logo-cat.webp?inline";
import {
  CAT_MAX_POINTS,
  DOT_RADIUS,
  PARTICLE_COUNT,
  VIEWBOX_SIZE,
  cycleMorphAt,
  mapMaskToTargets,
  morphDots,
  sampleCatMask,
  sphereDots,
  type CatMask,
  type Dot,
} from "./status-logo-particles";

/** logo-cat.webp 的 alpha 只解析一次；状态行反复挂载不重复采样。 */
let maskPromise: Promise<CatMask | null> | null = null;

function loadCatMask(): Promise<CatMask | null> {
  if (maskPromise) return maskPromise;
  maskPromise = (async () => {
    if (typeof document === "undefined") return null;
    try {
      const image = new Image();
      image.src = catUrl;
      await image.decode();
      const size = 160;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        maskPromise = null;
        return null;
      }
      // 等比居中，避免猫头被拉伸；data URL 不会污染画布，getImageData 可直接读
      const scale = Math.min(size / image.width, size / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
      const data = context.getImageData(0, 0, size, size).data;
      return sampleCatMask(data, size, size, { maxPoints: CAT_MAX_POINTS });
    } catch {
      // 解码/采样失败允许下次挂载重试，而不是整个进程永久回退
      maskPromise = null;
      return null;
    }
  })();
  return maskPromise;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * 状态行 Logo：思考球与猫头点阵按 ~8 秒周期形变轮播。
 * 只读 alpha 轮廓，颜色走 currentColor；reduced-motion 退回静态应用图标。
 */
export function StatusLogoParticles({ size = 16 }: { size?: number }) {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [failed, setFailed] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const targetsRef = useRef<Array<readonly [number, number] | null>>([]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(media.matches);
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    if (reduced) return;
    let cancelled = false;
    void loadCatMask().then((mask) => {
      if (cancelled) return;
      if (!mask) {
        setFailed(true);
        return;
      }
      targetsRef.current = mapMaskToTargets(mask, PARTICLE_COUNT);
    });
    return () => {
      cancelled = true;
    };
  }, [reduced]);

  useEffect(() => {
    if (reduced || failed || typeof window === "undefined") return;
    const wrap = wrapRef.current;
    const svg = svgRef.current;
    if (!wrap || !svg) return;
    const dots = Array.from(svg.querySelectorAll("circle"));
    if (!dots.length) return;

    const paint = (frame: Dot[]) => {
      for (let index = 0; index < dots.length; index += 1) {
        const dot = frame[index];
        if (!dot) continue;
        dots[index].setAttribute("cx", dot.x.toFixed(2));
        dots[index].setAttribute("cy", dot.y.toFixed(2));
        dots[index].setAttribute("opacity", dot.opacity.toFixed(2));
      }
    };

    let visible = true;
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => {
            visible = entries[0]?.isIntersecting ?? true;
          })
        : null;
    observer?.observe(wrap);

    const startedAt = performance.now();
    let frameId = 0;
    const draw = (now: number) => {
      frameId = window.requestAnimationFrame(draw);
      if (document.hidden || !visible) return;
      const morph = cycleMorphAt(now - startedAt);
      const sphere = sphereDots(PARTICLE_COUNT, (now / 2500) * Math.PI * 2);
      paint(morph > 0 ? morphDots(sphere, targetsRef.current, morph) : sphere);
    };
    // 先画一帧球体，避免挂载后空一帧
    paint(sphereDots(PARTICLE_COUNT, 0));
    frameId = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(frameId);
      observer?.disconnect();
    };
  }, [reduced, failed]);

  const style = { width: size, height: size };
  if (reduced || failed) {
    return (
      <span className="mc-statusline__mark" style={style} aria-hidden="true">
        <img src={appIcon} alt="" draggable={false} className="mc-statusline__logo" />
      </span>
    );
  }

  return (
    <span ref={wrapRef} className="mc-statusline__mark" style={style} aria-hidden="true">
      <svg
        ref={svgRef}
        className="mc-statusline__particles"
        viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
        width={size}
        height={size}
        aria-hidden="true"
        focusable="false"
      >
        {Array.from({ length: PARTICLE_COUNT }, (_, index) => (
          <circle key={index} cx={10} cy={10} r={DOT_RADIUS} opacity={0} />
        ))}
      </svg>
    </span>
  );
}
