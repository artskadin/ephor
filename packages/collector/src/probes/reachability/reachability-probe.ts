import {
  type MetricPoint,
  type Probe,
  type ProbeContext,
  type ProbeDescriptor,
  type ProbeOutcome,
  type ReachabilityProvider,
  type ReachabilityResult,
  summarize,
} from "@ephor/core";
import {
  type ReachabilitySettings,
  ReachabilitySettingsSchema,
  reachabilitySettingsShape,
  requiredRegionsOf,
} from "../../reachability/settings.js";

export const reachabilityProbeDescriptor: ProbeDescriptor = {
  name: "reachability",
  /** Works without node access — that is the whole point. */
  requiresExecutor: false,
  enabledByDefault: true,
  defaults: {
    interval: 300,
    timeout: 60,
    retries: 1,
    // A backstop, not a throttle. The load on the provider is set by the
    // interval, not by this number: with the schedule spread out, the count
    // in flight settles at arrival rate times duration on its own (roughly
    // 13 for 200 nodes at five minutes). The limit only matters when the
    // provider slows down, and then a low one would build a queue rather
    // than prevent anything.
    concurrency: 50,
  },
  settings: reachabilitySettingsShape,
};

/** Port used when the node declares no public TCP port of its own. */
const FALLBACK_PORT = 443;

export type ReachabilityProviderFactory = (
  settings: ReachabilitySettings,
) => ReachabilityProvider;

export class ReachabilityProbe implements Probe<ReachabilityResult> {
  readonly descriptor = reachabilityProbeDescriptor;

  /**
   * Created on first use and reused afterwards: the provider caches the
   * vantage point list, and a fresh instance per run would refetch it.
   */
  private provider?: ReachabilityProvider | undefined;

  constructor(private readonly createProvider: ReachabilityProviderFactory) {}

  async run(context: ProbeContext): Promise<ProbeOutcome<ReachabilityResult>> {
    const startedAt = Date.now();

    try {
      // Already validated as part of the config; parsing again is how the
      // probe gets its own settings typed without core knowing about them.
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

      this.provider ??= this.createProvider(settings);

      const vantages = await this.provider.listVantages();

      if (vantages.length === 0) {
        return {
          ok: false,
          error: { kind: "not_configured", what: "vantage points" },
          durationMs: Date.now() - startedAt,
        };
      }

      const readings = await this.provider.probe(
        {
          host: context.host,
          port: publicPortOf(context),
          domain: context.domain,
        },
        vantages,
        settings.methods,
      );

      const result = summarize({
        readings,
        requiredRegions: requiredRegionsOf(settings),
        quorum: settings.quorum,
      });

      return { ok: true, data: result, durationMs: Date.now() - startedAt };
    } catch (cause) {
      return {
        ok: false,
        error: { kind: "internal", cause },
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

    // Numeric code so the verdict can be graphed and compared.
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

function publicPortOf(context: ProbeContext): number {
  return (
    context.ports.find(
      (port) => port.expose === "public" && port.proto === "tcp",
    )?.port ?? FALLBACK_PORT
  );
}

/** Ordered by severity so charts read naturally. */
const VERDICT_CODES = {
  ok: 0,
  partial: 1,
  blocked: 2,
  down: 3,
  unknown: 4,
} as const;
