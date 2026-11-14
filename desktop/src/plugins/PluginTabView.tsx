import { PluginContribution } from "./PluginSlot";
import { usePluginSlot } from "./runtime";

/** 右侧检查器的插件页签：按 pluginId + tabId 找注册的组件。 */
export function PluginTabView({
  pluginId,
  tabId,
  sessionId,
  workspace,
}: {
  pluginId: string;
  tabId: string;
  sessionId?: string;
  workspace?: string;
}) {
  const contributions = usePluginSlot("rightpanel.tabs");
  const contribution = contributions.find(
    (item) => item.pluginId === pluginId && item.entry.id === tabId,
  );
  if (!contribution) return null;
  return (
    <PluginContribution
      contribution={contribution}
      props={{
        tabId,
        ...(sessionId ? { sessionId } : {}),
        ...(workspace ? { workspace } : {}),
      }}
    />
  );
}
