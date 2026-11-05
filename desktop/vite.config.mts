import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// .mts + native config 加载器：ESM 里没有 __dirname，用 import.meta.url 等价替换
const thisDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "renderer",
    emptyOutDir: true,
    // 双入口：主窗口 index.html + AI 悬浮岛 island.html（各自独立 document/React 树）
    rollupOptions: {
      input: {
        main: resolve(thisDir, "index.html"),
        island: resolve(thisDir, "island.html"),
      },
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
