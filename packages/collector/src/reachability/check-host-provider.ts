import type {
  ProbeReading,
  ReachabilityMethod,
  ReachabilityProvider,
  ReachabilityTarget,
  Region,
  Vantage,
} from "@ephor/core";

const API_BASE = "https://check-host.net";

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
}

type CheckResultResponse = Record<string, unknown[] | null>;

export class CheckHostProvider implements ReachabilityProvider {
  readonly id = "check-host.net";

  private cachedVantages: Vantage[] = [];
  private cachedAt = 0;

  constructor(
    private readonly regions: Readonly<Record<string, Region>>,
    private readonly vantageTtlMs: number,
  ) {}

  async listVantages(): Promise<Vantage[]> {
    if (
      this.cachedVantages.length > 0 &&
      Date.now() - this.cachedAt < this.vantageTtlMs
    ) {
      return this.cachedVantages;
    }

    const response = await fetchJson<VantageListResponse>(
      `${API_BASE}/nodes/hosts`,
      this.id,
    );

    this.cachedVantages = this.selectVantages(response);
    this.cachedAt = Date.now();

    return this.cachedVantages;
  }

  async probe(
    target: ReachabilityTarget,
    vantages: readonly Vantage[],
    methods: readonly ReachabilityMethod[],
  ): Promise<ProbeReading[]> {
    const perMethods = await Promise.all(
      methods.map((method) => this.runOneMethod(target, vantages, method)),
    );

    return perMethods.flat();
  }

  private async runOneMethod(
    target: ReachabilityTarget,
    vantages: readonly Vantage[],
    method: ReachabilityMethod,
  ) {
    const hostParam = buildHostParam(target, method);
    const nodeParams = vantages.map((v) => `node=${encodeURIComponent(v.id)}`);

    const start = await fetchJson<CheckStartResponse>(
      `${API_BASE}/check-${method}?host=${encodeURIComponent(hostParam)}&${nodeParams.join("&")}`,
      this.id,
    );

    if (!start.request_id) {
      throw new Error(start.error ?? `${this.id} did not return a request id`);
    }

    const raw = await this.pollResults(start.request_id, vantages.length);

    return vantages.map((vantage) =>
      toReading(vantage, method, raw[vantage.id]),
    );
  }

  private async pollResults(
    requestId: string,
    expectedCount: number,
  ): Promise<CheckResultResponse> {
    const deadline = Date.now() + 30_000;
    let latest: CheckResultResponse = {};

    while (Date.now() < deadline) {
      await sleep(3000);

      latest = await fetchJson<CheckResultResponse>(
        `${API_BASE}/check-result/${requestId}`,
        this.id,
      );

      const finished = Object.values(latest).filter((v) => v !== null).length;

      if (finished >= expectedCount) return latest;
    }

    return latest;
  }

  private selectVantages(response: VantageListResponse): Vantage[] {
    const selected: Vantage[] = [];

    for (const [regionKey, region] of Object.entries(this.regions)) {
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

async function fetchJson<T>(url: string, sourceName: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 429) {
    throw new Error(`${sourceName}: rate limit reached`);
  }

  if (!response.ok) {
    throw new Error(`${sourceName} returned ${response.status}`);
  }

  return (await response.json()) as T;
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

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
