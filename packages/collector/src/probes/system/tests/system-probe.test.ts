import { type ProbeContext, parseConfig } from "@ephorate/core";
import { describe, expect, it } from "vitest";
import { SystemProbe, systemProbeDescriptor } from "../system-probe";

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
};

/** The node's ports as the config schema resolves them. */
function contextWith(ports: unknown[]): ProbeContext {
  const config = parseConfig(
    { nodes: [{ name: "achilles", host: "203.0.113.10", ports }] },
    [systemProbeDescriptor],
  );

  return {
    nodeName: "achilles",
    host: "203.0.113.10",
    ports: config.nodes[0]?.ports ?? [],
    startedAt: 1_800_000_000,
    timeoutMs: 1000,
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
