import type { CSSProperties, ReactNode } from "react";
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
  listWidth,
  listResizer,
}: {
  rail: ReactNode;
  conversations: ReactNode;
  children: ReactNode;
  inspector?: ReactNode;
  /** 左栏宽度（px）；不传则用 CSS 里的默认 --list-w */
  listWidth?: number;
  /** 左栏右边缘的拖拽条 */
  listResizer?: ReactNode;
}) {
  return (
    <div className="mc-root">
      <TitleBar />
      <div className="mc-body">
        {rail}
        <div className="mc-columns">
          <div
            className="mc-listcol"
            style={listWidth ? ({ width: `${listWidth}px` } as CSSProperties) : undefined}
          >
            {conversations}
            {listResizer}
          </div>
          <main className="mc-panel mc-panel--content">{children}</main>
          {inspector}
        </div>
      </div>
    </div>
  );
}
