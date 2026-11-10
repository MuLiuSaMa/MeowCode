import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listPlugins: vi.fn() }));

vi.mock("../api", () => ({ listPlugins: mocks.listPlugins }));

import { invalidatePluginIconMap, loadPluginIconMap } from "./pluginIcons";

beforeEach(() => {
  invalidatePluginIconMap();
  mocks.listPlugins.mockReset();
});

describe("loadPluginIconMap", () => {
  it("收集有图标的已安装插件，并缓存结果", async () => {
    mocks.listPlugins.mockResolvedValue({
      plugins: [
        { id: "computer-control", iconUrl: "data:image/svg+xml;base64,abc" },
        { id: "local-plugin", iconUrl: undefined },
      ],
    });
    expect(await loadPluginIconMap()).toEqual({ "computer-control": "data:image/svg+xml;base64,abc" });
    await loadPluginIconMap();
    expect(mocks.listPlugins).toHaveBeenCalledTimes(1);
  });

  it("失败返回空表，下次调用重试", async () => {
    mocks.listPlugins.mockRejectedValueOnce(new Error("offline"));
    expect(await loadPluginIconMap()).toEqual({});
    mocks.listPlugins.mockResolvedValueOnce({ plugins: [{ id: "p", iconUrl: "data:x" }] });
    expect(await loadPluginIconMap()).toEqual({ p: "data:x" });
  });

  it("invalidate 后重新拉取", async () => {
    mocks.listPlugins.mockResolvedValue({ plugins: [] });
    await loadPluginIconMap();
    invalidatePluginIconMap();
    await loadPluginIconMap();
    expect(mocks.listPlugins).toHaveBeenCalledTimes(2);
  });
});
