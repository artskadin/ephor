import type {
  HttpRequester,
  ProbeReading,
  ReachabilityMethod,
  ReachabilityProvider,
  ReachabilityRequest,
  ReachabilityTarget,
  Vantage,
} from "@ephorate/core";
import { sleep } from "../scheduling/clock.js";
import type { Region } from "./settings.js";

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

  async probe(request: ReachabilityRequest): Promise<ProbeReading[]> {
    const perMethods = await Promise.all(
      request.methods.map((method) => this.runOneMethod(request, method)),
    );

    return perMethods.flat();
  }

  private async runOneMethod(
    { target, vantages, requester }: ReachabilityRequest,
    method: ReachabilityMethod,
  ) {
    const hostParam = buildHostParam(target, method);
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
      toReading(vantage, method, raw[vantage.id]),
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

function buildHostParam(
  target: ReachabilityTarget,
  method: ReachabilityMethod,
): string {
  switch (method) {
    case "tcp":
      return `${target.host}:${target.port}`;
    case "http":
      return `https://${target.domain ?? target.host}/`;
    case "ping":
      return target.host;
  }
}

function toReading(
  vantage: Vantage,
  method: ReachabilityMethod,
  raw: unknown,
): ProbeReading {
  if (raw === null || raw === undefined) {
    return { vantage, method, ok: false, error: "no response" };
  }

  switch (method) {
    case "ping":
      return parsePing(vantage, raw);
    case "http":
      return parseHttp(vantage, raw);
    case "tcp":
      return parseTcp(vantage, raw);
  }
}

/** `[[ ["OK", 0.044, "ip"], ["TIMEOUT", 3.005] ]]`; a majority of OK is up. */
function parsePing(vantage: Vantage, raw: unknown): ProbeReading {
  const attempts = Array.isArray(raw) ? raw[0] : null;

  if (!Array.isArray(attempts)) {
    return { vantage, method: "ping", ok: false, error: "no data" };
  }

  const results = attempts.filter(Array.isArray) as unknown[][];
  const successful = results.filter((entry) => entry[0] === "OK");

  if (successful.length === 0) {
    const firstStatus = results[0]?.[0];

    return {
      vantage,
      method: "ping",
      ok: false,
      error: typeof firstStatus === "string" ? firstStatus : "no data",
    };
  }

  const times = successful
    .map((entry) => Number(entry[1]))
    .filter((time) => Number.isFinite(time));

  const rtt =
    times.length > 0
      ? times.reduce((sum, time) => sum + time, 0) / times.length
      : undefined;

  const ok = successful.length * 2 >= results.length;

  return { vantage, method: "ping", ok, rtt };
}

/** `[[1, 0.13, "OK", "200", "ip"]]`; the first field is the success flag. */
function parseHttp(vantage: Vantage, raw: unknown): ProbeReading {
  const entry = Array.isArray(raw) ? raw[0] : null;

  if (!Array.isArray(entry)) {
    return { vantage, method: "http", ok: false, error: "no data" };
  }

  const ok = entry[0] === 1;
  const rtt = Number.isFinite(Number(entry[1])) ? Number(entry[1]) : undefined;

  return ok
    ? { vantage, method: "http", ok: true, rtt }
    : {
        vantage,
        method: "http",
        ok: false,
        error: typeof entry[2] === "string" ? entry[2] : "failed",
      };
}

/** `[{"time": 0.03}]` on success, `[{"error": "..."}]` on failure. */
function parseTcp(vantage: Vantage, raw: unknown): ProbeReading {
  const entry = Array.isArray(raw) ? raw[0] : null;

  if (entry === null || typeof entry !== "object") {
    return { vantage, method: "tcp", ok: false, error: "no data" };
  }

  if ("error" in entry) {
    return {
      vantage,
      method: "tcp",
      ok: false,
      error: String((entry as { error: unknown }).error),
    };
  }

  const time = (entry as { time?: unknown }).time;
  const rtt = Number.isFinite(Number(time)) ? Number(time) : undefined;

  return { vantage, method: "tcp", ok: true, rtt };
}
