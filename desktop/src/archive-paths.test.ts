import { describe, expect, it } from "vitest";
import { partitionArchivedTargets } from "./archive-paths";

describe("归档删除目标拆分", () => {
  const current = [
    "D:\\MC\\1\\agent\\sessions\\2026-11-27T07-53-11-465Z_D-NexBox.jsonl",
    "D:\\MC\\1\\agent\\sessions\\2026-11-26T10-00-00-000Z_D-NexBox.jsonl",
  ];

  it("当前目录里的照常删文件", () => {
    const { live, orphaned } = partitionArchivedTargets([current[0]], current);
    expect(live).toEqual([current[0]]);
    expect(orphaned).toEqual([]);
  });

  it("旧数据目录的路径判为孤儿：没有文件可删，只从列表摘掉", () => {
    const legacy =
      "C:\\Users\\MuLiu\\AppData\\Roaming\\MeowCode\\agent\\sessions\\2026-11-14T06-54-02-775Z_D-NexBox.jsonl";
    const { live, orphaned } = partitionArchivedTargets([legacy, current[1]], current);
    expect(live).toEqual([current[1]]);
    expect(orphaned).toEqual([legacy]);
  });

  it("Windows 路径大小写不同仍算同一个会话", () => {
    const { live } = partitionArchivedTargets(
      ["d:\\mc\\1\\agent\\sessions\\2026-11-27T07-53-11-465Z_d-nexbox.jsonl"],
      current,
    );
    expect(live).toHaveLength(1);
  });

  it("空列表不报错", () => {
    expect(partitionArchivedTargets([], current)).toEqual({ live: [], orphaned: [] });
  });
});
