import { providerIcon } from "../../data/providerIcons";
import { templateInitials, type ProviderTemplate } from "../../data/providerCatalog";
import { useTheme } from "../../theme/theme";
import "./ProviderIcon.css";

/**
 * 服务商图标。优先级：品牌图片（深色主题按需反色）→ 单色品牌字形（currentColor）→
 * 灰底首字母方块兜底。
 *
 * 圆角按图标尺寸等比（约 18%，最小 3px）：小图标上用固定 8px 会占掉三分之一边长，
 * 视觉上圆角过大。
 */
export function ProviderIcon({
  template,
  iconKey,
  size = 20,
}: {
  template?: ProviderTemplate;
  /** 覆盖服务商图标（模型列表用模型品牌 Logo） */
  iconKey?: string;
  size?: number;
}) {
  const { resolved } = useTheme();
  const key = iconKey ?? template?.iconKey;
  const icon = key ? providerIcon(key, resolved) : undefined;
  const radius = Math.max(3, Math.round(size * 0.18));
  const style = { width: size, height: size, borderRadius: radius };

  if (!icon) {
    return (
      <span
        className="mc-provicon mc-provicon--fallback"
        style={{ ...style, fontSize: Math.round(size * 0.42) }}
      >
        {template ? templateInitials(template) : "??"}
      </span>
    );
  }

  if (icon.kind === "glyph") {
    return (
      <span className="mc-provicon mc-provicon--glyph" style={style}>
        <icon.Icon size={size} aria-hidden />
      </span>
    );
  }

  return (
    <span className="mc-provicon" style={style}>
      <img
        src={icon.src}
        alt=""
        draggable={false}
        style={{ filter: icon.invert ? "invert(1)" : undefined }}
      />
    </span>
  );
}
