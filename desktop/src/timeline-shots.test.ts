import { describe, expect, it } from "vitest";
import type { TimelineItem } from "./api";
import { collectTurnImages } from "./timeline-shots";

const shot = (data: string) => ({ mimeType: "image/png", dataUrl: `data:image/png;base64,${data}` });

const tool = (key: string, images?: Array<{ mimeType: string; dataUrl: string }>) =>
  ({ kind: "tool", key, callId: key, tool: "browser_screenshot", input: {}, ...(images ? { images } : {}) }) as TimelineItem;

const user = (key: string) =>
  ({ kind: "message", key, role: "user", content: "改一下首页" }) as TimelineItem;

const assistant = (key: string) =>
  ({ kind: "message", key, role: "assistant", content: "改好了" }) as TimelineItem;

describe("collectTurnImages", () => {
  it("取本回合工具产出的图，按发生顺序", () => {
    const items = [
      user("u1"),
      tool("t1", [shot("A")]),
      assistant("a1"),
      tool("t2", [shot("B")]),
      assistant("a2"),
    ];
    expect(collectTurnImages(items).map((image) => image.dataUrl)).toEqual([
      "data:image/png;base64,A",
      "data:image/png;base64,B",
    ]);
  });

  it("只取最后一个用户回合之后的图", () => {
    const items = [user("u1"), tool("t1", [shot("old")]), assistant("a1"), user("u2"), tool("t2", [shot("new")]), assistant("a2")];
    expect(collectTurnImages(items).map((image) => image.dataUrl)).toEqual([
      "data:image/png;base64,new",
    ]);
  });

  it("同一张图不重复出现", () => {
    const items = [user("u1"), tool("t1", [shot("A")]), tool("t2", [shot("A")])];
    expect(collectTurnImages(items)).toHaveLength(1);
  });

  it("没有图时返回空数组", () => {
    expect(collectTurnImages([user("u1"), tool("t1"), assistant("a1")])).toEqual([]);
  });
});