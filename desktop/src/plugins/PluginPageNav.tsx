import { usePluginSlot } from "./runtime";
import { PluginPageIcon, parsePluginView } from "./PluginPage";

/** 插件页面占据对话列表列时的导航：列出全部已注册页面。 */
export function PluginPageNav({ view, onOpen }: { view: string; onOpen: (view: string) => void }) {
  const pages = usePluginSlot("pages");
  const parsed = parsePluginView(view);
  if (pages.length === 0) return null;
  return (
    <nav className="mc-panel mc-panel--conversations mc-settings__nav">
      <ul className="mc-settings__navlist">
        {pages.map((page) => {
          const pageView = `plugin:${page.pluginId}:${page.entry.id}`;
          const active = parsed?.pluginId === page.pluginId && parsed.pageId === page.entry.id;
          return (
            <li key={`${page.pluginId}:${page.entry.id}`}>
              <button
                type="button"
                className="mc-settings__navitem"
                data-active={active}
                aria-current={active ? "page" : undefined}
                onClick={() => onOpen(pageView)}
              >
                <PluginPageIcon icon={page.entry.icon} title={page.entry.title ?? page.entry.id} size={15} />
                {page.entry.title ?? page.entry.id}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
