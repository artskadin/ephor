import {
  type HttpRequester,
  hostWithPort,
  type ProbeReading,
  type ReachabilityProvider,
  type ReachabilityRequest,
  type ReachabilityTarget,
  type Vantage,
} from "@ephorate/core";
import { sleep } from "../scheduling/clock";
import { ProviderResponseError } from "./provider-response-error";
import type { Region } from "./settings";

const API_BASE = "https://check-host.net";

interface CheckHostProviderOptions {
  regions: Readonly<Record<string, Region>>;
  vantageTtlMs: number;
  pollIntervalMs?: number;
  /** After it, whatever arrived is returned. */
  pollTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** `/nodes/hosts`. */
interface VantageListResponse {
  nodes: Record<
    string,
    {
      asn: string;
      ip: string;
      location: [countryCode: string, country: string, city: string];
    }
  >;
}

/** `/check-<method>`. */
interface CheckStartResponse {
  ok?: number;
  request_id?: string;
  error?: string;
  /** The vantage points the service accepted for this check. */
  nodes?: Record<string, unknown>;
}

type CheckResultResponse = Record<string, unknown[] | null>;

export class CheckHostProvider implements ReachabilityProvider {
  readonly id = "check-host.net";

  private cachedVantages: Vantage[] = [];
  private cachedAt = 0;

  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: CheckHostProviderOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }

  /** Cached: the list changes over days, checks run every few minutes. */
  async listVantages(requester: HttpRequester): Promise<Vantage[]> {
    if (
      this.cachedVantages.length > 0 &&
      this.now() - this.cachedAt < this.options.vantageTtlMs
    ) {
      return this.cachedVantages;
    }

    const response = await requester.getJson<VantageListResponse>(
      `${API_BASE}/nodes/hosts`,
    );

    this.cachedVantages = this.selectVantages(response);
    this.cachedAt = this.now();

    return this.cachedVantages;
  }

  async probe({
    target,
    vantages,
    requester,
  }: ReachabilityRequest): Promise<ProbeReading[]> {
    const method = target.method;
    const hostParam =
      target.method === "tcp"
        ? hostWithPort(target.host, target.port)
        : target.url;
    const nodeParams = vantages.map(
      (vantage) => `node=${encodeURIComponent(vantage.id)}`,
    );

    const start = await requester.getJson<CheckStartResponse>(
      `${API_BASE}/check-${method}?host=${encodeURIComponent(hostParam)}&${nodeParams.join("&")}`,
    );

    if (!start.request_id) {
      throw new Error(start.error ?? `${this.id} did not return a request id`);
    }

    // What the service accepted, not what was asked: an offline vantage
    // point is dropped silently and would never report.
    const expectedCount = start.nodes
      ? Object.keys(start.nodes).length
      : vantages.length;

    const raw = await this.pollResults(
      requester,
      start.request_id,
      expectedCount,
    );

    return vantages.map((vantage) =>
      toReading(
        vantage,
        method,
        start.nodes === undefined || Object.hasOwn(start.nodes, vantage.id)
          ? raw[vantage.id]
          : undefined,
      ),
    );
  }

  /** Whatever arrived by the deadline; partial readings carry a verdict. */
  private async pollResults(
    requester: HttpRequester,
    requestId: string,
    expectedCount: number,
  ): Promise<CheckResultResponse> {
    const deadline = this.now() + this.pollTimeoutMs;
    // Counted as well as timed: an injected clock and sleep that do not
    // advance together would otherwise spin forever.
    const maxPolls = Math.ceil(
      this.pollTimeoutMs / Math.max(this.pollIntervalMs, 1),
    );
    let polls = 0;
    let latest: CheckResultResponse = {};

    while (this.now() < deadline && polls < maxPolls) {
      polls++;
      await this.sleep(this.pollIntervalMs);

      latest = await requester.getJson<CheckResultResponse>(
        `${API_BASE}/check-result/${requestId}`,
      );

      const finished = Object.values(latest).filter(
        (result) => result !== null,
      ).length;

      if (finished >= expectedCount) return latest;
    }

    return latest;
  }

  /** Fewer than `count` is normal: check-host has three Russian nodes. */
  private selectVantages(response: VantageListResponse): Vantage[] {
    const selected: Vantage[] = [];

    for (const [regionKey, region] of Object.entries(this.options.regions)) {
      const matching = Object.entries(response.nodes)
        .filter(([, info]) => region.match.includes(info.location[0]))
        .slice(0, region.count);

      for (const [id, info] of matching) {
        selected.push({
          id,
          region: regionKey,
          countryCode: info.location[0],
          city: info.location[2],
          network: "datacenter",
        });
      }
    }

    return selected;
  }
}

function toReading(
  vantage: Vantage,
  method: ReachabilityTarget["method"],
  raw: unknown,
): ProbeReading {
  if (raw === null || raw === undefined) {
    return {
      vantage,
      method,
      ok: false,
      observed: false,
      error: "no response",
    };
  }

  switch (method) {
    case "http":
      return parseHttp(vantage, raw);
    case "tcp":
      return parseTcp(vantage, raw);
  }
}

/** `[[1, 0.13, "OK", "200", "ip"]]`; the first field is the success flag. */
function parseHttp(vantage: Vantage, raw: unknown): ProbeReading {
  const entry = Array.isArray(raw) ? raw[0] : null;

  if (Array.isArray(entry)) {
    const [flag, time, error] = entry as unknown[];
    if (
      flag === 1 &&
      typeof time === "number" &&
      Number.isFinite(time) &&
      time >= 0
    ) {
      return { vantage, method: "http", ok: true, rtt: time };
    }
    if (flag === 0 && typeof error === "string" && error.trim() !== "") {
      return { vantage, method: "http", ok: false, error };
    }
  }
  throw new ProviderResponseError(
    "check-host.net returned an invalid HTTPS result",
  );
}

/** `[{"time": 0.03}]` on success, `[{"error": "..."}]` on failure. */
function parseTcp(vantage: Vantage, raw: unknown): ProbeReading {
  const entry: unknown = Array.isArray(raw) ? raw[0] : undefined;

  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    if ("error" in entry) {
      if (typeof entry.error === "string" && entry.error.trim() !== "") {
        return { vantage, method: "tcp", ok: false, error: entry.error };
      }
    } else if (
      "time" in entry &&
      typeof entry.time === "number" &&
      Number.isFinite(entry.time) &&
      entry.time >= 0
    ) {
      return { vantage, method: "tcp", ok: true, rtt: entry.time };
    }
  }

  throw new ProviderResponseError(
    "check-host.net returned an invalid TCP result",
  );
}
