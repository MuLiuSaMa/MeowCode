import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { parseSponsors, createSponsorsController } = require("./sponsors.cjs");

describe("parseSponsors", () => {
  it("只取昵称，忽略金额与更新日期", () => {
    const sponsors = parseSponsors(
      JSON.stringify({
        update_time: " 2026-07-24 ",
        list: [
          { name: " 小羊 ", amount: "10元" },
          { name: "猫猫", amount: "50元" },
        ],
      }),
    );
    expect(sponsors).toEqual({ updateTime: "2026-07-24", names: ["小羊", "猫猫"] });
  });

  it("非法 JSON / 缺列表 / 全是空名字 → null", () => {
    expect(parseSponsors("not json")).toBeNull();
    expect(parseSponsors(JSON.stringify({ update_time: "2026-07-24" }))).toBeNull();
    expect(parseSponsors(JSON.stringify({ list: [{ name: "  " }, { amount: "1元" }] }))).toBeNull();
    expect(parseSponsors("")).toBeNull();
  });

  it("超长昵称按上限截断", () => {
    const sponsors = parseSponsors(JSON.stringify({ list: [{ name: "x".repeat(200) }] }));
    expect(sponsors?.names[0]).toHaveLength(80);
  });
});

describe("createSponsorsController", () => {
  it("启动先展示缓存，刷新后更新并落盘", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sponsors-"));
    const cachePath = path.join(dir, "sponsors.json");
    await writeFile(
      cachePath,
      JSON.stringify({ sponsors: { updateTime: "old", names: ["旧名单"] } }),
      "utf8",
    );
    const updates: Array<{ names: string[] } | null> = [];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          update_time: "2026-11-21",
          list: [{ name: "新赞助者", amount: "1元" }],
        }),
    }));
    const controller = createSponsorsController({
      cachePath,
      fetchImpl,
      onUpdate: (sponsors: { names: string[] } | null) => updates.push(sponsors),
    });

    controller.start();
    // 缓存同步生效（不等网络）
    expect(controller.get()?.names).toEqual(["旧名单"]);

    await vi.waitFor(() => expect(controller.get()?.names).toEqual(["新赞助者"]));
    expect(updates.map((item) => item?.names)).toEqual([["旧名单"], ["新赞助者"]]);
    const saved = JSON.parse(await readFile(cachePath, "utf8"));
    expect(saved.sponsors).toMatchObject({ updateTime: "2026-11-21", names: ["新赞助者"] });
    controller.stop();
  });

  it("拉取失败保留当前名单，不推空更新", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sponsors-"));
    const updates: Array<{ names: string[] } | null> = [];
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error("offline");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ list: [{ name: "保留我" }] }),
      };
    });
    const controller = createSponsorsController({
      fetchImpl,
      onUpdate: (sponsors: { names: string[] } | null) => updates.push(sponsors),
    });
    controller.start();
    await vi.waitFor(() => expect(controller.get()?.names).toEqual(["保留我"]));

    fail = true;
    await controller.refresh();
    expect(controller.get()?.names).toEqual(["保留我"]);
    expect(updates.filter((item) => item === null)).toHaveLength(0);
    controller.stop();
  });
});
