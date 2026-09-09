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

/** Injected: where a request originates is not the provider's business. */
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

/** check-host today; readings from several providers merge in `summarize`. */
export interface ReachabilityProvider {
  readonly id: string;

  listVantages(requester: HttpRequester): Promise<Vantage[]>;
  probe(request: ReachabilityRequest): Promise<ProbeReading[]>;
}
