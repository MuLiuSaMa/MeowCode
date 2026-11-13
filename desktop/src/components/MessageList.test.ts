import { describe, expect, it } from "vitest";
import type { TimelineItem } from "../api";
import { pickTrailingCompactions } from "./MessageList";

const assistant = (key: string): TimelineItem =>
  ({ kind: "message", key, role: "assistant", content: key }) as TimelineItem;
const user = (key: string): TimelineItem =>
  ({ kind: "message", key, role: "user", content: key }) as TimelineItem;
const compaction = (key: string, running = false): TimelineItem =>
  ({ kind: "compaction", key, ...(running ? { running } : {}) }) as TimelineItem;
const turnInfo = (key: string): TimelineItem => ({ kind: "turn-info", key }) as TimelineItem;
const turnChanges = (key: string): TimelineItem => ({ kind: "turn-changes", key }) as TimelineItem;

const keys = (items: TimelineItem[]) => pickTrailingCompactions(items).map((item) => item.key);

describe("pickTrailingCompactions", () => {
  it("末尾的压缩提示（正文后、操作行前）被挑出来", () => {
    expect(keys([user("u1"), assistant("a1"), compaction("c1"), turnInfo("t1")])).toEqual([
      "c1",
    ]);
  });

  it("操作行与改动卡之后仍算末尾", () => {
    expect(
      keys([user("u1"), assistant("a1"), compaction("c1"), turnChanges("ch1"), turnInfo("t1")]),
    ).toEqual(["c1"]);
  });

  it("流中间的压缩提示保持原位", () => {
    expect(keys([user("u1"), assistant("a1"), compaction("c1"), assistant("a2")])).toEqual([]);
  });

  it("进行中的压缩同样后置（它就是流末尾最后一项）", () => {
    expect(keys([user("u1"), assistant("a1"), compaction("c1", true)])).toEqual(["c1"]);
  });

  it("连续多条末尾压缩都后置，且保持原顺序", () => {
    expect(
      keys([assistant("a1"), compaction("c1"), compaction("c2"), turnInfo("t1")]),
    ).toEqual(["c1", "c2"]);
  });

  it("空流与只有操作行的流没有可后置项", () => {
    expect(keys([])).toEqual([]);
    expect(keys([turnInfo("t1")])).toEqual([]);
  });
});
