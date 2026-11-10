import { Dialog } from "../components/ui/Dialog";
import { Button } from "../components/ui/Button";
import type { PluginConsentRequest } from "./types";

/** 首次加载项目/用户插件的 UI 脚本前的授权确认；内置插件不经过这里。 */
export function PluginConsentDialog({
  requests,
  onApprove,
  onDecline,
}: {
  requests: PluginConsentRequest[];
  onApprove: (request: PluginConsentRequest) => void;
  onDecline: (request: PluginConsentRequest) => void;
}) {
  const request = requests[0];
  if (!request) return null;
  const { descriptor, permissions } = request;
  const name = descriptor.displayName ?? descriptor.manifest?.name ?? descriptor.id;
  return (
    <Dialog open onClose={() => onDecline(request)} labelledBy="plugin-consent-title">
      <div style={{ display: "grid", gap: 12, minWidth: 380 }}>
        <h2 id="plugin-consent-title" style={{ margin: 0, fontSize: 16 }}>
          允许「{name}」加载界面插件？
        </h2>
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          {descriptor.source === "project" ? "项目插件" : "用户插件"} · v
          {descriptor.manifest?.version ?? descriptor.version ?? "0.0.0"}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          该插件的界面代码会在主窗口中运行，并可使用以下能力：
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
          {permissions.length > 0 ? (
            permissions.map((permission) => <li key={permission}>{permission}</li>)
          ) : (
            <li>无额外能力（仅注册界面组件）</li>
          )}
        </ul>
        <div style={{ fontSize: 12, opacity: 0.65 }}>
          拒绝只会停用它的界面部分，后端工具不受影响。{requests.length > 1 ? ` 还有 ${requests.length - 1} 个待确认。` : ""}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="outline" size="sm" onClick={() => onDecline(request)}>
            拒绝
          </Button>
          <Button variant="primary" size="sm" onClick={() => onApprove(request)}>
            允许
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
