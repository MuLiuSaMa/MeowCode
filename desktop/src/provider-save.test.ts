import { describe, expect, it } from "vitest";
import { reconcileProviderEcho } from "./provider-save";

type P = { id: string; name: string; enabled?: boolean };

const a: P = { id: "a", name: "A" };
const b: P = { id: "b", name: "B" };
const c: P = { id: "c", name: "C" };

describe("reconcileProviderEcho", () => {
  it("drops models the echo brings back that were not in this submit", () => {
    // 用户删了 b，但落盘回执（旧一次保存留下的）里还带着 b
    const result = reconcileProviderEcho<P>({
      saved: { providers: [a, b], providerId: "a" },
      submitted: { providers: [a], providerId: "a" },
    });
    expect(result.providers).toEqual([a]);
  });

  it("keeps the echo order and any fields the backend filled in", () => {
    const savedA = { id: "a", name: "A (renamed by backend)", enabled: true };
    const result = reconcileProviderEcho<P>({
      saved: { providers: [savedA, b], providerId: "a" },
      submitted: { providers: [a, c], providerId: "c" },
    });
    // 保留回执里的内容与顺序，只按提交集合裁剪（c 还没被回执认领，暂时不出现）
    expect(result.providers).toEqual([savedA]);
    // 回执的激活项仍是提交里的模型 → 尊重回执
    expect(result.providerId).toBe("a");
  });

  it("falls back to the submitted active model when the echo points at a deleted one", () => {
    const result = reconcileProviderEcho<P>({
      saved: { providers: [b], providerId: "b" },
      submitted: { providers: [a], providerId: "a" },
    });
    expect(result.providers).toEqual([]);
    expect(result.providerId).toBe("a");
  });

  it("uses the submitted list when the echo carries no providers", () => {
    const result = reconcileProviderEcho<P>({
      saved: { providerId: "a" },
      submitted: { providers: [a], providerId: "a" },
    });
    expect(result.providers).toEqual([a]);
    expect(result.providerId).toBe("a");
  });

  it("supports deleting every model", () => {
    const result = reconcileProviderEcho<P>({
      saved: { providers: [a, b], providerId: "a" },
      submitted: { providers: [], providerId: undefined },
    });
    expect(result.providers).toEqual([]);
    expect(result.providerId).toBeUndefined();
  });
});
