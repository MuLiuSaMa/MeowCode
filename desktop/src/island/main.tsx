import { createRoot } from "react-dom/client";
import IslandApp from "./IslandApp";
import { GlobalTooltip } from "../components/ui/GlobalTooltip";
import { setupI18n } from "../i18n";
import "../theme/tokens.css";
// base.css 提供 .mc-markdown 等全局排版（岛内 Agent 内容与主窗口同源）；
// 它会把 body 画成实色，island.css 在最后重新压回透明
import "../theme/base.css";
// 岛内复用主窗口组件（气泡/工具行/输入框/发送按钮），直接引入同一份组件样式保证视觉一致
import "../components/UserBubble.css";
import "../components/AssistantMessage.css";
import "../components/ToolRow.css";
import "../components/Composer.css";
// 轮间距 / 思考工具分组 / 报错面板与主窗口消息流同一份规则（ToolGroup.css 由组件自带）
import "../components/MessageList.css";
import "./island.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// 语言首帧前就绪（html 内联脚本已解析好 lang，这里同步初始化词典）
setupI18n();

// 岛内按钮/会话 chip 的 title 提示与主窗口同款：自绘 GlobalTooltip 接管原生 title
createRoot(root).render(
  <>
    <IslandApp />
    <GlobalTooltip />
  </>,
);
