import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Acknowledgement, CheckResponse } from "@ephorate/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  fakeEphorDirectory,
  fakeSshDirectory,
  fakeSshRunning,
} from "./fake-ssh";
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

  // The table puts the worst first; JSON is the data as the collector sent it.
  it("sorts the table worst first and leaves the JSON in the collector's order", async () => {
    const state = stateOf(
      { name: "achilles", status: "ok" },
      { name: "german", status: "critical" },
      { name: "antilochus", status: "warn" },
    );
    const collector = await collectorOf(state);
    cleanups.push(collector.close);
    const environment = { EPHOR_API_URL: collector.url, EPHOR_TOKEN: TOKEN };

    const table = await ephor(["status"], environment);
    const json = await ephor(["status", "--json"], environment);

    const names = table.stdout
      .split("\n")
      .filter((line, index) => index > 0 && /^\S/.test(line))
      .map((line) => line.replace(/^! /, "").split(" ")[0]);
    expect(names).toEqual(["german", "antilochus", "achilles"]);
    expect(
      (JSON.parse(json.stdout) as typeof state).nodes.map((node) => node.node),
    ).toEqual(["achilles", "german", "antilochus"]);
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

  // On the machine `ephor serve` runs on: the token file beside its config.
  it("reads the token from the file beside the config, warning when it is open", async () => {
    const collector = await collectorOf(stateOf());
    cleanups.push(collector.close);
    const directory = mkdtempSync(join(tmpdir(), "ephor-status-"));
    cleanups.push(async () => rmSync(directory, { recursive: true }));
    writeFileSync(join(directory, "token"), `${TOKEN}\n`, { mode: 0o600 });
    const environment = {
      EPHOR_API_URL: collector.url,
      EPHOR_CONFIG: join(directory, "config.yaml"),
    };

    const closed = await ephor(["status", "--json"], environment);
    expect(closed.code).toBe(0);
    expect(closed.stderr).toBe("");

    chmodSync(join(directory, "token"), 0o644);
    const open = await ephor(["status", "--json"], environment);
    expect(open.code).toBe(0);
    expect(open.stderr).toBe(
      `warning: ${join(directory, "token")} is readable by others (mode 644): ` +
        `chmod 600 ${join(directory, "token")}\n`,
    );
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

describe("ephor with a cli.yaml naming a remote collector", () => {
  const fakeSsh = fakeSshDirectory();

  /** A config directory whose cli.yaml points the client through ssh. */
  function remoteSetup(apiPort: number): Record<string, string> {
    const directory = mkdtempSync(join(tmpdir(), "ephor-remote-"));
    cleanups.push(async () => rmSync(directory, { recursive: true }));
    writeFileSync(
      join(directory, "cli.yaml"),
      `remote: bastion\ntoken: ${TOKEN}\napiPort: ${apiPort}\n`,
      { mode: 0o600 },
    );

    return {
      EPHOR_CONFIG: join(directory, "config.yaml"),
      PATH: `${fakeSsh}:/usr/bin:/bin`,
    };
  }

  it("asks the collector through the tunnel, and leaves no ssh behind", async () => {
    const state = stateOf({ name: "achilles", status: "warn" });
    const collector = await collectorOf(state);
    cleanups.push(collector.close);

    const run = await ephor(
      ["status", "--json"],
      remoteSetup(Number(new URL(collector.url).port)),
    );

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(state);
    expect(collector.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fakeSshRunning(fakeSsh)).toBe(0);
  });

  // Why `cat` there and not -N: killed outright, ephor runs no cleanup,
  // and only the end of ssh's stdin, which the kernel gives, ends ssh.
  it("leaves no ssh behind even when killed with SIGKILL mid-request", async () => {
    // Takes the request and never answers: ephor waits on it.
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) =>
      silent.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(async () => {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    });
    const port = (silent.address() as { port: number }).port;

    const child = spawn(process.execPath, [BINARY, "status", "--json"], {
      env: remoteSetup(port),
      stdio: "ignore",
    });
    await expect.poll(() => fakeSshRunning(fakeSsh), { timeout: 5000 }).toBe(1);

    child.kill("SIGKILL");
    await expect.poll(() => fakeSshRunning(fakeSsh), { timeout: 5000 }).toBe(0);
  });
});

// Never probe from here for a remote collector: other keys, other route.
describe("ephor check with nothing serving on the remote", () => {
  const fakeSsh = fakeSshDirectory();
  const fakeEphor = fakeEphorDirectory(BINARY);

  /**
   * cli.yaml names a remote whose API port nobody serves; ssh runs the
   * remote's commands here, its config "there". No token there: its own
   * check must not ask a daemon this machine may be running.
   */
  async function setup(options: { withEphor?: boolean } = {}) {
    const here = mkdtempSync(join(tmpdir(), "ephor-here-"));
    const there = mkdtempSync(join(tmpdir(), "ephor-there-"));
    cleanups.push(async () => {
      rmSync(here, { recursive: true });
      rmSync(there, { recursive: true });
    });
    const nobody = Number(new URL(await closedPortUrl()).port);
    writeFileSync(
      join(here, "cli.yaml"),
      `remote: bastion\ntoken: ${TOKEN}\napiPort: ${nobody}\n`,
      { mode: 0o600 },
    );
    // Its node's ssh fails at once: nothing leaves the machine.
    writeFileSync(
      join(there, "config.yaml"),
      [
        "nodes:",
        "  - name: achilles",
        "    host: 203.0.113.10",
        "    ssh: unreachable.test",
        "probes:",
        "  reachability: { enabled: false }",
        "  system: { retries: 0, timeout: 2s }",
        "",
      ].join("\n"),
    );

    return {
      EPHOR_CONFIG: join(here, "config.yaml"),
      FAKE_REMOTE_CONFIG: join(there, "config.yaml"),
      PATH: [
        fakeSsh,
        ...(options.withEphor === false ? [] : [fakeEphor]),
        "/usr/bin",
        "/bin",
      ].join(":"),
    };
  }

  it("runs it there over ssh, saying so, and prints its answer", async () => {
    const run = await ephor(["check", "--json"], await setup());

    expect(run.code).toBe(0);
    expect(run.stderr).toContain(
      "no `ephor serve` on bastion: ran once there over ssh, nothing recorded",
    );
    expect(run.stderr).toContain("bastion: checking every node: every probe");
    const response = JSON.parse(run.stdout) as CheckResponse;
    expect(response).toMatchObject({ complete: true, pending: [] });
    expect(response.nodes.map((node) => node.node)).toEqual(["achilles"]);
    expect(response.nodes[0]?.reasons.join("\n")).toContain(
      "Could not resolve hostname unreachable.test",
    );
  });

  it("draws the table here from the answer, past a login banner", async () => {
    const run = await ephor(["check", "achilles", "--probe", "system"], {
      ...(await setup()),
      FAKE_REMOTE_BANNER: "Welcome to bastion! nvm loaded",
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^NODE\s+LOAD/);
    expect(run.stdout).toContain("! achilles");
    expect(run.stdout).not.toContain("Welcome");
  });

  // The name reaches the remote shell intact, quote and dash included.
  it("exits 2 with the remote's own words for a node it does not have", async () => {
    const run = await ephor(["check", "--", "-hec'tor"], await setup());

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`bastion: unknown node "-hec'tor"`);
    expect(run.stderr).toContain("`ephor check` on bastion exited 2");
  });

  it("exits 2 saying where PATH goes when ephor is not on it there", async () => {
    const run = await ephor(["check"], await setup({ withEphor: false }));

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      "ephor or node is not on bastion's PATH for commands run over ssh",
    );
  });
});

describe("ephor init", () => {
  // Step 0 as the docs will tell it: init, then check says what is missing.
  it("writes the config and the token, then check asks for nodes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ephor-init-"));
    cleanups.push(async () => rmSync(directory, { recursive: true }));
    const config = join(directory, "config.yaml");

    const first = await ephor(["init", "--config", config]);
    const again = await ephor(["init", "--config", config]);
    const check = await ephor(["check", "--config", config]);

    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`created ${config}`);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`kept ${config}: already there`);
    expect(check.code).toBe(2);
    expect(check.stderr).toContain(
      "at least one node: list yours under `nodes:`",
    );
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
