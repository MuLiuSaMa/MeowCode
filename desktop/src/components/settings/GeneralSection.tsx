import { FieldRow, Section } from "../ui/Section";
import { SegmentedControl } from "../ui/SegmentedControl";
import type { CloseAction } from "../../api";

const CLOSE_ACTIONS: Array<{ value: CloseAction; label: string }> = [
  { value: "ask", label: "每次询问" },
  { value: "tray", label: "缩小到托盘" },
  { value: "quit", label: "直接关闭" },
];

export function GeneralSection({
  closeAction,
  onCloseAction,
}: {
  closeAction: CloseAction;
  onCloseAction: (value: CloseAction) => void;
}) {
  return (
    <div className="mc-settings__inner">
      <Section
        title="关闭方式"
        description={
          closeAction === "tray"
            ? "关闭窗口时隐藏到系统托盘，MeowCode 继续在后台运行。"
            : closeAction === "quit"
              ? "关闭窗口会直接退出 MeowCode。"
              : "每次关闭窗口时询问你要缩小到托盘还是直接退出。"
        }
      >
        <FieldRow label="关闭窗口时">
          <SegmentedControl value={closeAction} options={CLOSE_ACTIONS} onChange={onCloseAction} ariaLabel="关闭方式" />
        </FieldRow>
      </Section>
    </div>
  );
}
