import { afterEach, describe, expect, it } from "vitest";
import { MAX_TIMER_MS, positiveIntFromEnv } from "./env-limits.js";

const KEY = "MEOWCODE_TEST_LIMIT";

describe("positiveIntFromEnv", () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it("未设置时返回默认值", () => {
    delete process.env[KEY];
    expect(positiveIntFromEnv(KEY, 60)).toBe(60);
  });

  it("空串返回默认值", () => {
    process.env[KEY] = "   ";
    expect(positiveIntFromEnv(KEY, 60)).toBe(60);
  });

  it("正数生效并向下取整", () => {
    process.env[KEY] = "1000000";
    expect(positiveIntFromEnv(KEY, 60)).toBe(1_000_000);

    process.env[KEY] = "12.9";
    expect(positiveIntFromEnv(KEY, 60)).toBe(12);
  });

  it("非法值回落默认值", () => {
    for (const raw of ["abc", "0", "-5", "Infinity"]) {
      process.env[KEY] = raw;
      expect(positiveIntFromEnv(KEY, 60), raw).toBe(60);
    }
  });

  it("超过上限时按上限截断", () => {
    process.env[KEY] = "9999999999";
    expect(positiveIntFromEnv(KEY, 90_000, MAX_TIMER_MS)).toBe(MAX_TIMER_MS);
  });
});
