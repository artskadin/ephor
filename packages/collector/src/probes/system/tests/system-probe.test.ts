import { type ProbeContext, parseConfig } from "@ephorate/core";
import { describe, expect, it } from "vitest";
import {
  SystemProbe,
  systemProbeDescriptor,
  trafficBetween,
} from "../system-probe";

const SNAPSHOT = {
  hostName: "achilles",
  load1: 0.5,
  load5: 0.5,
  load15: 0.5,
  cpuCount: 2,
  uptimeSeconds: 1000,
  memTotalKb: 1000,
  memAvailableKb: 500,
  diskTotalBytes: 1000,
  diskUsedBytes: 100,
  network: null,
  traffic: undefined,
};

/** The node's ports as the config schema resolves them. */
function contextWith(ports: unknown[]): ProbeContext {
  const config = parseConfig(
    {
      probes: { system: {} },
      nodes: [
        { name: "achilles", host: "203.0.113.10", ssh: "achilles", ports },
      ],
    },
    [systemProbeDescriptor],
  );

  return {
    nodeName: "achilles",
    host: "203.0.113.10",
    ports: config.nodes[0]?.ports ?? [],
    startedAt: 1_800_000_000,
    timeoutMs: 1000,
    intervalSeconds: 60,
    settings: {},
  };
}

function portsPoint(listeningPorts: string | null, ports: unknown[] = []) {
  return new SystemProbe()
    .toMetrics({ ...SNAPSHOT, listeningPorts }, contextWith(ports))
    .find((point) => point.metric === "system.ports");
}

describe("SystemProbe's system.ports", () => {
  it("lists what listens and is ok with nothing declared", () => {
    expect(portsPoint("443,2222,3948")).toMatchObject({
      ok: true,
      value: 3,
      meta: { listening: [443, 2222, 3948] },
    });
  });

  it("reads an empty list as no ports, not port 0", () => {
    expect(portsPoint("")).toMatchObject({
      ok: true,
      value: 0,
      meta: { listening: [], undeclared: [], missing: [] },
    });
  });

  it("compares with what is declared: extra and missing", () => {
    expect(portsPoint("443,2222", [443])).toMatchObject({
      ok: false,
      meta: { undeclared: [2222], missing: [] },
    });
    expect(portsPoint("", [443])).toMatchObject({
      ok: false,
      meta: { undeclared: [], missing: ["443"] },
    });
  });

  // The table cuts its cell short; the line under the node has it all.
  it("says what is wrong in full, and nothing when all is as declared", () => {
    expect(
      portsPoint("443,2222,3948", [443, { port: 9999, label: "xray" }])?.meta
        ?.detail,
    ).toBe("missing xray:9999; extra 2222, 3948 (listening, not declared)");
    expect(portsPoint("443", [443])?.meta).not.toHaveProperty("detail");
    expect(portsPoint("443,2222")?.meta).not.toHaveProperty("detail");
  });

  it("says it cannot tell when ss gave no answer", () => {
    expect(portsPoint(null)).toEqual({
      ts: 1_800_000_000,
      node: "achilles",
      metric: "system.ports",
      ok: false,
      meta: {
        unreadable: "ss is missing or failed on the node",
        detail: "ss is missing or failed on the node",
      },
    });
  });
});

describe("SystemProbe.run on a failed ssh", () => {
  // The texts and codes are ssh's, measured on odysseus 2026-10-06.
  function runWith(exitCode: number, stderr: string) {
    return new SystemProbe().run({
      ...contextWith([]),
      executor: { run: async () => ({ stdout: "", stderr, exitCode }) },
    });
  }

  it("calls a refused login auth_failed, keeping ssh's words", async () => {
    const outcome = await runWith(
      255,
      "bruce@203.0.113.10: Permission denied (publickey).\n",
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        kind: "auth_failed",
        detail: "bruce@203.0.113.10: Permission denied (publickey).",
      },
    });
  });

  // Logged in, then the script was refused a file: not a failed login.
  it("leaves a script's own Permission denied unreachable", async () => {
    const outcome = await runWith(1, "cat: /etc/shadow: Permission denied\n");

    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "unreachable" },
    });
  });

  it.each([
    "ssh: connect to host 203.0.113.10 port 9: Operation timed out\n",
    "unix_listener: cannot bind to path /root/.ssh/cm-ab12: Permission denied\n",
  ])("leaves ssh's other failures unreachable: %s", async (stderr) => {
    const outcome = await runWith(255, stderr);

    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "unreachable" },
    });
  });
});

describe("trafficBetween", () => {
  const reading = (
    uptimeSeconds: number,
    receivedBytes: number,
    sentBytes: number,
    bootId = "boot-a",
  ) => ({ interface: "ens3", bootId, uptimeSeconds, receivedBytes, sentBytes });

  it("gives the mean over the time between, in Mbit/s each way", () => {
    // 2.25 GB in and 1.5 GB out in a minute; counters past 2^31 already.
    const earlier = reading(1000, 167_000_000_000, 151_000_000_000);
    const later = reading(1060, 169_250_000_000, 152_500_000_000);

    expect(trafficBetween(earlier, later, 120)).toEqual({
      receivedMbps: 300,
      sentMbps: 200,
    });
  });

  // After a long absence a rebooted node's counter may have outgrown the old.
  it("gives none across a reboot, even when the counter grew past it", () => {
    const beforeReboot = reading(1000, 5_000, 5_000, "boot-a");
    const afterReboot = reading(1050, 9_000_000, 9_000_000, "boot-b");

    expect(trafficBetween(beforeReboot, afterReboot, 120)).toBeUndefined();
  });

  it("gives none over a reset counter or another interface", () => {
    const earlier = reading(1000, 9_000, 9_000);
    const elsewhere = { ...reading(1060, 9_500, 9_500), interface: "eth1" };

    expect(
      trafficBetween(earlier, reading(1060, 8_000, 9_500), 120),
    ).toBeUndefined();
    expect(trafficBetween(earlier, elsewhere, 120)).toBeUndefined();
  });

  // A laptop's collector waking after a night: not the last minute's load.
  it("does not pass a mean of hours for the last minute", () => {
    expect(
      trafficBetween(reading(0, 0, 0), reading(28_800, 9, 9), 120),
    ).toBeUndefined();
    expect(
      trafficBetween(reading(0, 0, 0), reading(28_800, 9, 9), null),
    ).toBeDefined();
  });

  it("gives none over seconds", () => {
    expect(
      trafficBetween(reading(1000, 0, 0), reading(1002, 9, 9), 120),
    ).toBeUndefined();
  });
});

describe("SystemProbe traffic over runs", () => {
  /** A node whose script answers each call's `network` field as given. */
  function nodeAnswering(network: (call: number) => unknown) {
    const scripts: string[] = [];
    let call = 0;
    const executor = {
      run: async (script: string) => {
        scripts.push(script);
        call += 1;
        const stdout = JSON.stringify({ ...SNAPSHOT, network: network(call) });
        return { stdout, stderr: "", exitCode: 0 };
      },
    };
    return { scripts, executor };
  }

  const at = (uptimeSeconds: number, bytes: number, bootId = "boot-a") => ({
    interface: "ens3",
    bootId,
    uptimeSeconds,
    receivedBytes: bytes,
    sentBytes: bytes,
  });

  async function trafficOf(probe: SystemProbe, executor: unknown) {
    const outcome = await probe.run({
      ...contextWith([]),
      executor: executor as ProbeContext["executor"],
    });
    if (!outcome.ok) throw new Error("the run failed");
    return outcome.data.traffic;
  }

  // A run with no value would leave the last one to read stale: after a
  // serve restart every node did, until its second run.
  it("reads twice with no earlier reading, then once against the last", async () => {
    const probe = new SystemProbe();
    const node = nodeAnswering((call) =>
      call === 1
        ? [at(1000, 0), at(1005, 62_500_000)]
        : [at(1065, 62_500_000 + 750_000_000)],
    );

    const first = await trafficOf(probe, node.executor);
    const second = await trafficOf(probe, node.executor);

    expect(node.scripts[0]).toContain("is_fair_base() { return 1; }");
    expect(first).toEqual({ receivedMbps: 100, sentMbps: 100 });
    // The base is the second reading, good for two intervals of 60 s.
    expect(node.scripts[1]).toContain(
      `*'"interface":"ens3","bootId":"boot-a",'*`,
    );
    expect(node.scripts[1]).toContain("<= 1125)");
    expect(second).toEqual({ receivedMbps: 100, sentMbps: 100 });
  });

  // A forced check right after a scheduled run: seconds say little, and the
  // next scheduled run still gets its full minute.
  it("keeps the earlier base when a run comes seconds after the last", async () => {
    const probe = new SystemProbe();
    const uptimes = [1000, 1002, 1060];
    const node = nodeAnswering((call) => [
      at(uptimes[call - 1] ?? 0, 7_500_000 * (call === 3 ? 100 : call)),
    ]);

    await trafficOf(probe, node.executor);
    const tooSoon = await trafficOf(probe, node.executor);
    const next = await trafficOf(probe, node.executor);

    expect(tooSoon).toBeUndefined();
    expect(next).toEqual({ receivedMbps: 99, sentMbps: 99 });
  });

  // The script reads twice when its first reading is of another boot: the
  // run measures within itself, and the run after against it.
  it("measures within the run after a reboot, then against it", async () => {
    const probe = new SystemProbe();
    const node = nodeAnswering((call) => {
      if (call === 1) return [at(5000, 9_000_000_000, "boot-a")];
      if (call === 2) {
        return [at(60, 0, "boot-b"), at(65, 62_500_000, "boot-b")];
      }
      return [at(125, 62_500_000 + 750_000_000, "boot-b")];
    });

    await trafficOf(probe, node.executor);
    const afterReboot = await trafficOf(probe, node.executor);
    const next = await trafficOf(probe, node.executor);

    expect(afterReboot).toEqual({ receivedMbps: 100, sentMbps: 100 });
    expect(next).toEqual({ receivedMbps: 100, sentMbps: 100 });
  });

  // A reading that vanished during the second read, or a broken one.
  it("passes over a reading that is not one, without failing the run", async () => {
    const probe = new SystemProbe();
    const node = nodeAnswering(() => [at(1000, 0), null]);

    expect(await trafficOf(probe, node.executor)).toBeUndefined();
  });

  it("forgets a node whose counters it could not read", async () => {
    const probe = new SystemProbe();
    const node = nodeAnswering((call) =>
      call === 2 ? null : [at(1000 + 60 * call, 0)],
    );

    await trafficOf(probe, node.executor);
    const unreadable = await trafficOf(probe, node.executor);
    await trafficOf(probe, node.executor);

    expect(unreadable).toBeUndefined();
    expect(node.scripts[2]).toContain("is_fair_base() { return 1; }");
  });

  it("writes how full the promised port is each way, with a bandwidth", () => {
    const probe = new SystemProbe();
    const traffic = { receivedMbps: 450, sentMbps: 60 };
    const points = (bandwidth?: { received: number; sent: number }) =>
      probe
        .toMetrics(
          { ...SNAPSHOT, listeningPorts: "", traffic },
          { ...contextWith([]), bandwidth },
        )
        .filter((point) =>
          ["system.received_percent", "system.sent_percent"].includes(
            point.metric,
          ),
        );

    expect(points({ received: 1000, sent: 300 })).toMatchObject([
      { metric: "system.received_percent", value: 45 },
      { metric: "system.sent_percent", value: 20 },
    ]);
    // A port faster than promised (leonidas: 1 Gbit/s sold, ~5.7 real).
    expect(points({ received: 300, sent: 180 })).toMatchObject([
      { metric: "system.received_percent", value: 150 },
      { metric: "system.sent_percent", value: 33.3 },
    ]);
    expect(points(undefined)).toEqual([]);
  });

  // A value-less point would read as ok over a warn: none is written, and
  // the last value stands until the next one.
  it("writes both directions when measured, and nothing when not", () => {
    const probe = new SystemProbe();
    const pointsFor = (
      traffic: { receivedMbps: number; sentMbps: number } | undefined,
    ) =>
      probe
        .toMetrics(
          { ...SNAPSHOT, listeningPorts: "", traffic },
          contextWith([]),
        )
        .filter((point) => point.metric.endsWith("_mbps"));

    expect(pointsFor({ receivedMbps: 300, sentMbps: 200 })).toMatchObject([
      { metric: "system.received_mbps", value: 300 },
      { metric: "system.sent_mbps", value: 200 },
    ]);
    expect(pointsFor(undefined)).toEqual([]);
  });
});

// A metric written but not listed is never shown: the list must be whole.
describe("systemProbeDescriptor.listMetrics", () => {
  const metricsWrittenAndListed = (bandwidth?: string) => {
    const [node] = parseConfig(
      {
        probes: { system: {} },
        nodes: [
          {
            name: "achilles",
            host: "203.0.113.10",
            ssh: "achilles",
            ...(bandwidth === undefined ? {} : { bandwidth }),
          },
        ],
      },
      [systemProbeDescriptor],
    ).nodes;
    if (node === undefined) throw new Error("expected a node to parse");

    const written = new SystemProbe()
      .toMetrics(
        {
          ...SNAPSHOT,
          listeningPorts: "443",
          traffic: { receivedMbps: 450, sentMbps: 60 },
        },
        { ...contextWith([]), bandwidth: node.bandwidth },
      )
      .map((point) => point.metric);

    return {
      written: written.sort(),
      listed: [...systemProbeDescriptor.listMetrics(node, {})].sort(),
    };
  };

  it("lists exactly what a full run writes, without a bandwidth", () => {
    const { written, listed } = metricsWrittenAndListed();

    expect(listed).toEqual(written);
    expect(listed).not.toContain("system.received_percent");
  });

  it("lists exactly what a full run writes, with a bandwidth", () => {
    const { written, listed } = metricsWrittenAndListed("1Gbit");

    expect(listed).toEqual(written);
    expect(listed).toContain("system.received_percent");
  });

  // What a threshold may name: everything any node can get.
  it("has every metric of any node in its catalog", () => {
    const { written } = metricsWrittenAndListed("1Gbit");

    expect([...systemProbeDescriptor.listAllMetrics({})].sort()).toEqual(
      written,
    );
  });
});
