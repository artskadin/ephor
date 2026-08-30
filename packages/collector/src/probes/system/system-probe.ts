import type {
  MetricPoint,
  Probe,
  ProbeContext,
  ProbeDescriptor,
  ProbeError,
  ProbeOutcome,
} from "@ephor/core";
import { SYSTEM_COLLECT_SCRIPT } from "./collect-script.js";

export const systemProbeDescriptor: ProbeDescriptor = {
  name: "system",
  requiresExecutor: true,
  enabledByDefault: true,
  defaults: {
    interval: 60,
    timeout: 15,
    retries: 2,
    // One ssh process per node, each a few megabytes and three file
    // descriptors. A backstop against unbounded growth rather than a
    // throttle: the spread schedule keeps the count in flight far below
    // this, and 50 still leaves room under a default `ulimit -n` of 1024.
    // Reaching nodes through a jump host is the exception: `MaxStartups`
    // on that host (10:30:100 by default) drops connections above ~10.
    concurrency: 50,
  },
};

export interface SystemSnapshot {
  hostName: string;
  load1: number;
  load5: number;
  load15: number;
  cpuCount: number;
  uptimeSeconds: number;
  memTotalKb: number;
  memAvailableKb: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  listeningPorts: string;
}

export class SystemProbe implements Probe<SystemSnapshot> {
  readonly descriptor = systemProbeDescriptor;

  async run(context: ProbeContext): Promise<ProbeOutcome<SystemSnapshot>> {
    const startedAt = Date.now();

    if (!context.executor) {
      return {
        ok: false,
        error: { kind: "not_configured", what: "ssh access" },
        durationMs: 0,
      };
    }

    try {
      const result = await context.executor.run(SYSTEM_COLLECT_SCRIPT, {
        timeoutMs: context.timeoutMs,
      });

      if (result.exitCode !== 0) {
        return {
          ok: false,
          error: {
            kind: "unreachable",
            detail: result.stderr.trim() || `exit code ${result.exitCode}`,
          },
          durationMs: Date.now() - startedAt,
        };
      }

      return {
        ok: true,
        data: parseSnapshot(result.stdout),
        durationMs: Date.now() - startedAt,
      };
    } catch (cause) {
      return {
        ok: false,
        error: toProbeError(cause),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  toMetrics(snapshot: SystemSnapshot, context: ProbeContext): MetricPoint[] {
    const base = { ts: context.startedAt, node: context.nodeName };

    // Normalised to percent: raw load and byte counts are not
    // comparable between machines with different cores and disks.
    const loadPercent = (snapshot.load1 / snapshot.cpuCount) * 100;
    const memUsedPercent =
      ((snapshot.memTotalKb - snapshot.memAvailableKb) / snapshot.memTotalKb) *
      100;
    const diskUsedPercent =
      (snapshot.diskUsedBytes / snapshot.diskTotalBytes) * 100;

    return [
      { ...base, metric: "system.load_percent", value: round(loadPercent) },
      { ...base, metric: "system.mem_percent", value: round(memUsedPercent) },
      { ...base, metric: "system.disk_percent", value: round(diskUsedPercent) },
      {
        ...base,
        metric: "system.uptime_seconds",
        value: Math.floor(snapshot.uptimeSeconds),
      },
      { ...base, ...comparePorts(snapshot.listeningPorts, context) },
    ];
  }
}

function parseSnapshot(stdout: string): SystemSnapshot {
  const parsed: unknown = JSON.parse(stdout.trim());

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Collect script returned unexpected output");
  }

  return parsed as SystemSnapshot;
}

function toProbeError(cause: unknown): ProbeError {
  const message = cause instanceof Error ? cause.message : String(cause);

  if (cause instanceof Error && cause.name === "CommandTimeoutError") {
    return { kind: "timeout" };
  }

  if (message.includes("Permission denied") || message.includes("publicKey")) {
    return { kind: "auth_failed" };
  }

  return { kind: "internal", cause };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Compares what is actually listening against what the config
 * declares.
 *
 * An undeclared port is either something installed and forgotten,
 * or something that should not be there at all. A declared port
 * that stopped listening means the service is down.
 */
function comparePorts(
  listeningCsv: string,
  context: ProbeContext,
): Pick<MetricPoint, "metric" | "value" | "ok" | "meta"> {
  const listening = listeningCsv
    .split(",")
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isFinite(port));

  const declaredPorts = new Set(context.ports.map((port) => port.port));

  const undeclared = listening.filter((port) => !declaredPorts.has(port));
  const missing = context.ports
    .filter((port) => !listening.includes(port.port))
    .map((port) =>
      port.label ? `${port.label}:${port.port}` : `${port.port}`,
    );

  // Nothing declared means nothing to compare against; reporting
  // every open port as a problem would be noise.
  const hasExpectations = context.ports.length > 0;

  return {
    metric: "system.ports",
    value: listening.length,
    ok: !hasExpectations || (undeclared.length === 0 && missing.length === 0),
    meta: { listening, undeclared, missing },
  };
}
