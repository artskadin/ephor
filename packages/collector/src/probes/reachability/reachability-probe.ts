import {
  endpointMetric,
  endpointRegionMetric,
  endpointTransport,
  HttpRequestError,
  type HttpRequester,
  type MetricPoint,
  type Probe,
  type ProbeContext,
  type ProbeDescriptor,
  type ProbeError,
  type ProbeOutcome,
  type ReachabilityProvider,
  type ReachabilityResult,
  type ResolvedEndpoint,
  reachabilityRegionScope,
  resolveEndpoints,
  summarize,
} from "@ephorate/core";
import { ProviderResponseError } from "../../reachability/provider-response-error";
import {
  type ReachabilitySettings,
  ReachabilitySettingsSchema,
  reachabilitySettingsShape,
  requiredRegionsOf,
} from "../../reachability/settings";

export const reachabilityProbeDescriptor: ProbeDescriptor = {
  name: "reachability",
  requiresExecutor: false,
  requiresEndpoints: true,
  summary: "answers from outside, by region; nothing on the node",
  defaults: {
    interval: 300,
    timeout: 60,
    retries: 1,
    // A backstop, not a throttle: measured ~3 in flight for 200 nodes.
    concurrency: 50,
  },
  settings: reachabilitySettingsShape,
  listMetrics: (node, settings) => {
    const { regions } = ReachabilitySettingsSchema.parse(settings);
    return buildMetricIds(
      resolveEndpoints(node.host, node.endpoints),
      Object.keys(regions),
    );
  },
  listAllMetrics: (settings, nodes) => {
    const { regions } = ReachabilitySettingsSchema.parse(settings);
    const endpoints = nodes.flatMap((node) =>
      resolveEndpoints(node.host, node.endpoints),
    );
    return [...new Set(buildMetricIds(endpoints, Object.keys(regions)))].filter(
      (metric) => !metric.endsWith(".attempt"),
    );
  },
};

function buildMetricIds(
  endpoints: readonly ResolvedEndpoint[],
  regionNames: readonly string[],
): string[] {
  return endpoints.flatMap(({ name, target }) => {
    const method = target.method;
    return method === "udp"
      ? []
      : [
          endpointMetric(name, "verdict"),
          endpointMetric(name, "attempt"),
          ...regionNames.map((region) =>
            endpointRegionMetric(name, region, method),
          ),
        ];
  });
}

type EndpointRun = { endpoint: ResolvedEndpoint } & (
  | { kind: "measured"; result: ReachabilityResult }
  | { kind: "failed"; error: ProbeError }
  | { kind: "unsupported" }
);

interface ReachabilityProbeOptions {
  createProvider: (settings: ReachabilitySettings) => ReachabilityProvider;
  /** Where the requests originate: a separate concern from who answers them. */
  requesterFor: (context: ProbeContext) => HttpRequester;
}

export class ReachabilityProbe implements Probe<EndpointRun[]> {
  readonly descriptor = reachabilityProbeDescriptor;

  /** Reused: the provider caches the vantage point list. */
  private provider?: ReachabilityProvider | undefined;

  constructor(private readonly options: ReachabilityProbeOptions) {}

  async run(context: ProbeContext): Promise<ProbeOutcome<EndpointRun[]>> {
    const startedAt = Date.now();
    const endpoints = resolveEndpoints(context.host, context.endpoints);
    const fail = (
      error: ProbeError,
      runs?: EndpointRun[],
    ): ProbeOutcome<EndpointRun[]> => ({
      ok: false,
      error,
      durationMs: Date.now() - startedAt,
      failedData:
        runs ??
        endpoints
          .filter(({ target }) => target.method !== "udp")
          .map((endpoint) => ({ endpoint, kind: "failed", error })),
    });

    try {
      if (endpoints.length === 0) {
        return fail({ kind: "not_configured", what: "endpoints" });
      }

      if (endpoints.every(({ target }) => target.method === "udp")) {
        return {
          ok: true,
          data: endpoints.map((endpoint) => ({
            endpoint,
            kind: "unsupported",
          })),
          durationMs: Date.now() - startedAt,
        };
      }

      // Parsed again to type the settings without core knowing them.
      const settings = ReachabilitySettingsSchema.parse(context.settings);

      if (Object.keys(settings.regions).length === 0) {
        return fail({
          kind: "not_configured",
          what: "probes.reachability.regions",
        });
      }

      this.provider ??= this.options.createProvider(settings);

      const requester = this.options.requesterFor(context);
      const vantages = await this.provider.listVantages(requester);

      if (vantages.length === 0) {
        return fail({ kind: "not_configured", what: "vantage points" });
      }

      const runs: EndpointRun[] = [];
      const requiredRegions = requiredRegionsOf(settings);
      for (const endpoint of endpoints) {
        if (endpoint.target.method === "udp") {
          runs.push({ endpoint, kind: "unsupported" });
          continue;
        }

        try {
          const readings = await this.provider.probe({
            target: endpoint.target,
            vantages,
            requester,
          });
          if (readings.every((reading) => reading.observed === false)) {
            runs.push({
              endpoint,
              kind: "failed",
              error: {
                kind: "bad_response",
                detail: "no selected point reported a result",
              },
            });
            continue;
          }
          runs.push({
            endpoint,
            kind: "measured",
            result: summarize({ readings, requiredRegions }),
          });
        } catch (cause) {
          runs.push({ endpoint, kind: "failed", error: toProbeError(cause) });
        }
      }

      // A failed endpoint must not discard a sibling's valid measurements.
      if (!runs.some((run) => run.kind === "measured")) {
        const failure = runs.find((run) => run.kind === "failed");
        if (failure !== undefined) {
          return fail(failure.error, runs);
        }
      }
      return { ok: true, data: runs, durationMs: Date.now() - startedAt };
    } catch (cause) {
      return fail(toProbeError(cause));
    }
  }

  toMetrics(runs: EndpointRun[], context: ProbeContext): MetricPoint[] {
    const base = { ts: context.startedAt, node: context.nodeName };
    const points: MetricPoint[] = [];
    const regionScope = reachabilityRegionScope(context.settings);

    for (const run of runs) {
      const { endpoint } = run;
      const { name, destination, target } = endpoint;
      if (run.kind === "unsupported" || target.method === "udp") continue;
      const identity = {
        destination,
        transport: endpointTransport(endpoint),
        regionScope,
      };
      points.push({
        ...base,
        metric: endpointMetric(name, "attempt"),
        ok: run.kind === "measured",
        meta:
          run.kind === "failed"
            ? { ...identity, error: measurementError(run.error) }
            : identity,
      });
      if (run.kind !== "measured") continue;

      const { verdict } = run.result;
      points.push({
        ...base,
        metric: endpointMetric(name, "verdict"),
        value: VERDICT_CODES[verdict],
        ok: verdict === "ok",
        meta: {
          ...identity,
          verdict,
          regions: run.result.regions.map((region) => region.decisive),
        },
      });
      for (const region of run.result.regions) {
        const summary = region.byMethod[target.method];
        if (summary === undefined || summary.reported === 0) continue;
        points.push({
          ...base,
          metric: endpointRegionMetric(name, region.region, target.method),
          value: summary.passed / summary.reported,
          ok: summary.passed > 0,
          meta: {
            ...identity,
            passed: summary.passed,
            total: summary.total,
            reported: summary.reported,
            rtt: summary.rtt,
            network: region.network,
          },
        });
      }
    }

    return points;
  }
}

// "The service said no" is retried differently from a network failure.
function toProbeError(cause: unknown): ProbeError {
  if (cause instanceof ProviderResponseError) {
    return { kind: "bad_response", detail: cause.message };
  }

  if (!(cause instanceof HttpRequestError)) {
    return { kind: "internal", cause };
  }

  if (cause.status === undefined) {
    return { kind: "unreachable", detail: cause.message };
  }

  return { kind: "bad_response", status: cause.status };
}

function measurementError(error: ProbeError): string {
  if ("detail" in error && error.detail)
    return `${error.kind}: ${error.detail}`;
  if (error.kind === "bad_response" && error.status !== undefined) {
    return `bad_response: HTTP ${error.status}`;
  }
  if (error.kind === "not_configured")
    return `not_configured: missing ${error.what}`;
  return error.kind;
}

/** Ordered by severity, for charts. */
const VERDICT_CODES = {
  ok: 0,
  partial: 1,
  blocked: 2,
  down: 3,
  unknown: 4,
} as const;
