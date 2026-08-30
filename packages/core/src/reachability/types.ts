export type ReachabilityMethod = "ping" | "tcp" | "http";

export interface Vantage {
  id: string;
  region: string;
  countryCode: string;
  city?: string | undefined;
  network: "datacenter" | "residental" | "mobile";
}

export interface ProbeReading {
  vantage: Vantage;
  method: ReachabilityMethod;
  ok: boolean;
  rtt?: number | undefined;
  error?: string | undefined;
}

export interface ReachabilityTarget {
  host: string;
  port: number;
  domain?: string | undefined;
}

/**
 * One HTTP GET returning JSON.
 *
 * Separated from the providers so that *where the request originates* stays
 * a deployment choice rather than a property of the provider: from the
 * collector by default, optionally through a node so the source IP is spread
 * across the fleet. A provider that speaks something other than HTTP simply
 * ignores it.
 */
export interface HttpRequester {
  getJson<T>(url: string): Promise<T>;
}

export class HttpRequestError extends Error {
  constructor(
    readonly url: string,
    readonly status: number | undefined,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "HttpRequestError";
  }
}

export interface ReachabilityRequest {
  target: ReachabilityTarget;
  vantages: readonly Vantage[];
  methods: readonly ReachabilityMethod[];
  /** How this particular run reaches the outside world. */
  requester: HttpRequester;
}

/**
 * A source of reachability measurements: check-host today, another public
 * service or a fleet of own agents later. Several may coexist — `summarize`
 * takes a flat list of readings, so results from two providers merge without
 * the verdict logic knowing.
 */
export interface ReachabilityProvider {
  readonly id: string;

  listVantages(requester: HttpRequester): Promise<Vantage[]>;
  probe(request: ReachabilityRequest): Promise<ProbeReading[]>;
}
