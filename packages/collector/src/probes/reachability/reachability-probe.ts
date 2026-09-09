import {
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
  summarize,
} from "@ephorate/core";
import {
  type ReachabilitySettings,
  ReachabilitySettingsSchema,
  reachabilitySettingsShape,
  requiredRegionsOf,
} from "../../reachability/settings.js";

export const reachabilityProbeDescriptor: ProbeDescriptor = {
  name: "reachability",
  requiresExecutor: false,
  enabledByDefault: true,
  defaults: {
    interval: 300,
    timeout: 60,
    retries: 1,
    // A backstop, not a throttle: measured ~3 in flight for 200 nodes.
    concurrency: 50,
  },
  settings: reachabilitySettingsShape,
};

/** When the node declares no public TCP port of its own. */
const DEFAULT_PUBLIC_PORT = 443;

interface ReachabilityProbeOptions {
  createProvider: (settings: ReachabilitySettings) => ReachabilityProvider;
  /** Where the requests originate: a separate concern from who answers them. */
  requesterFor: (context: ProbeContext) => HttpRequester;
}

export class ReachabilityProbe implements Probe<ReachabilityResult> {
  readonly descriptor = reachabilityProbeDescriptor;

  /** Reused: the provider caches the vantage point list. */
  private provider?: ReachabilityProvider | undefined;

  constructor(private readonly options: ReachabilityProbeOptions) {}

  async run(context: ProbeContext): Promise<ProbeOutcome<ReachabilityResult>> {
    const startedAt = Date.now();

    try {
      // Parsed again to type the settings without core knowing them.
      const settings = ReachabilitySettingsSchema.parse(context.settings);

      if (Object.keys(settings.regions).length === 0) {
        return {
          ok: false,
          error: {
            kind: "not_configured",
            what: "probes.reachability.regions",
          },
          durationMs: Date.now() - startedAt,
        };
      }

      this.provider ??= this.options.createProvider(settings);

      const requester = this.options.requesterFor(context);
      const vantages = await this.provider.listVantages(requester);

      if (vantages.length === 0) {
        return {
          ok: false,
          error: { kind: "not_configured", what: "vantage points" },
          durationMs: Date.now() - startedAt,
        };
      }

      const readings = await this.provider.probe({
        target: {
          host: context.host,
          port: publicTcpPort(context),
          domain: context.domain,
        },
        vantages,
        methods: settings.methods,
        requester,
      });

      const result = summarize({
        readings,
        requiredRegions: requiredRegionsOf(settings),
        quorum: settings.quorum,
      });

      return { ok: true, data: result, durationMs: Date.now() - startedAt };
    } catch (cause) {
      return {
        ok: false,
        error: toProbeError(cause),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  toMetrics(result: ReachabilityResult, context: ProbeContext): MetricPoint[] {
    const base = { ts: context.startedAt, node: context.nodeName };
    const points: MetricPoint[] = [];

    for (const region of result.regions) {
      for (const [method, summary] of Object.entries(region.byMethod)) {
        points.push({
          ...base,
          metric: `reachability.${region.region}.${method}`,
          value: summary.total > 0 ? summary.passed / summary.total : 0,
          ok: summary.passed > 0,
          meta: {
            passed: summary.passed,
            total: summary.total,
            rtt: summary.rtt,
            network: region.network,
          },
        });
      }
    }

    points.push({
      ...base,
      metric: "reachability.verdict",
      value: VERDICT_CODES[result.verdict],
      ok: result.verdict === "ok",
      meta: { verdict: result.verdict },
    });

    return points;
  }
}

// "The service said no" is retried differently from a network failure.
function toProbeError(cause: unknown): ProbeError {
  if (!(cause instanceof HttpRequestError)) {
    return { kind: "internal", cause };
  }

  if (cause.status === undefined) {
    return { kind: "unreachable", detail: cause.message };
  }

  return { kind: "bad_response", status: cause.status };
}

function publicTcpPort(context: ProbeContext): number {
  return (
    context.ports.find(
      (port) => port.expose === "public" && port.proto === "tcp",
    )?.port ?? DEFAULT_PUBLIC_PORT
  );
}

/** Ordered by severity, for charts. */
const VERDICT_CODES = {
  ok: 0,
  partial: 1,
  blocked: 2,
  down: 3,
  unknown: 4,
} as const;
