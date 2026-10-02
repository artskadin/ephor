import { spawn } from "node:child_process";
import type { Acknowledgement } from "@ephorate/core";
import { afterEach, describe, expect, it } from "vitest";
import { BINARY, ephor } from "./run-binary";
import { closedPortUrl, collectorOf, stateOf, TOKEN } from "./test-server";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("ephor status", () => {
  it("prints the collector's state as JSON on stdout, and nothing else there", async () => {
    const state = stateOf({ name: "achilles", status: "ok" });
    const collector = await collectorOf(state);
    cleanups.push(collector.close);

    const run = await ephor(["status", "--json"], {
      EPHOR_API_URL: collector.url,
      EPHOR_TOKEN: TOKEN,
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(state);
    expect(run.stderr).toBe("");
  });

  it("prints the table without --json, plain when stdout is a pipe", async () => {
    const collector = await collectorOf(
      stateOf(
        { name: "achilles", status: "ok" },
        { name: "german", status: "critical" },
      ),
    );
    cleanups.push(collector.close);

    const run = await ephor(["status"], {
      EPHOR_API_URL: collector.url,
      EPHOR_TOKEN: TOKEN,
    });
    const lines = run.stdout.split("\n");

    expect(run.code).toBe(0);
    expect(lines[0]).toMatch(/^NODE\s+REACH\s+LOAD/);
    expect(lines).toContain("  german is critical");
    expect(run.stdout).not.toContain("\u001b");
    expect(run.stderr).toBe("");
  });

  // The code says the command did its job, not how the fleet is: a
  // terminal that reacts to it (Warp paints the block red) would otherwise
  // call every answer on a fleet with one warn a failure.
  it("exits 0 when a node is not ok: the state is the answer, not the code", async () => {
    const collector = await collectorOf(
      stateOf(
        { name: "achilles", status: "ok" },
        { name: "german", status: "critical" },
      ),
    );
    cleanups.push(collector.close);

    const run = await ephor(["status", "--json"], {
      EPHOR_API_URL: collector.url,
      EPHOR_TOKEN: TOKEN,
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).nodes).toHaveLength(2);
  });

  it("exits 2 without a token, and says which token it wants", async () => {
    const run = await ephor(["status", "--json"]);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/EPHOR_TOKEN is not set/);
  });

  it("exits 2 when the collector is not there, and says where it looked", async () => {
    const url = await closedPortUrl();

    const run = await ephor(["status", "--json"], {
      EPHOR_API_URL: url,
      EPHOR_TOKEN: TOKEN,
    });

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`cannot reach the collector at ${url}`);
  });

  it("exits 2 when the collector rejects the token", async () => {
    const collector = await collectorOf(stateOf());
    cleanups.push(collector.close);

    const run = await ephor(["status", "--json"], {
      EPHOR_API_URL: collector.url,
      EPHOR_TOKEN: "wrong",
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/rejected the token/);
  });
});

describe("ephor", () => {
  it("explains itself on --help, exit 0, for the program and for a command", async () => {
    const program = await ephor(["--help"]);
    const command = await ephor(["status", "--help"]);

    expect(program.code).toBe(0);
    expect(program.stdout).toMatch(/status/);
    expect(command.code).toBe(0);
    expect(command.stdout).toMatch(/--json/);
  });

  it("tells its version, exit 0", async () => {
    const run = await ephor(["--version"]);

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  // Commander's own refusals exit 1 by default, a code the contract does not
  // use: a refusal is a tool error like any other, 2. With a token in the
  // environment, the refusal can only be Commander's.
  it("exits 2 on a command or option it does not have, saying which", async () => {
    const command = await ephor(["frobnicate"], { EPHOR_TOKEN: TOKEN });
    const option = await ephor(["status", "--nope"], { EPHOR_TOKEN: TOKEN });

    expect(command.code).toBe(2);
    expect(command.stderr).toMatch(/unknown command 'frobnicate'/);
    expect(option.code).toBe(2);
    expect(option.stderr).toMatch(/unknown option '--nope'/);
    expect(command.stdout + option.stdout).toBe("");
  });

  it("exits 2 with the usage when given nothing to do", async () => {
    const run = await ephor([], { EPHOR_TOKEN: TOKEN });

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/Usage: ephor/);
  });
});

describe("ephor watch", () => {
  it("exits 2 when stdout is not a terminal, and names status instead", async () => {
    const run = await ephor(["watch"], {
      EPHOR_API_URL: "http://127.0.0.1:1",
      EPHOR_TOKEN: TOKEN,
    });

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("ephor status");
  });

  it("exits 2 on a --notify-on it does not know, listing the levels", async () => {
    const run = await ephor(["watch", "--notify-on", "loud"], {
      EPHOR_TOKEN: TOKEN,
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      '--notify-on must be one of warn, critical, got "loud"',
    );
  });

  it.each(["0.5", "0", "86401"])(
    "exits 2 on --interval %s, saying what it takes",
    async (interval) => {
      const run = await ephor(["watch", "--interval", interval], {
        EPHOR_TOKEN: TOKEN,
      });

      expect(run.code).toBe(2);
      expect(run.stderr).toContain("--interval must be whole seconds");
    },
  );
});

describe("ephor with a reader that stops early", () => {
  // The pipe holds 64 KB and the first read takes 64 KB more: an answer
  // under 128 KB can be written in full before the reader leaves, and no
  // EPIPE ever happens. 2000 nodes without metrics are ~400 KB.
  it("exits 0 and says nothing when the pipe closes under a big answer", async () => {
    const fleet = Array.from({ length: 2000 }, (_, index) => ({
      name: `node-${index}`,
      status: "ok" as const,
    }));
    const state = stateOf(...fleet);
    expect(JSON.stringify(state, null, 2).length).toBeGreaterThan(256 * 1024);
    const collector = await collectorOf(state);
    cleanups.push(collector.close);

    const child = spawn(process.execPath, [BINARY, "status", "--json"], {
      env: { EPHOR_API_URL: collector.url, EPHOR_TOKEN: TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    // `head -c 1`: one chunk read, then the reading end is closed.
    child.stdout.once("data", () => child.stdout.destroy());

    const code = await new Promise<number | null>((resolve) =>
      child.on("close", resolve),
    );

    expect(code).toBe(0);
    expect(Buffer.concat(stderr).toString()).toBe("");
  });
});

describe("ephor ack", () => {
  const acknowledgement: Acknowledgement = {
    node: "achilles",
    note: "ports are firewalled",
    since: 1_800_000_000,
    until: 1_800_000_000 + 3 * 86_400,
    status: "warn",
    untilOk: false,
  };

  async function ackWith(
    words: string[],
    behaviour: Parameters<typeof collectorOf>[1],
  ) {
    const collector = await collectorOf(stateOf(), behaviour);
    cleanups.push(collector.close);
    const run = await ephor(["ack", ...words], {
      EPHOR_API_URL: collector.url,
      EPHOR_TOKEN: TOKEN,
    });

    return { run, requests: collector.requests };
  }

  it("sends the note, the end in seconds, and the kind; says what was stored", async () => {
    const { run, requests } = await ackWith(
      ["achilles", "--note", "ports are firewalled", "--for", "3d"],
      { acknowledge: { acknowledgement } },
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toBe(
      "acknowledged achilles (warn) until its status changes, 3d at most: " +
        "ports are firewalled\n",
    );
    expect(run.stderr).toBe("");
    expect(requests.map((request) => request.method)).toEqual(["PUT"]);
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      note: "ports are firewalled",
      duration: 3 * 86_400,
    });
  });

  it("asks for the sticky kind with --until-ok, and says so", async () => {
    const sticky: Acknowledgement = {
      node: "achilles",
      since: 1,
      status: "critical",
      untilOk: true,
    };
    const { run, requests } = await ackWith(["achilles", "--until-ok"], {
      acknowledge: { acknowledgement: sticky },
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe(
      "acknowledged achilles (critical) until it is ok\n",
    );
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ untilOk: true });
  });

  it("prints an end that is not a whole unit as it is", async () => {
    const { run } = await ackWith(["achilles", "--for", "90m"], {
      acknowledge: {
        acknowledgement: { ...acknowledgement, until: 1_800_000_000 + 5400 },
      },
    });

    expect(run.stdout).toContain(", 1h 30m at most:");
  });

  it("prints the collector's answer with --json", async () => {
    const { run } = await ackWith(["achilles", "--json"], {
      acknowledge: { acknowledgement },
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ acknowledgement });
  });

  it("clears one, and says which", async () => {
    const { run, requests } = await ackWith(["achilles", "--clear"], {
      unacknowledge: { acknowledgement },
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe(
      "cleared the acknowledgement of achilles (warn): ports are firewalled\n",
    );
    expect(requests.map((request) => request.method)).toEqual(["DELETE"]);
  });

  // The goal of --clear is "none left": already met is not a failure.
  it("exits 0 clearing a node that had none", async () => {
    const { run } = await ackWith(["achilles", "--clear"], {
      unacknowledge: { acknowledgement: null },
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("achilles had no acknowledgement\n");
  });

  it("exits 2 with the collector's words for an unknown node or an ok one", async () => {
    for (const [words, behaviour, error] of [
      [
        ["hector"],
        { acknowledge: { status: 404, error: 'unknown node "hector"' } },
        'unknown node "hector"',
      ],
      [
        ["hector", "--clear"],
        { unacknowledge: { status: 404, error: 'unknown node "hector"' } },
        'unknown node "hector"',
      ],
      [
        ["achilles"],
        {
          acknowledge: {
            status: 409,
            error: "achilles is ok: nothing to acknowledge",
          },
        },
        "achilles is ok: nothing to acknowledge",
      ],
    ] as const) {
      const { run } = await ackWith([...words], behaviour);

      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain(error);
    }
  });

  it("refuses a bad flag before asking the collector, naming the flag", async () => {
    for (const [words, message] of [
      [["--for", "3dd"], /--for: Expected 30, 30s/],
      [["--for", "0"], /--for: duration must be between/],
      [["--note", "two\nlines"], /--note: note must be one line/],
      [["--clear", "--until-ok"], /--clear removes the acknowledgement/],
    ] as const) {
      const { run, requests } = await ackWith(["achilles", ...words], {});

      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(message);
      expect(requests).toEqual([]);
    }
  });
});
