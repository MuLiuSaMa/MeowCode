import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { setupI18n } from "./i18n";
import "./theme/tokens.css";
import "./theme/palettes.css";
import "./theme/base.css";
import "./theme/code-highlight.css";
import "@xterm/xterm/css/xterm.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// 亚克力窗口：首帧前就把透明背板标记好，避免闪一下实色底
if (window.meow?.acrylic) document.documentElement.dataset.backdrop = "acrylic";

// 语言必须在首帧前就绪，否则非中文用户会先看到一屏中文再跳走
setupI18n();

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
