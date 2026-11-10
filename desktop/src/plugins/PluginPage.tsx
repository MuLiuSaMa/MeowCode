import { usePluginSlot } from "./runtime";
import { PluginContribution } from "./PluginSlot";
import "./PluginPage.css";

/** 主视图 id：plugin:<pluginId>:<pageId> */
export function parsePluginView(view: string): { pluginId: string; pageId: string } | null {
  if (!view.startsWith("plugin:")) return null;
  const rest = view.slice("plugin:".length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  return { pluginId: rest.slice(0, separator), pageId: rest.slice(separator + 1) };
}

export function PluginPageIcon({
  icon,
  title,
  size = 18,
}: {
  icon?: string;
  title: string;
  size?: number;
}) {
  if (icon && /^(data:|https?:\/\/)/i.test(icon)) {
    return (
      <img
        className="mc-pluginpage__iconimg"
        src={icon}
        alt=""
        width={size}
        height={size}
        draggable={false}
      />
    );
  }
  return (
    <span className="mc-pluginpage__icontext" style={{ fontSize: Math.max(12, size - 2) }}>
      {icon?.trim().slice(0, 1) || title.trim().slice(0, 1) || "◆"}
    </span>
  );
}

/** 插件注册的主视图页面：找不到（插件被停用/卸载）时给出回退。 */
export function PluginPage({
  view,
  sessionId,
  workspace,
  onShowChat,
}: {
  view: string;
  sessionId?: string;
  workspace?: string;
  onShowChat: () => void;
}) {
  const pages = usePluginSlot("pages");
  const parsed = parsePluginView(view);
  const page = parsed
    ? pages.find(
        (item) => item.pluginId === parsed.pluginId && item.entry.id === parsed.pageId,
      )
    : undefined;

  if (!page) {
    return (
      <div className="mc-pluginpage mc-pluginpage--missing">
        <p>页面已不可用（插件可能被停用或卸载）。</p>
        <button type="button" className="mc-pluginpage__back" onClick={onShowChat}>
          返回对话
        </button>
      </div>
    );
  }

  return (
    <div className="mc-pluginpage">
      <PluginContribution
        contribution={page}
        props={{
          view,
          ...(sessionId ? { sessionId } : {}),
          ...(workspace ? { workspace } : {}),
        }}
      />
    </div>
  );
}
