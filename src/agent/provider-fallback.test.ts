import { describe, expect, it } from "vitest";
import { ProviderRequestError, ProviderTimeoutError, providerErrorKind } from "./provider-error.js";
import {
  MAX_FALLBACK_HOPS,
  failoverReason,
  isFailoverEligible,
  planFallbacks,
} from "./provider-fallback.js";
import type { ProviderConfig } from "./types.js";

function provider(id: string, patch: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id, name: id, baseUrl: `https://${id}.example.com`, model: `${id}-model`, ...patch };
}

describe("providerErrorKind", () => {
  it("classifies statuses", () => {
    expect(providerErrorKind(new ProviderRequestError(429, "slow down"))).toBe("rate_limit");
    expect(providerErrorKind(new ProviderRequestError(503, "unavailable"))).toBe("server");
    expect(providerErrorKind(new ProviderRequestError(529, "overloaded"))).toBe("server");
    expect(providerErrorKind(new ProviderRequestError(408, "timeout"))).toBe("timeout");
    expect(providerErrorKind(new ProviderRequestError(401, "bad key"))).toBe("auth");
    expect(providerErrorKind(new ProviderRequestError(403, "forbidden"))).toBe("auth");
    expect(providerErrorKind(new ProviderRequestError(404, "no model"))).toBe("not_found");
    expect(providerErrorKind(new ProviderRequestError(400, "bad request"))).toBe("bad_request");
    expect(providerErrorKind(new ProviderRequestError(418, "teapot"))).toBe("unknown");
    expect(providerErrorKind(new ProviderTimeoutError("timeout"))).toBe("timeout");
    expect(providerErrorKind(new Error("plain"))).toBe("unknown");
    expect(providerErrorKind(undefined)).toBe("unknown");
  });
});

describe("isFailoverEligible", () => {
  it("switches on timeout / rate limit / server errors", () => {
    expect(isFailoverEligible(new ProviderTimeoutError("no response"))).toBe(true);
    expect(isFailoverEligible(new ProviderRequestError(429, "rate limited"))).toBe(true);
    expect(isFailoverEligible(new ProviderRequestError(500, "boom"))).toBe(true);
    expect(isFailoverEligible(new ProviderRequestError(503, "unavailable"))).toBe(true);
    expect(isFailoverEligible(new ProviderRequestError(504, "gateway timeout"))).toBe(true);
    expect(isFailoverEligible(new ProviderRequestError(529, "overloaded"))).toBe(true);
  });

  it("does not switch on auth, bad request or missing model", () => {
    expect(isFailoverEligible(new ProviderRequestError(401, "bad key"))).toBe(false);
    expect(isFailoverEligible(new ProviderRequestError(403, "forbidden"))).toBe(false);
    expect(isFailoverEligible(new ProviderRequestError(400, "invalid max_tokens"))).toBe(false);
    expect(isFailoverEligible(new ProviderRequestError(422, "invalid body"))).toBe(false);
    expect(isFailoverEligible(new ProviderRequestError(404, "model not found"))).toBe(false);
  });

  it("does not switch on user aborts", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(isFailoverEligible(abort)).toBe(false);
    expect(failoverReason(abort)).toBeUndefined();
  });

  it("does not switch on context overflow (it has its own downgrade chain)", () => {
    const overflow = new ProviderRequestError(
      400,
      "This model's maximum context length is 128000 tokens. Please reduce the length of the messages.",
    );
    expect(isFailoverEligible(overflow)).toBe(false);
    expect(failoverReason(overflow)).toBeUndefined();
  });

  it("reports the reason for eligible errors", () => {
    expect(failoverReason(new ProviderRequestError(503, "down"))).toBe("server");
    expect(failoverReason(new ProviderRequestError(429, "slow"))).toBe("rate_limit");
  });
});

describe("planFallbacks", () => {
  it("uses the settings order for the automatic chain and skips disabled providers", () => {
    const providers = [
      provider("a"),
      provider("b"),
      provider("c", { enabled: false }),
      provider("d"),
    ];
    expect(planFallbacks(providers, "a").map((item) => item.id)).toEqual(["b", "d"]);
  });

  it("caps the chain at 2 hops by default", () => {
    const providers = [provider("a"), provider("b"), provider("c"), provider("d")];
    expect(planFallbacks(providers, "a")).toHaveLength(MAX_FALLBACK_HOPS);
    expect(planFallbacks(providers, "a", 5)).toHaveLength(3);
  });

  it("honours an explicit fallbackIds order", () => {
    const providers = [provider("a"), provider("b"), provider("c")];
    expect(planFallbacks(providers, "a", undefined, ["c", "b"]).map((item) => item.id)).toEqual([
      "c",
      "b",
    ]);
  });

  it("ignores unknown, disabled and self references", () => {
    const providers = [provider("a"), provider("b", { enabled: false }), provider("c")];
    expect(
      planFallbacks(providers, "a", undefined, ["a", "missing", "b", "c"]).map((item) => item.id),
    ).toEqual(["c"]);
  });

  it("returns an empty chain when nothing else is enabled", () => {
    expect(planFallbacks([provider("a")], "a")).toEqual([]);
  });
});
