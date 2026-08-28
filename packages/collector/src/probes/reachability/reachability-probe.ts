import {
  summarize,
  type MetricPoint,
  type Probe,
  type ProbeContext,
  type ProbeOutcome,
  type ReachabilityMethod,
  type ReachabilityProvider,
  type ReachabilityResult,
} from "@ephor/core";

export interface ReachabilityProbeOptions {
  provider: ReachabilityProvider;
  methods: readonly ReachabilityMethod[];
  requiredRegions: readonly string[];
  quorum: number;
  fallbackPort: number;
}

export class ReachabilityProbe implements Probe<ReachabilityResult> {
  readonly name = "reachability";
  /** Works without node access — that is the whole point. */
  readonly requiresExecutor = false;

  constructor(private readonly options: ReachabilityProbeOptions) {}

  async run(context: ProbeContext): Promise<ProbeOutcome<ReachabilityResult>> {
    const startedAt = Date.now();

    try {
      const vantages = await this.options.provider.listVantages();

      if (vantages.length === 0) {
        return {
          ok: false,
          error: { kind: "not_configured", what: "vantage points" },
          durationMs: Date.now() - startedAt,
        };
      }

      const publicPort =
        context.ports.find((p) => p.expose === "public" && p.proto === "tcp")
          ?.port ?? this.options.fallbackPort;

      const readings = await this.options.provider.probe(
        {
          host: context.host,
          port: publicPort,
          domain: context.domain,
        },
        vantages,
        this.options.methods,
      );

      const result = summarize({
        readings,
        requiredRegions: this.options.requiredRegions,
        quorum: this.options.quorum,
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

/** Ordered by severity so charts read naturally. */
const VERDICT_CODES = {
  ok: 0,
  partial: 1,
  blocked: 2,
  down: 3,
  unknown: 4,
} as const;
