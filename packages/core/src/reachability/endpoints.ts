import type { Endpoints } from "../config/schema";
import type { ReachabilityTarget } from "./types";
import type { DecisiveCount, Verdict } from "./verdict";

export interface ResolvedEndpoint {
  name: string;
  target: ReachabilityTarget | { method: "udp"; host: string; port: number };
  destination: string;
}

export interface EndpointObservation {
  name: string;
  transport: "tcp" | "https" | "udp";
  destination: string;
  verdict: Verdict | null;
  regions: DecisiveCount[];
  error?: string;
}

export function endpointTransport(
  endpoint: ResolvedEndpoint,
): EndpointObservation["transport"] {
  return endpoint.target.method === "http" ? "https" : endpoint.target.method;
}

export function hostWithPort(host: string, port: number): string {
  const bracketed = host.includes(":") && !host.startsWith("[");
  return `${bracketed ? `[${host}]` : host}:${port}`;
}

export function resolveEndpoints(
  host: string,
  endpoints: Endpoints | undefined,
): ResolvedEndpoint[] {
  return Object.entries(endpoints ?? {}).map(([name, endpoint]) => {
    if ("https" in endpoint) {
      return {
        name,
        target: { method: "http", url: endpoint.https },
        destination: endpoint.https,
      };
    }
    const port = "tcp" in endpoint ? endpoint.tcp : endpoint.udp;
    const method = "tcp" in endpoint ? "tcp" : "udp";
    return {
      name,
      target: { method, host, port },
      destination: hostWithPort(host, port),
    };
  });
}

/** An edited endpoint cannot inherit observations about its old destination. */
export function endpointScope(endpoints: readonly ResolvedEndpoint[]): string {
  return JSON.stringify(
    [...endpoints]
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      )
      .map(({ name, target, destination }) => [
        name,
        target.method,
        destination,
      ]),
  );
}

/** A verdict belongs to the region coverage it was measured against. */
export function reachabilityRegionScope(
  settings: Readonly<Record<string, unknown>>,
): string {
  const { regions } = settings;
  if (typeof regions !== "object" || regions === null) return "[]";

  const byName = regions as Record<
    string,
    | {
        match?: readonly string[];
        count?: number;
        required?: boolean;
      }
    | undefined
  >;
  return JSON.stringify(
    Object.keys(byName)
      .sort()
      .map((name) => {
        const group = byName[name];
        return [
          name,
          [...new Set(group?.match)].sort(),
          group?.count,
          group?.required,
        ];
      }),
  );
}

export function endpointRegionMetric(
  name: string,
  region: string,
  method: ReachabilityTarget["method"],
): string {
  return endpointMetric(name, `${region}.${method}`);
}

export function endpointMetric(name: string, suffix: string): string {
  return `reachability.endpoint.${name}.${suffix}`;
}
