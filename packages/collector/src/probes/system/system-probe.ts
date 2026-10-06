import type {
  MetricPoint,
  Probe,
  ProbeContext,
  ProbeDescriptor,
  ProbeError,
  ProbeOutcome,
} from "@ephorate/core";
import { SYSTEM_COLLECT_SCRIPT } from "./collect-script";

export const systemProbeDescriptor: ProbeDescriptor = {
  name: "system",
  requiresExecutor: true,
  enabledByDefault: true,
  defaults: {
    interval: 60,
    timeout: 15,
    retries: 2,
    // A backstop, not a throttle; ssh has its own limits in `SshGates`.
    concurrency: 50,
  },
};

interface SystemSnapshot {
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
  /** Comma-separated; null when `ss` is missing or failed on the node. */
  listeningPorts: string | null;
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
        const detail = result.stderr.trim() || `exit code ${result.exitCode}`;

        return {
          ok: false,
          error: isRefusedLogin(result.exitCode, result.stderr)
            ? { kind: "auth_failed", detail }
            : { kind: "unreachable", detail },
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

    // Percent: raw load and bytes are not comparable between machines.
    const loadPercent = (snapshot.load1 / snapshot.cpuCount) * 100;
    const memUsedPercent =
      ((snapshot.memTotalKb - snapshot.memAvailableKb) / snapshot.memTotalKb) *
      100;
    const diskUsedPercent =
      (snapshot.diskUsedBytes / snapshot.diskTotalBytes) * 100;

    return [
      {
        ...base,
        metric: "system.load_percent",
        value: roundToTenth(loadPercent),
      },
      {
        ...base,
        metric: "system.mem_percent",
        value: roundToTenth(memUsedPercent),
      },
      {
        ...base,
        metric: "system.disk_percent",
        value: roundToTenth(diskUsedPercent),
      },
      {
        ...base,
        metric: "system.uptime_seconds",
        value: Math.floor(snapshot.uptimeSeconds),
      },
      { ...base, ...comparePorts(snapshot.listeningPorts, context) },
    ];
  }
}

// ssh exits 255 for its own failure, else with the script's code: measured,
// a wrong key is 255 with "Permission denied (publickey)", a script denied
// a file is 1. The "(" keeps out ssh's own, e.g. a ControlPath it can't bind.
function isRefusedLogin(exitCode: number, stderr: string): boolean {
  return exitCode === 255 && stderr.includes("Permission denied (");
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
    return { kind: "auth_failed", detail: message };
  }

  return { kind: "internal", cause };
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

// An undeclared port is something forgotten or something that should not
// be there; a declared port not listening is a service down.
function comparePorts(
  listeningCsv: string | null,
  context: ProbeContext,
): Pick<MetricPoint, "metric" | "value" | "ok" | "meta"> {
  if (listeningCsv === null) {
    return {
      metric: "system.ports",
      ok: false,
      meta: { unreadable: "ss is missing or failed on the node" },
    };
  }

  // `"".split(",")` is `[""]`, and `Number("")` is 0: a port nobody has.
  const listening = listeningCsv
    .split(",")
    .filter((part) => part.trim() !== "")
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isFinite(port));

  const declaredPorts = new Set(context.ports.map((port) => port.port));

  const undeclared = listening.filter((port) => !declaredPorts.has(port));
  const missing = context.ports
    .filter((port) => !listening.includes(port.port))
    .map((port) =>
      port.label ? `${port.label}:${port.port}` : `${port.port}`,
    );

  // Nothing declared, nothing to compare against.
  const hasExpectations = context.ports.length > 0;

  return {
    metric: "system.ports",
    value: listening.length,
    ok: !hasExpectations || (undeclared.length === 0 && missing.length === 0),
    meta: { listening, undeclared, missing },
  };
}
