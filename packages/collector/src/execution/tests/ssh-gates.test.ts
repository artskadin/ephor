import { createLogger, type Logger } from "@ephor/core";
import { describe, expect, it } from "vitest";
import { deferred } from "../../scheduling/tests/deferred.js";
import { SSH_PER_DOOR_LIMIT, SSH_TOTAL_LIMIT, SshGates } from "../ssh-gates.js";
import type { SshInspector } from "../ssh-route.js";

/** Excerpts of real `ssh -G` output, addresses anonymised; see ssh-route.test.ts. */
const VIA_BASTION = (host: string) =>
  `hostname ${host}\nport 2222\ncontrolmaster false\nproxyjump bastion\n`;
const BASTION = "hostname 198.51.100.1\nport 2222\ncontrolmaster false\n";
const BASTION_SHARING =
  "hostname 198.51.100.1\nport 2222\ncontrolmaster auto\ncontrolpath /home/bruce/.ssh/cm-c59e853e8d1f262c\n";
const DIRECT = (host: string) =>
  `hostname ${host}\nport 22\ncontrolmaster false\n`;
const VIA_PROXY = (host: string) =>
  `hostname ${host}\ncontrolmaster false\nproxycommand ssh -W %h:%p bastion\n`;

/** Answers by the last argument; counts the questions. */
function inspectorOf(outputs: Record<string, string>): SshInspector & {
  calls: number;
} {
  const inspect = Object.assign(
    async (args: readonly string[]): Promise<string> => {
      inspect.calls += 1;
      const output = outputs[args.at(-1) ?? ""];
      if (output === undefined)
        throw new Error(`no fixture for ${args.join(" ")}`);

      return output;
    },
    { calls: 0 },
  );

  return inspect;
}

function captureLogs(): { logger: Logger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];

  const logger = createLogger({
    level: "debug",
    format: "json",
    environment: {},
    isTerminal: false,
    write: (line) => records.push(JSON.parse(line) as Record<string, unknown>),
  });

  return { logger, records };
}

/**
 * Starts `count` sessions that stay open until released, and reports how
 * many actually got going. Each session is held on its own gate so the
 * test can release them one at a time.
 */
async function startSessions(
  gates: SshGates,
  targets: readonly string[],
): Promise<{ started: () => number; release: (index: number) => void }> {
  let started = 0;
  const holds = targets.map(() => deferred());

  for (const [index, target] of targets.entries()) {
    void gates.run([target], async () => {
      started += 1;
      await holds[index]?.promise;
    });
  }

  // Routes resolve through a promise each; a few turns of the loop let
  // every session that can start do so.
  for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);

  return {
    started: () => started,
    release: (index) => holds[index]?.resolve(),
  };
}

const BEHIND_BASTION = {
  achilles: VIA_BASTION("203.0.113.10"),
  antilochus: VIA_BASTION("203.0.113.11"),
  bastion: BASTION,
};

describe("SshGates", () => {
  it("ships with the measured limits", () => {
    expect(SSH_TOTAL_LIMIT).toBe(50);
    expect(SSH_PER_DOOR_LIMIT).toBe(8);
  });

  it("lets eight sessions through one jump host and holds the ninth", async () => {
    const gates = new SshGates({
      inspect: inspectorOf(BEHIND_BASTION),
      logger: captureLogs().logger,
    });
    const targets = Array.from({ length: 9 }, (_, index) =>
      index % 2 === 0 ? "achilles" : "antilochus",
    );

    const sessions = await startSessions(gates, targets);

    expect(sessions.started()).toBe(8);

    sessions.release(0);
    await new Promise(setImmediate);

    expect(sessions.started()).toBe(9);
  });

  it("counts a node reached directly against its own sshd only", async () => {
    const gates = new SshGates({
      inspect: inspectorOf({
        "203.0.113.10": DIRECT("203.0.113.10"),
        "203.0.113.11": DIRECT("203.0.113.11"),
      }),
      logger: captureLogs().logger,
      perDoorLimit: 1,
    });

    const sessions = await startSessions(gates, [
      "203.0.113.10",
      "203.0.113.11",
    ]);

    expect(sessions.started()).toBe(2);
  });

  it("does not treat a jump host with connection sharing as a shared sshd", async () => {
    const gates = new SshGates({
      inspect: inspectorOf({ ...BEHIND_BASTION, bastion: BASTION_SHARING }),
      logger: captureLogs().logger,
      perDoorLimit: 1,
    });

    const sessions = await startSessions(gates, ["achilles", "antilochus"]);

    expect(sessions.started()).toBe(2);
  });

  it("treats an identical ProxyCommand as one shared sshd", async () => {
    const gates = new SshGates({
      inspect: inspectorOf({
        "10.0.0.5": VIA_PROXY("10.0.0.5"),
        "10.0.0.6": VIA_PROXY("10.0.0.6"),
      }),
      logger: captureLogs().logger,
      perDoorLimit: 1,
    });

    const sessions = await startSessions(gates, ["10.0.0.5", "10.0.0.6"]);

    expect(sessions.started()).toBe(1);
  });

  it("caps ssh processes in total, whatever the doors", async () => {
    const gates = new SshGates({
      inspect: inspectorOf({
        "203.0.113.10": DIRECT("203.0.113.10"),
        "203.0.113.11": DIRECT("203.0.113.11"),
        "203.0.113.12": DIRECT("203.0.113.12"),
      }),
      logger: captureLogs().logger,
      totalLimit: 2,
    });

    const sessions = await startSessions(gates, [
      "203.0.113.10",
      "203.0.113.11",
      "203.0.113.12",
    ]);

    expect(sessions.started()).toBe(2);
  });

  it("says once, at the first session, what to do about a shared jump host", async () => {
    const { logger, records } = captureLogs();
    const gates = new SshGates({
      inspect: inspectorOf(BEHIND_BASTION),
      logger,
    });

    await gates.run(["achilles"], async () => {});
    await gates.run(["antilochus"], async () => {});

    const warnings = records.filter((record) => record.level === "warn");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toMatch(/jump host "bastion"/);
    expect(warnings[0]?.msg).toMatch(/limited to 8 at a time/);
    expect(warnings[0]?.msg).toMatch(/ControlMaster auto/);
    expect(warnings[0]?.msg).toMatch(/ephor serve/);
  });

  it("asks ssh about each target once", async () => {
    const inspect = inspectorOf(BEHIND_BASTION);
    const gates = new SshGates({ inspect, logger: captureLogs().logger });

    await gates.run(["achilles"], async () => {});
    await gates.run(["achilles"], async () => {});
    await gates.run(["antilochus"], async () => {});

    // Two nodes, each asked once, plus the jump host once per node.
    expect(inspect.calls).toBe(4);
  });

  it("meets two spellings of one jump host in one door", async () => {
    const gates = new SshGates({
      inspect: inspectorOf({
        achilles: VIA_BASTION("203.0.113.10"),
        antilochus: VIA_BASTION("203.0.113.11").replace(
          "proxyjump bastion",
          "proxyjump bruce@bastion:2222",
        ),
        bastion: BASTION,
        "bruce@bastion": BASTION,
      }),
      logger: captureLogs().logger,
      perDoorLimit: 1,
    });

    const sessions = await startSessions(gates, ["achilles", "antilochus"]);

    expect(sessions.started()).toBe(1);
  });

  // Whatever stopped `ssh -G` stops the ssh itself, in the probe, where it
  // is reported; the gate must not add a second failure of its own.
  it("runs the session anyway when the route cannot be resolved, and says so once", async () => {
    const { logger, records } = captureLogs();
    const gates = new SshGates({
      inspect: async () => {
        throw new Error("ssh: command not found");
      },
      logger,
    });

    await expect(gates.run(["achilles"], async () => "ran")).resolves.toBe(
      "ran",
    );
    await gates.run(["achilles"], async () => {});

    expect(records.map((record) => record.msg)).toEqual([
      "could not resolve the ssh route; treating the node as reached directly until it can be",
    ]);
  });

  // A fleet forced at once can push a few inspections past the descriptor
  // limit or the timeout. Remembered, such a node would log into the jump
  // host outside its door for the life of the daemon.
  it("asks again after a failed inspection rather than remembering the fallback", async () => {
    const { logger, records } = captureLogs();
    let attempts = 0;
    const gates = new SshGates({
      inspect: async (args) => {
        attempts += 1;
        if (attempts === 1) throw new Error("EAGAIN");

        return BEHIND_BASTION[args.at(-1) as keyof typeof BEHIND_BASTION];
      },
      logger,
      perDoorLimit: 1,
    });

    await gates.run(["achilles"], async () => {});
    await gates.run(["achilles"], async () => {});

    // The second run found the jump host and said what to do about it.
    expect(records.map((record) => record.level)).toEqual(["warn", "warn"]);
    expect(records[1]?.msg).toMatch(/jump host "bastion"/);

    const sessions = await startSessions(gates, ["achilles", "antilochus"]);

    expect(sessions.started()).toBe(1);
  });

  // An inspection is an ssh process too; fifty at a cold start would be the
  // burst the total exists to prevent.
  it("counts inspections against the total", async () => {
    const inspecting = deferred();
    const gates = new SshGates({
      inspect: async () => {
        await inspecting.promise;

        return DIRECT("203.0.113.10");
      },
      logger: captureLogs().logger,
      totalLimit: 1,
    });

    let ran = 0;
    const first = gates.run(["203.0.113.10"], async () => {
      ran += 1;
    });
    const second = gates.run(["203.0.113.11"], async () => {
      ran += 1;
    });
    for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);

    expect(ran).toBe(0);

    inspecting.resolve();
    await Promise.all([first, second]);

    expect(ran).toBe(2);
  });
});
