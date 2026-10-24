import { Spinner } from "../ui/Spinner";
import { FieldRow, Section } from "../ui/Section";
import { baseName } from "../../util";
import type { AppInfo } from "../../api";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <FieldRow label={label}>
      <span className="mc-about__value">{value || "—"}</span>
    </FieldRow>
  );
}

export function AboutSection({ appInfo, workspace }: { appInfo: AppInfo | null; workspace?: string }) {
  if (!appInfo) {
    return (
      <div className="mc-settings__inner">
        <div className="mc-about__loading">
          <Spinner size={20} />
          <span>正在读取版本信息…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mc-settings__inner">
      <Section title="MeowCode" description="一个跑在本地的编码 Agent。">
        <Row label="版本" value={appInfo.version} />
        <Row label="平台" value={appInfo.platform} />
        <Row label="Electron" value={appInfo.electron} />
        <Row label="Chromium" value={appInfo.chrome} />
        <Row label="Node.js" value={appInfo.node} />
        <Row label="工作区" value={workspace ? baseName(workspace) : "未选择"} />
      </Section>
    </div>
  );
}
