import type { CSSProperties, ReactNode, RefObject } from "react";
import { PluginSlot, PluginWrap } from "../plugins/PluginSlot";
import "../plugins/PluginHost.css";
import { TitleBar } from "./TitleBar";
import "./AppShell.css";

/**
 * ZCode 式外壳：
 *  - 顶部标题栏与左侧按钮栏共用 --bg-chrome，二者连成一体（左边缘不留白、无间隙）。
 *  - 其余面板是圆角卡片，靠窗口底色从间隙透出来区分，不用 1px 分割线。
 *  - 左栏（对话/设置/架构导航）宽度可拖拽，和右侧检查器同一套交互。
 */
export function AppShell({
  rail,
  conversations,
  children,
  inspector,
  announcements = true,
  listWidth,
  listResizer,
  listColRef,
  view = "chat",
}: {
  rail: ReactNode;
  conversations: ReactNode;
  children: ReactNode;
  inspector?: ReactNode;
  /** 标题栏公告条是否显示（设置 → 通用） */
  announcements?: boolean;
  /** 左栏宽度（px）；不传则用 CSS 里的默认 --list-w */
  listWidth?: number;
  /** 左栏右边缘的拖拽条 */
  listResizer?: ReactNode;
  /** 左栏列容器的 ref：拖拽时直接改宽度样式，绕过 React 重渲染 */
  listColRef?: RefObject<HTMLDivElement | null>;
  /** 当前主视图：传给外壳级插件槽位 */
  view?: string;
}) {
  return (
    <PluginWrap name="shell.root" props={{}}>
      <div className="mc-root">
        <PluginWrap name="shell.titlebar" props={{ announcements }}>
          <TitleBar announcements={announcements} />
        </PluginWrap>
        <div className="mc-body">
          <PluginWrap name="shell.rail" props={{ view }}>
            {rail}
          </PluginWrap>
          <div className="mc-columns">
            <div
              ref={listColRef}
              className="mc-listcol"
              style={listWidth ? ({ width: `${listWidth}px` } as CSSProperties) : undefined}
            >
              <PluginWrap name="shell.conversations" props={{ view }}>
                {conversations}
              </PluginWrap>
              {listResizer}
            </div>
            <main className="mc-panel mc-panel--content">
              <PluginWrap name="shell.content" props={{ view }}>
                {children}
              </PluginWrap>
            </main>
            {inspector ? (
              <PluginWrap name="shell.inspector" props={{ open: true }}>
                {inspector}
              </PluginWrap>
            ) : null}
          </div>
        </div>
        <div className="mc-plugin-overlay">
          <PluginSlot name="shell.overlay" props={{ view }} />
        </div>
      </div>
    </PluginWrap>
  );
}
