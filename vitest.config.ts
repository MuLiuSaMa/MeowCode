import { defineConfig } from "vitest/config";

/** 允许用环境变量放开并发；非法值一律回落到 4。 */
const requestedWorkers = Number(process.env.MEOWCODE_TEST_WORKERS);
const maxWorkers = Number.isFinite(requestedWorkers) && requestedWorkers > 0 ? requestedWorkers : 4;

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "desktop/**/*.test.ts"],
    environment: "node",
    // 测试默认关掉回合后记忆蒸馏（mock provider 不预期额外请求，见 vitest.setup.ts）
    setupFiles: ["./vitest.setup.ts"],
    // 集成测试含 jiti 全量重编译、真实子进程 spawn、反复启停 server。
    // 默认 maxWorkers = CPU 核数，本机 16 路并发会互相抢 CPU：单例 8s 的用例能拖到 40s+，
    // 于是同一份代码在全量跑里红、单跑里绿。固定 4 路（与 CI windows-latest 的 4 核一致），
    // 需要更多并发时用 MEOWCODE_TEST_WORKERS 显式放开。
    maxWorkers,
    testTimeout: 15_000,
    hookTimeout: 20_000,
    teardownTimeout: 10_000,
    // 只在 CI 重试一次吸收残余网络级抖动；本地不重试，抖动照样暴露。
    retry: process.env.CI ? 1 : 0,
  },
});
