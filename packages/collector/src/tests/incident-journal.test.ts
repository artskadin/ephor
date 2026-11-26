import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createLogger,
  type ProbeReading,
  parseConfig,
  type Vantage,
} from "@ephorate/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Collector } from "../collector";
import { ReachabilityProbe } from "../probes/reachability/reachability-probe";
import { ProbeRegistry } from "../probes/registry";
import { SystemProbe } from "../probes/system/system-probe";
import { ProviderResponseError } from "../reachability/provider-response-error";
import { serve } from "../serve";
import { SqliteStorage } from "../storage/sqlite-storage";

const startTime = 1_800_000_000;
const REGION_SETTINGS = { targets: ["ru"], control: ["de"] };
const LOGGER = createLogger({ level: "silent" });

interface IncidentRow {
  id: number;
  kind: string;
  subject_json: string;
  state: string;
  first_observed_at: number;
  last_event_at: number;
  ended_at: number | null;
  end_reason: string | null;
}

interface EventRow {
  observed_at: number;
  event_kind: string;
  evidence_json: string;
}

describe("collector incident journal", () => {
  let directory: string;
  let path: string;
  let now: number;
  let reader: DatabaseSync;
  let storage: SqliteStorage | undefined;
  let collector: Collector | undefined;
  let ruPassed: number;
  let ruPoints: string[];
  let badResponse: boolean;
  let disk: number;
  let systemFailure: boolean;
  let listeners: string | null;
  let sentBytes: number;
  let receivedBytes: number;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ephor-journal-"));
    path = join(directory, "metrics.db");
    reader = new DatabaseSync(path);
    now = startTime;
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    ruPassed = 3;
    ruPoints = ["ru1", "ru2", "ru3"];
    badResponse = false;
    disk = 50;
    systemFailure = false;
    listeners = "443";
    sentBytes = 600_000_000;
    receivedBytes = 0;
  });

  async function closeCollector() {
    collector?.stop();
    collector = undefined;
    await storage?.close();
    storage = undefined;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeCollector();
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function start(
    options: {
      endpoint?: string;
      critical?: number;
      regions?: typeof REGION_SETTINGS;
      host?: string;
      ssh?: unknown;
      bandwidth?: { received: string; sent: string };
      thresholdMetric?: string;
    } = {},
  ) {
    const registry = new ProbeRegistry();
    const system = new SystemProbe();
    registry.register({
      descriptor: system.descriptor,
      run: (context) =>
        system.run({
          ...context,
          executor: {
            run: async () =>
              systemFailure
                ? {
                    exitCode: 255,
                    stdout: "",
                    stderr: "Permission denied (publickey).",
                  }
                : {
                    exitCode: 0,
                    stderr: "",
                    stdout: JSON.stringify({
                      hostName: "fixture",
                      load1: 0.5,
                      load5: 0.5,
                      load15: 0.5,
                      cpuCount: 2,
                      uptimeSeconds: 1000,
                      memTotalKb: 1000,
                      memAvailableKb: 700,
                      diskTotalBytes: 100,
                      diskUsedBytes: disk,
                      listeningPorts: listeners,
                      network: [0, 5].map((offset) => ({
                        interface: "eth0",
                        bootId: "fixture",
                        uptimeSeconds: 1000 + offset,
                        sentBytes: sentBytes * (offset / 5),
                        receivedBytes: receivedBytes * (offset / 5),
                      })),
                    }),
                  },
          },
        }),
      toMetrics: system.toMetrics.bind(system),
    });
    registry.register(
      new ReachabilityProbe({
        createProvider: () => ({
          id: "fixture",
          async listVantages(): Promise<Vantage[]> {
            return [...ruPoints, "de1"].map((id) => ({
              id,
              countryCode: id.slice(0, 2),
              network: "datacenter",
            }));
          },
          async probe({ target, vantages }): Promise<ProbeReading[]> {
            if (badResponse)
              throw new ProviderResponseError(
                "fixture provider returned no result",
              );
            return vantages.map((vantage, index) => ({
              vantage,
              method: target.method,
              ok: vantage.countryCode === "de" || index < ruPassed,
            }));
          },
        }),
        requesterFor: () => ({
          getJson: () =>
            Promise.reject(new Error("unexpected network in an offline test")),
        }),
      }),
    );
    const config = parseConfig(
      {
        probes: {
          system: { retries: 0 },
          reachability: { regions: options.regions ?? REGION_SETTINGS },
        },
        nodes: [
          {
            name: "gateway",
            host: options.host ?? "203.0.113.10",
            ssh: options.ssh ?? "fixture-admin",
            bandwidth: options.bandwidth,
            ports: [443],
            endpoints: { [options.endpoint ?? "vpn"]: { tcp: 443 } },
          },
        ],
        thresholds: {
          [options.thresholdMetric ?? "system.disk_percent"]: {
            warn: 85,
            critical: options.critical ?? 95,
          },
        },
      },
      registry.descriptors(),
    );
    storage = new SqliteStorage(path, LOGGER);
    collector = new Collector({ config, registry, storage, logger: LOGGER });
    await collector.start();
    // Schedule nothing in the background; exercise the same pipeline with forced tasks.
    collector.stop();
  }

  async function measure(probe?: string) {
    if (collector === undefined) throw new Error("test collector not started");
    await collector.runNow(undefined, probe === undefined ? undefined : [probe])
      .finished;
    now += 60;
  }

  function incidents(kind: string): IncidentRow[] {
    return reader
      .prepare("SELECT * FROM incidents WHERE kind = ? ORDER BY id")
      .all(kind) as unknown as IncidentRow[];
  }

  function events(incident: IncidentRow | undefined): EventRow[] {
    if (incident === undefined) throw new Error("expected an incident");
    return reader
      .prepare(`
      SELECT observed_at, event_kind, evidence_json FROM journal_events WHERE incident_id = ? ORDER BY id
    `)
      .all(incident.id) as unknown as EventRow[];
  }

  it("does not reconcile incidents when a second serve cannot bind its API", async () => {
    await start();
    ruPassed = 0;
    await measure("reachability");
    const [open] = incidents("network");
    expect(open?.state).toBe("open");
    const timeline = events(open);
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = occupied.address();
      if (address === null || typeof address === "string")
        throw new Error("expected a TCP listener");
      const configPath = join(directory, "replacement.yaml");
      writeFileSync(
        configPath,
        [
          "probes:",
          "  system: {}",
          "nodes:",
          "  - name: replacement",
          "    host: 203.0.113.11",
          "    local: true",
          "api:",
          `  port: ${address.port}`,
        ].join("\n"),
      );
      await expect(
        serve({
          configPath,
          databasePath: path,
          token: "fixture",
          version: "test",
          logger: LOGGER,
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(incidents("network")).toEqual([open]);
      expect(events(open)).toEqual(timeline);
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await measure("reachability");
    expect(incidents("network")).toHaveLength(1);
    expect(events(open)).toEqual(timeline);
  });

  it.each([
    { change: "host", host: "203.0.113.8", port: 22 },
    { change: "port", host: "203.0.113.7", port: 2222 },
  ])(
    "stops a disk incident when the same node name changes its direct SSH $change",
    async ({ host, port }) => {
      await start({ host: "203.0.113.7", ssh: { user: "monitor", port: 22 } });
      disk = 98;
      await measure("system");
      await closeCollector();

      await start({ host, ssh: { user: "monitor", port } });
      disk = 10;
      await measure("system");
      const [old] = incidents("system");
      expect(incidents("system")).toHaveLength(1);
      expect(old).toMatchObject({
        state: "observation_stopped",
        end_reason: "not_monitored",
      });
      expect(JSON.parse(old?.subject_json ?? "{}")).toMatchObject({
        machine: { kind: "ssh_host", host: "203.0.113.7", port: 22 },
      });
      expect(events(old).map(({ event_kind }) => event_kind)).toEqual([
        "opened",
        "observation_stopped",
      ]);
    },
  );

  it("keeps a system incident when the public host changes but the SSH alias does not", async () => {
    await start({ host: "203.0.113.7" });
    disk = 98;
    await measure("system");
    await closeCollector();
    await start({ host: "203.0.113.8" });
    expect(incidents("system")[0]?.state).toBe("open");
    disk = 10;
    await measure("system");
    const [incident] = incidents("system");
    expect(incidents("system")).toHaveLength(1);
    expect(events(incident).map(({ event_kind }) => event_kind)).toEqual([
      "opened",
      "recovered",
    ]);
  });

  it.each([
    { direction: "sent", opposite: "received" },
    { direction: "received", opposite: "sent" },
  ] as const)(
    "uses only the $direction bandwidth in the ratio's incident rule",
    async ({ direction, opposite }) => {
      receivedBytes = sentBytes = 60_000_000;
      const baseline = { received: "100Mbit", sent: "100Mbit" };
      const thresholdMetric = `system.${direction}_percent`;
      await start({ bandwidth: baseline, thresholdMetric });
      await measure("system");
      const [before] = incidents("system");
      expect(before?.state).toBe("open");
      await closeCollector();

      const otherDirectionChanged = { ...baseline, [opposite]: "1Gbit" };
      await start({ bandwidth: otherDirectionChanged, thresholdMetric });
      await measure("system");
      expect(incidents("system")[0]?.state).toBe("open");
      expect(events(before)).toHaveLength(1);
      await closeCollector();

      await start({
        bandwidth: { ...otherDirectionChanged, [direction]: "1Gbit" },
        thresholdMetric,
      });
      await measure("system");
      expect(
        reader
          .prepare("SELECT value FROM metrics_latest WHERE metric = ?")
          .get(`system.${direction}_mbps`)?.value,
      ).toBe(96);
      const [after] = incidents("system");
      expect(incidents("system")).toHaveLength(1);
      expect(after).toMatchObject({
        state: "observation_stopped",
        end_reason: "rule_changed",
      });
      expect(events(after).map(({ event_kind }) => event_kind)).toEqual([
        "opened",
        "observation_stopped",
      ]);
    },
  );

  it("keeps an endpoint outage and a disk breach independent, and groups changes in one episode", async () => {
    await start();
    await measure();
    expect(incidents("network")).toEqual([]);
    expect(incidents("system")).toEqual([]);
    expect(
      reader
        .prepare(
          "SELECT value FROM metrics_latest WHERE metric = 'system.sent_mbps'",
        )
        .get()?.value,
    ).toBeGreaterThan(0);

    ruPassed = 2;
    disk = 96;
    await measure();
    await measure();
    ruPassed = 1;
    await measure();
    ruPassed = 0;
    await measure();
    ruPassed = 3;
    await measure();

    const [network] = incidents("network");
    expect(incidents("network")).toHaveLength(1);
    expect(network).toMatchObject({
      state: "recovered",
      first_observed_at: startTime + 60,
      ended_at: startTime + 300,
    });
    const timeline = events(network);
    expect(timeline.map(({ event_kind }) => event_kind)).toEqual([
      "opened",
      "changed",
      "changed",
      "recovered",
    ]);
    expect(JSON.parse(timeline[1]?.evidence_json ?? "{}")).toMatchObject({
      evidence: {
        countries: [
          expect.objectContaining({ country: "ru", passed: 1, reported: 3 }),
          expect.objectContaining({ country: "de", passed: 1 }),
        ],
      },
    });
    const [diskIncident] = incidents("system");
    expect(incidents("system")).toHaveLength(1);
    expect(diskIncident?.state).toBe("open");
    expect(JSON.parse(diskIncident?.subject_json ?? "{}")).toMatchObject({
      check: { metric: "system.disk_percent" },
    });
    expect(events(diskIncident).map(({ event_kind }) => event_kind)).toEqual([
      "opened",
    ]);

    ruPassed = 2;
    await measure("reachability");
    expect(incidents("network").map(({ state }) => state)).toEqual([
      "recovered",
      "open",
    ]);
  });

  it("keeps a measured outage open through a failed check, then closes only the measurement failure when data returns", async () => {
    await start();
    ruPassed = 0;
    await measure("reachability");
    badResponse = true;
    await measure("reachability");
    await measure("reachability");
    expect(incidents("network")[0]?.state).toBe("open");
    expect(incidents("measurement")[0]?.state).toBe("open");
    badResponse = false;
    await measure("reachability");
    const [outage] = incidents("network");
    expect(outage?.state).toBe("open");
    expect(events(outage).map(({ event_kind }) => event_kind)).toEqual([
      "opened",
      "measurement_lost",
      "measurement_resumed",
    ]);
    const [measurement] = incidents("measurement");
    expect(measurement?.state).toBe("recovered");
    expect(events(measurement).map(({ event_kind }) => event_kind)).toEqual([
      "opened",
      "recovered",
    ]);
  });

  it("records a real failure even with missing target coverage, without treating missing data as a failure", async () => {
    await start({ regions: { targets: ["ru", "kz"], control: [] } });
    await measure("reachability");
    expect(incidents("network")).toEqual([]);
    expect(incidents("measurement")).toHaveLength(1);
    ruPassed = 0;
    await measure("reachability");
    const [outage] = incidents("network");
    expect(outage?.state).toBe("open");
    expect(JSON.parse(events(outage)[0]?.evidence_json ?? "{}")).toMatchObject({
      evidence: {
        verdict: "unknown",
        countries: [
          expect.objectContaining({ country: "ru", passed: 0, reported: 3 }),
          expect.objectContaining({ country: "kz", passed: 0, reported: 0 }),
        ],
      },
    });
  });

  it("compares count changes only after a new point selection has become the baseline", async () => {
    await start();
    ruPassed = 2;
    await measure("reachability");
    ruPoints = ["ru1", "ru2", "ru4"];
    ruPassed = 1;
    await measure("reachability");
    expect(events(incidents("network")[0])).toHaveLength(1);
    ruPassed = 2;
    await measure("reachability");
    expect(
      events(incidents("network")[0]).map(({ event_kind }) => event_kind),
    ).toEqual(["opened", "changed"]);
  });

  it("reopens the database without duplicating the incident, and does not infer recovery from configuration", async () => {
    await start();
    ruPassed = 0;
    disk = 96;
    await measure();
    await closeCollector();
    await start();
    await measure();
    expect(events(incidents("network")[0])).toHaveLength(1);
    expect(events(incidents("system")[0])).toHaveLength(1);

    await closeCollector();
    await start({ endpoint: "entry", critical: 99 });
    const [oldEndpoint] = incidents("network");
    const [oldDisk] = incidents("system");
    expect(oldEndpoint).toMatchObject({
      state: "observation_stopped",
      end_reason: "not_monitored",
    });
    expect(oldDisk).toMatchObject({
      state: "observation_stopped",
      end_reason: "rule_changed",
    });
    await measure();
    expect(incidents("network").map(({ state }) => state)).toEqual([
      "observation_stopped",
      "open",
    ]);
    expect(incidents("system").map(({ state }) => state)).toEqual([
      "observation_stopped",
      "open",
    ]);
  });

  it("separates an unreadable port inventory and a failed SSH session from observed system problems", async () => {
    await start();
    disk = 96;
    listeners = "";
    await measure("system");
    listeners = null;
    await measure("system");
    systemFailure = true;
    await measure("system");
    expect(incidents("network")).toEqual([]);
    expect(incidents("system").map(({ state }) => state)).toEqual([
      "open",
      "open",
    ]);
    expect(incidents("measurement").map(({ state }) => state)).toEqual([
      "open",
      "open",
    ]);

    systemFailure = false;
    listeners = "443";
    await measure("system");
    expect(incidents("measurement").map(({ state }) => state)).toEqual([
      "recovered",
      "recovered",
    ]);
    const systemStates = incidents("system").map(({ subject_json, state }) => [
      JSON.parse(subject_json).check.kind,
      state,
    ]);
    expect(systemStates).toEqual([
      ["threshold", "open"],
      ["port_audit", "recovered"],
    ]);
  });

  it("does not commit metrics or a card if the event insert fails", async () => {
    await start();
    reader.exec(`
      CREATE TRIGGER fixture_reject_event BEFORE INSERT ON journal_events
      BEGIN SELECT RAISE(ABORT, 'fixture: cannot append event'); END
    `);
    ruPassed = 0;
    await measure("reachability");
    expect(incidents("network")).toEqual([]);
    expect(
      reader.prepare("SELECT COUNT(*) AS total FROM metrics").get()?.total,
    ).toBe(0);
    expect(
      reader.prepare("SELECT COUNT(*) AS total FROM metrics_latest").get()
        ?.total,
    ).toBe(0);
    reader.exec("DROP TRIGGER fixture_reject_event");
    await measure("reachability");
    expect(incidents("network")[0]?.state).toBe("open");
  });
});
