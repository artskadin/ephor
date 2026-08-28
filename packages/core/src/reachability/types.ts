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

export interface ReachabilityProvider {
  readonly id: string;

  listVantages(): Promise<Vantage[]>;
  probe(
    target: ReachabilityTarget,
    vantages: readonly Vantage[],
    methods: readonly ReachabilityMethod[],
  ): Promise<ProbeReading[]>;
}
