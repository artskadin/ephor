import { HttpRequestError, type HttpRequester } from "@ephor/core";
import { describe, expect, it } from "vitest";
import { ReachabilityProbe } from "../reachability-probe.js";

const SETTINGS = {
  provider: "check-host.net",
  methods: ["tcp"],
  quorum: 0.5,
  vantageRefresh: 86_400,
  regions: { ru: { match: ["ru"], count: 1, required: true } },
};

function probeThatFailsWith(failure: unknown) {
  const requester: HttpRequester = {
    getJson: () => Promise.reject(failure),
  };

  return new ReachabilityProbe({
    createProvider: () => ({
      id: "fake",
      listVantages: (r) => r.getJson("https://example.test/nodes"),
      probe: () => Promise.resolve([]),
    }),
    requesterFor: () => requester,
  });
}

const CONTEXT = {
  nodeName: "solo",
  host: "203.0.113.10",
  ports: [],
  startedAt: 0,
  timeoutMs: 1000,
  settings: SETTINGS,
};

describe("reachability error mapping", () => {
  // "the service said no" and "we have a bug" must not land in the metric
  // as the same errorKind.
  it("reports a refused request as a bad response, keeping the status", async () => {
    const outcome = await probeThatFailsWith(
      new HttpRequestError("https://x/", 429, "rate limit reached"),
    ).run(CONTEXT);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toEqual({ kind: "bad_response", status: 429 });
  });

  // No status at all means nothing answered; that one is worth retrying.
  it("reports a request that got no answer as unreachable", async () => {
    const outcome = await probeThatFailsWith(
      new HttpRequestError("https://x/", undefined, "request timed out"),
    ).run(CONTEXT);

    if (outcome.ok) throw new Error("expected a failure");
    expect(outcome.error).toEqual({
      kind: "unreachable",
      detail: "request timed out",
    });
  });

  it("still reports anything else as internal", async () => {
    const outcome = await probeThatFailsWith(
      new TypeError("undefined is not a function"),
    ).run(CONTEXT);

    if (outcome.ok) throw new Error("expected a failure");
    expect(outcome.error.kind).toBe("internal");
  });
});
