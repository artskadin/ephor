import type {
  MetricPoint,
  Probe,
  ProbeContext,
  ProbeError,
  ProbeOutcome,
} from "@ephor/core";
import { SYSTEM_COLLECT_SCRIPT } from "./collect-script.js";

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
  readonly name = "system";
  readonly requiresExecutor = true;

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
      {
        ...base,
        metric: "system.ports",
        ok: true,
        meta: { listening: snapshot.listeningPorts },
      },
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
