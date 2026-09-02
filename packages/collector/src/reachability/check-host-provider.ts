import type {
  HttpRequester,
  ProbeReading,
  ReachabilityMethod,
  ReachabilityProvider,
  ReachabilityRequest,
  ReachabilityTarget,
  Vantage,
} from "@ephor/core";
import { sleep } from "../scheduling/clock.js";
import type { Region } from "./settings.js";

const API_BASE = "https://check-host.net";

export interface CheckHostProviderOptions {
  regions: Readonly<Record<string, Region>>;
  /** How long a fetched vantage list stays usable. */
  vantageTtlMs: number;
  /** Gap between polls for a check's results. */
  pollIntervalMs?: number;
  /** How long to keep polling before returning whatever arrived. */
  pollTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Shape of /nodes/hosts response. */
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

/** Shape of /check-<method> response. */
interface CheckStartResponse {
  ok?: number;
  request_id?: string;
  error?: string;
  /** The vantage points the service actually accepted for this check. */
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

  /**
   * Cached because the list of vantage points changes on the order of days,
   * while checks run every few minutes.
   */
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
    const nodeParams = vantages.map((v) => `node=${encodeURIComponent(v.id)}`);

    const start = await requester.getJson<CheckStartResponse>(
      `${API_BASE}/check-${method}?host=${encodeURIComponent(hostParam)}&${nodeParams.join("&")}`,
    );

    if (!start.request_id) {
      throw new Error(start.error ?? `${this.id} did not return a request id`);
    }

    // The count of nodes the service accepted, not the count we asked for:
    // a vantage point that is offline is silently dropped, and waiting for a
    // result it will never send costs the whole polling deadline on every
    // check for as long as it stays down.
    const expected = start.nodes
      ? Object.keys(start.nodes).length
      : vantages.length;

    const raw = await this.pollResults(requester, start.request_id, expected);

    return vantages.map((vantage) =>
      toReading(vantage, method, raw[vantage.id]),
    );
  }

  /**
   * The API answers the start call immediately and fills results in as the
   * vantage points report back, so a check is one call plus a few polls.
   * Returns whatever arrived once the deadline passes rather than failing:
   * partial readings still carry a verdict, no readings do not.
   */
  private async pollResults(
    requester: HttpRequester,
    requestId: string,
    expectedCount: number,
  ): Promise<CheckResultResponse> {
    const deadline = this.now() + this.pollTimeoutMs;
    // Counted as well as timed: the clock and the sleep are both injectable,
    // and a pair that does not advance together would otherwise spin without
    // end. A bound that cannot be configured away is worth more here than
    // the extra line.
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

      const finished = Object.values(latest).filter((v) => v !== null).length;

      if (finished >= expectedCount) return latest;
    }

    return latest;
  }

  /**
   * Takes up to `count` vantage points per region. Fewer is normal and not
   * an error: check-host has only three Russian nodes, so a region asking
   * for four gets three. The shortfall is visible downstream, since every
   * reading carries the region it came from.
   */
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

/**
 * [[ ["OK", 0.044, "ip"], ["TIMEOUT", 3.005], ... ]]
 * Several attempts per vantage point; a majority of OK counts as up.
 */
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
    .filter((n) => Number.isFinite(n));

  const rtt =
    times.length > 0
      ? times.reduce((a, b) => a + b, 0) / times.length
      : undefined;

  // A vantage point counts as reachable when most packets got through.
  const ok = successful.length * 2 >= results.length;

  return { vantage, method: "ping", ok, rtt };
}

/** [[1, 0.13, "OK", "200", "ip"]] — first field is a success flag. */
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

/** [{"time": 0.03}] on success, [{"error": "..."}] on failure. */
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
