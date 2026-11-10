import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { parseAnnouncement, createNoticeController } = require("./notice.cjs");

describe("parseAnnouncement", () => {
  it("取第一条启用公告并规范化字段", () => {
    const notice = parseAnnouncement(
      JSON.stringify({
        version: 4,
        announce_list: [
          { id: "off", enabled: false, content: "跳过" },
          {
            id: "n1",
            title: " 标题 ",
            content: " 正文 ",
            date: "2026-11-10",
            url: "https://example.com/a",
          },
        ],
      }),
    );
    expect(notice).toMatchObject({
      id: "n1",
      title: "标题",
      content: "正文",
      date: "2026-11-10",
      url: "https://example.com/a",
      version: 4,
    });
  });

  it("空列表 / 空文件 / 非法 JSON → null", () => {
    expect(parseAnnouncement(JSON.stringify({ version: 4, announce_list: [] }))).toBeNull();
    expect(parseAnnouncement("")).toBeNull();
    expect(parseAnnouncement("not json")).toBeNull();
    expect(parseAnnouncement(JSON.stringify({ version: 4 }))).toBeNull();
    expect(
      parseAnnouncement(JSON.stringify({ version: 4, announce_list: [{ title: "没有正文" }] })),
    ).toBeNull();
  });

  it("非 http(s) 链接被丢弃", () => {
    const notice = parseAnnouncement(
      JSON.stringify({
        announce_list: [{ content: "正文", url: "javascript:alert(1)" }],
      }),
    );
    expect(notice?.url).toBe("");
  });
});

describe("createNoticeController", () => {
  it("启动先展示缓存，刷新后更新并落盘", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-notice-"));
    const cachePath = path.join(dir, "announcement.json");
    await writeFile(
      cachePath,
      JSON.stringify({ notice: { id: "cached", title: "旧标题", content: "旧公告" } }),
      "utf8",
    );
    const updates: Array<{ id?: string } | null> = [];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          version: 5,
          announce_list: [{ id: "fresh", title: "新标题", content: "新公告" }],
        }),
    }));
    const controller = createNoticeController({
      cachePath,
      fetchImpl,
      onUpdate: (notice: { id?: string } | null) => updates.push(notice),
    });

    controller.start();
    // 缓存同步生效（不等网络）
    expect(controller.get()?.id).toBe("cached");

    await vi.waitFor(() => expect(controller.get()?.id).toBe("fresh"));
    expect(updates.map((item) => item?.id)).toEqual(["cached", "fresh"]);
    const saved = JSON.parse(await readFile(cachePath, "utf8"));
    expect(saved.notice.id).toBe("fresh");
    controller.stop();
  });

  it("拉取失败保留当前公告，不推空更新", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-notice-"));
    const updates: Array<{ id?: string } | null> = [];
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error("offline");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ announce_list: [{ id: "keep", content: "公告" }] }),
      };
    });
    const controller = createNoticeController({
      fetchImpl,
      onUpdate: (notice: { id?: string } | null) => updates.push(notice),
    });
    controller.start();
    await vi.waitFor(() => expect(controller.get()?.id).toBe("keep"));
    fail = true;
    await controller.refresh();
    expect(controller.get()?.id).toBe("keep");
    expect(updates.filter((item) => item === null)).toHaveLength(0);
    controller.stop();
  });

  it("关闭后按 id 落盘：重启仍隐藏，换新 id 重新出现", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-notice-"));
    const cachePath = path.join(dir, "announcement.json");
    const makeFetch = (id: string) =>
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ announce_list: [{ id, content: `${id} 公告` }] }),
      }));

    const first = createNoticeController({ cachePath, fetchImpl: makeFetch("n1") });
    first.start();
    await vi.waitFor(() => expect(first.get()?.id).toBe("n1"));
    first.dismiss("n1");
    expect(first.get()).toBeNull();
    expect(JSON.parse(await readFile(cachePath, "utf8")).dismissedId).toBe("n1");
    first.stop();

    // 重启：缓存里是已关闭的公告，刷新后仍保持隐藏
    const second = createNoticeController({ cachePath, fetchImpl: makeFetch("n1") });
    second.start();
    await second.refresh();
    expect(second.get()).toBeNull();
    second.stop();

    // 新 id：重新出现
    const third = createNoticeController({ cachePath, fetchImpl: makeFetch("n2") });
    third.start();
    await vi.waitFor(() => expect(third.get()?.id).toBe("n2"));
    third.stop();
  });

  it("关闭后再次刷新不会把 dismissedId 冲掉，依旧保持隐藏", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-notice-"));
    const cachePath = path.join(dir, "announcement.json");
    const makeFetch = () =>
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ announce_list: [{ id: "n1", content: "公告" }] }),
      }));
    const controller = createNoticeController({ cachePath, fetchImpl: makeFetch() });
    controller.start();
    await vi.waitFor(() => expect(controller.get()?.id).toBe("n1"));
    controller.dismiss("n1");
    expect(controller.get()).toBeNull();

    // 模拟关闭后立刻发生的一次刷新（旧实现会在这次写盘时丢掉 dismissedId）
    await controller.refresh();
    expect(controller.get()).toBeNull();
    const state = JSON.parse(await readFile(cachePath, "utf8"));
    expect(state.dismissedId).toBe("n1");
    expect(state.notice.id).toBe("n1");
    controller.stop();
  });
});
