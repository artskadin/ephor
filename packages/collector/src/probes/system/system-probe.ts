import type {
  MetricPoint,
  Probe,
  ProbeContext,
  ProbeDescriptor,
  ProbeError,
  ProbeOutcome,
} from "@ephorate/core";
import { systemCollectScript } from "./collect-script";

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
  /** One reading, or two a few seconds apart; null without an interface. */
  network: unknown[] | null;
}

/** The default-route interface's byte counters, by the node's own clock. */
interface NetworkReading {
  interface: string;
  bootId: string;
  uptimeSeconds: number;
  receivedBytes: number;
  sentBytes: number;
}

interface Traffic {
  receivedMbps: number;
  sentMbps: number;
}

interface SystemResult extends SystemSnapshot {
  /**
   * None when there is nothing fair to compare: nothing is written, and the
   * last value stands (a value-less point would read as ok over a warn).
   */
  traffic: Traffic | undefined;
}

// About as long as reachability takes beside it in a check, and well under
// the 15 s timeout with a 3 s login through a jump host.
const SECOND_READ_AFTER_SECONDS = 5;
// Under the second read's 5 s, so its pair always counts: the node's uptime
// counts in hundredths, and 5 s of sleep can read as 4.99.
const SHORTEST_WINDOW_SECONDS = 4;

interface SystemProbeOptions {
  /**
   * A check with no daemon runs once, with no earlier reading ever: the
   * script reads twice. A daemon never waits on a node.
   */
  readsTwicePerRun?: boolean;
}

export class SystemProbe implements Probe<SystemResult> {
  readonly descriptor = systemProbeDescriptor;
  /** By node name: what the next run measures traffic against. */
  private readonly previousReadings = new Map<string, NetworkReading>();
  private readonly readsTwicePerRun: boolean;

  constructor(options: SystemProbeOptions = {}) {
    this.readsTwicePerRun = options.readsTwicePerRun ?? false;
  }

  async run(context: ProbeContext): Promise<ProbeOutcome<SystemResult>> {
    const startedAt = Date.now();

    if (!context.executor) {
      return {
        ok: false,
        error: { kind: "not_configured", what: "ssh access" },
        durationMs: 0,
      };
    }

    try {
      const script = systemCollectScript(
        this.readsTwicePerRun ? SECOND_READ_AFTER_SECONDS : 0,
      );
      const result = await context.executor.run(script, {
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

      const snapshot = parseSnapshot(result.stdout);
      const traffic = this.measureTraffic(
        context.nodeName,
        (snapshot.network ?? []).filter(isNetworkReading),
        context.intervalSeconds,
      );

      return {
        ok: true,
        data: { ...snapshot, traffic },
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

  /** Two readings of this run, else this one against the previous run's. */
  private measureTraffic(
    nodeName: string,
    readings: readonly NetworkReading[],
    intervalSeconds: number | null,
  ): Traffic | undefined {
    const previous = this.previousReadings.get(nodeName);
    const [first, second] = readings;

    if (first === undefined) {
      this.previousReadings.delete(nodeName);
      return undefined;
    }
    if (second !== undefined) {
      this.previousReadings.set(nodeName, second);
      return trafficBetween(first, second, null);
    }
    // A forced check seconds after a run: the base stays for the next run.
    if (previous !== undefined && isTooSoon(previous, first)) return undefined;

    this.previousReadings.set(nodeName, first);
    if (previous === undefined) return undefined;

    // Older than two runs: the mean of hours would pass for the last minute.
    const longestWindowSeconds =
      intervalSeconds === null ? null : intervalSeconds * 2;
    return trafficBetween(previous, first, longestWindowSeconds);
  }

  toMetrics(snapshot: SystemResult, context: ProbeContext): MetricPoint[] {
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
      ...(snapshot.traffic === undefined
        ? []
        : [
            {
              ...base,
              metric: "system.received_mbps",
              value: snapshot.traffic.receivedMbps,
            },
            {
              ...base,
              metric: "system.sent_mbps",
              value: snapshot.traffic.sentMbps,
            },
          ]),
    ];
  }
}

function isTooSoon(earlier: NetworkReading, later: NetworkReading): boolean {
  const seconds = later.uptimeSeconds - earlier.uptimeSeconds;

  return (
    later.bootId === earlier.bootId &&
    seconds >= 0 &&
    seconds < SHORTEST_WINDOW_SECONDS
  );
}

// None across a reboot (another boot id: the counter may even have grown
// past the old one), a moved route, a reset counter or too long a window.
export function trafficBetween(
  earlier: NetworkReading,
  later: NetworkReading,
  longestWindowSeconds: number | null,
): Traffic | undefined {
  const seconds = later.uptimeSeconds - earlier.uptimeSeconds;
  const receivedBytes = later.receivedBytes - earlier.receivedBytes;
  const sentBytes = later.sentBytes - earlier.sentBytes;

  if (
    later.bootId !== earlier.bootId ||
    later.interface !== earlier.interface ||
    receivedBytes < 0 ||
    sentBytes < 0 ||
    seconds < SHORTEST_WINDOW_SECONDS ||
    (longestWindowSeconds !== null && seconds > longestWindowSeconds)
  ) {
    return undefined;
  }

  const megabitsPerSecond = (bytes: number) =>
    roundToTenth((bytes * 8) / seconds / 1_000_000);

  return {
    receivedMbps: megabitsPerSecond(receivedBytes),
    sentMbps: megabitsPerSecond(sentBytes),
  };
}

// From the wire: a reading missing a field would read as NaN Mbit/s.
function isNetworkReading(value: unknown): value is NetworkReading {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.interface === "string" &&
    typeof candidate.bootId === "string" &&
    typeof candidate.uptimeSeconds === "number" &&
    typeof candidate.receivedBytes === "number" &&
    typeof candidate.sentBytes === "number"
  );
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
    const unreadable = "ss is missing or failed on the node";
    return {
      metric: "system.ports",
      ok: false,
      meta: { unreadable, detail: unreadable },
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
  const ok =
    !hasExpectations || (undeclared.length === 0 && missing.length === 0);

  // In full, for the line under the node: the table's cell is cut short.
  const detail = [
    ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
    ...(undeclared.length > 0
      ? [`extra ${undeclared.join(", ")} (listening, not declared)`]
      : []),
  ].join("; ");

  return {
    metric: "system.ports",
    value: listening.length,
    ok,
    meta: { listening, undeclared, missing, ...(ok ? {} : { detail }) },
  };
}
