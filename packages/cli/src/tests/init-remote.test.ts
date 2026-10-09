import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { fakeEphorDirectory, fakeSshDirectory } from "./fake-ssh";
import { BINARY, ephor } from "./run-binary";
import { collectorOf, stateOf, TOKEN } from "./test-server";

const fakeSsh = fakeSshDirectory();
const fakeEphor = fakeEphorDirectory(BINARY);
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

/**
 * Here and "there": two config directories; ssh runs the remote's
 * commands on this machine, with `ephor` on its PATH unless left out.
 */
function setup(options: {
  apiPort: number;
  withEphor?: boolean;
  token?: boolean;
}) {
  const here = directory("ephor-here-");
  const there = directory("ephor-there-");
  writeFileSync(
    join(there, "config.yaml"),
    `api:\n  port: ${options.apiPort}\n`,
  );
  if (options.token ?? true) {
    writeFileSync(join(there, "token"), `${TOKEN}\n`, { mode: 0o600 });
  }

  const environment = {
    EPHOR_CONFIG: join(here, "config.yaml"),
    FAKE_REMOTE_CONFIG: join(there, "config.yaml"),
    PATH: [
      fakeSsh,
      ...(options.withEphor === false ? [] : [fakeEphor]),
      "/usr/bin",
      "/bin",
    ].join(":"),
  };

  return { here, there, environment };
}

const portOf = (url: string) => Number(new URL(url).port);

/**
 * A port held for the test whose every connection is reset: what a
 * tunnel gives with nothing serving there. Held, so no other test's
 * server lands on it, as one could on a port merely found free.
 */
async function nobodyServing(): Promise<number> {
  const server = createServer((socket) => socket.resetAndDestroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return (server.address() as AddressInfo).port;
}

describe("ephor init --remote", () => {
  it("writes cli.yaml with the remote's token, and says nobody serves yet", async () => {
    const nobody = await nobodyServing();
    const { here, environment } = setup({ apiPort: nobody });

    const run = await ephor(["init", "--remote", "bastion"], environment);

    expect(run.code).toBe(0);
    const path = join(here, "cli.yaml");
    expect(parse(readFileSync(path, "utf8"))).toEqual({
      remote: "bastion",
      token: TOKEN,
      apiPort: nobody,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(run.stdout).toContain(
      `created ${path}: commands here now ask the collector on bastion`,
    );
    expect(run.stdout).toContain("no `ephor serve` on bastion yet");
    expect(run.stdout).not.toContain(TOKEN);
  });

  it("says when the collector there answers, and status then goes through it", async () => {
    const state = stateOf({ name: "achilles", status: "ok" });
    const collector = await collectorOf(state);
    cleanups.push(collector.close);
    const { environment } = setup({ apiPort: portOf(collector.url) });

    const init = await ephor(["init", "--remote", "bastion"], environment);
    const status = await ephor(["status", "--json"], environment);

    expect(init.stdout).toContain("the collector on bastion answers: 1 nodes");
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(state);
  });

  // The API on its default port there: cli.yaml leaves the port out.
  it("leaves the default port out, and reads past a login banner", async () => {
    const { here, there, environment } = setup({ apiPort: 1 });
    writeFileSync(join(there, "config.yaml"), "nodes: []\n");

    const run = await ephor(["init", "--remote", "bastion"], {
      ...environment,
      FAKE_REMOTE_BANNER: "Welcome to bastion! nvm loaded",
    });

    expect(run.code).toBe(0);
    expect(parse(readFileSync(join(here, "cli.yaml"), "utf8"))).toEqual({
      remote: "bastion",
      token: TOKEN,
    });
  });

  // The nodes go where serve runs; the template there had none to lose.
  it("copies the config here there when the one there lists no nodes", async () => {
    const { here, there, environment } = setup({
      apiPort: await nobodyServing(),
    });
    const template = readFileSync(join(there, "config.yaml"), "utf8");
    const mine = "nodes:\n  - name: mine\n    host: 203.0.113.10\n";
    writeFileSync(join(here, "config.yaml"), mine);

    const run = await ephor(["init", "--remote", "bastion"], environment);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      `copied ${join(here, "config.yaml")} to bastion:${join(there, "config.yaml")}, 1 node`,
    );
    expect(readFileSync(join(there, "config.yaml"), "utf8")).toBe(mine);
    expect(readFileSync(join(there, "config.yaml.bak"), "utf8")).toBe(template);
    expect(readFileSync(join(here, "config.yaml"), "utf8")).toBe(mine);

    const again = await ephor(["init", "--remote", "bastion"], environment);

    expect(again.stdout).toContain(
      `kept bastion:${join(there, "config.yaml")}: the same as ${join(here, "config.yaml")} here`,
    );
    expect(again.stdout).not.toContain("scp");
  });

  // Not YAML there: it may list nodes, so it is no template to replace.
  it("copies nothing over a config there that is not YAML", async () => {
    const { here, there, environment } = setup({
      apiPort: await nobodyServing(),
    });
    const broken = "api:\n\tport: 1\nnodes:\n  - name: theirs\n";
    writeFileSync(join(there, "config.yaml"), broken);
    writeFileSync(
      join(here, "config.yaml"),
      "nodes:\n  - name: mine\n    host: 203.0.113.10\n",
    );

    const run = await ephor(["init", "--remote", "bastion"], environment);

    expect(run.stdout).toContain("it is not YAML");
    expect(readFileSync(join(there, "config.yaml"), "utf8")).toBe(broken);
  });

  it("says so when the config here is not YAML", async () => {
    const { here, environment } = setup({ apiPort: await nobodyServing() });
    writeFileSync(join(here, "config.yaml"), "nodes:\n\t- name: mine\n");

    const run = await ephor(["init", "--remote", "bastion"], environment);

    expect(run.stdout).toContain(
      `${join(here, "config.yaml")} here is not YAML: nothing copied to bastion`,
    );
  });

  it("keeps both configs when each lists nodes, saying how to replace", async () => {
    const { here, there, environment } = setup({
      apiPort: await nobodyServing(),
    });
    const theirs = `${readFileSync(join(there, "config.yaml"), "utf8")}nodes:\n  - name: theirs\n    host: 203.0.113.11\n`;
    writeFileSync(join(there, "config.yaml"), theirs);
    writeFileSync(
      join(here, "config.yaml"),
      "nodes:\n  - name: mine\n    host: 203.0.113.10\n",
    );

    const run = await ephor(["init", "--remote", "bastion"], environment);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      `kept bastion:${join(there, "config.yaml")}: it lists 1 node`,
    );
    expect(run.stdout).toContain(
      `scp ${join(here, "config.yaml")} bastion:${join(there, "config.yaml")}`,
    );
    expect(readFileSync(join(there, "config.yaml"), "utf8")).toBe(theirs);
  });

  it.each([
    [
      "no ephor there",
      { withEphor: false },
      "ephor or node is not on bastion's PATH for commands run over ssh (",
    ],
  ])(
    "exits 2 with %s, and writes nothing",
    async (_name, options, ...messages) => {
      const { here, environment } = setup({ apiPort: 1, ...options });

      const run = await ephor(["init", "--remote", "bastion"], environment);

      expect(run.code).toBe(2);
      for (const message of messages) expect(run.stderr).toContain(message);
      expect(() => statSync(join(here, "cli.yaml"))).toThrow();
    },
  );

  it("exits 2 when ssh cannot reach the host", async () => {
    const { environment } = setup({ apiPort: 1 });

    const run = await ephor(
      ["init", "--remote", "unreachable.test"],
      environment,
    );

    expect(run.code).toBe(2);
    expect(run.stderr).toBe(
      "cannot reach unreachable.test over ssh: ssh: Could not resolve hostname unreachable.test: Name or service not known\n",
    );
  });

  it("makes the token there when it has none and nothing serves there", async () => {
    const nobody = await nobodyServing();
    const { here, there, environment } = setup({
      apiPort: nobody,
      token: false,
    });

    const run = await ephor(["init", "--remote", "bastion"], environment);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`bastion: created ${join(there, "token")}`);
    expect(run.stdout).toContain(
      `bastion: kept ${join(there, "config.yaml")}: already there`,
    );
    expect(run.stdout).not.toContain("next:");
    const token = readFileSync(join(there, "token"), "utf8").trim();
    expect(parse(readFileSync(join(here, "cli.yaml"), "utf8"))).toEqual({
      remote: "bastion",
      token,
      apiPort: nobody,
    });
  });

  // A unit's EPHOR_CONFIG is not in ssh's environment: a second config
  // and token at the default path would part the two silently.
  it("makes nothing when a serve there answers without a token found", async () => {
    const collector = await collectorOf(stateOf());
    cleanups.push(collector.close);
    const { here, there, environment } = setup({
      apiPort: portOf(collector.url),
      token: false,
    });

    const run = await ephor(["init", "--remote", "bastion"], environment);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      `answers on its port ${portOf(collector.url)}: it runs with another config`,
    );
    expect(run.stderr).toContain(
      "export EPHOR_CONFIG=<its path> on the first line of ~/.bashrc there",
    );
    expect(() => statSync(join(there, "token"))).toThrow();
    expect(() => statSync(join(here, "cli.yaml"))).toThrow();
  });

  // Run again, it goes on: nothing there or here is made twice.
  it("keeps what is done when run again", async () => {
    const { here, there, environment } = setup({
      apiPort: await nobodyServing(),
    });
    const config = readFileSync(join(there, "config.yaml"), "utf8");

    await ephor(["init", "--remote", "bastion"], environment);
    const second = await ephor(["init", "--remote", "bastion"], environment);

    expect(second.code).toBe(0);
    expect(second.stdout).toContain(
      `bastion: kept ${join(there, "config.yaml")}: already there`,
    );
    expect(second.stdout).toContain(
      `kept ${join(here, "cli.yaml")}: it already points here at bastion`,
    );
    expect(readFileSync(join(there, "config.yaml"), "utf8")).toBe(config);
  });

  it("rewrites a cli.yaml for the same remote with the token there now", async () => {
    const { here, environment } = setup({ apiPort: await nobodyServing() });
    writeFileSync(join(here, "cli.yaml"), "remote: bastion\ntoken: old\n", {
      mode: 0o644,
    });

    const run = await ephor(["init", "--remote", "bastion"], environment);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`updated ${join(here, "cli.yaml")}`);
    expect(run.stdout).toContain("now readable by you only");
    expect(parse(readFileSync(join(here, "cli.yaml"), "utf8"))).toMatchObject({
      token: TOKEN,
    });
    expect(statSync(join(here, "cli.yaml")).mode & 0o777).toBe(0o600);
  });

  it("says to remove a cli.yaml it cannot read", async () => {
    const { here, environment } = setup({ apiPort: 1 });
    writeFileSync(join(here, "cli.yaml"), "remote: [\n", { mode: 0o600 });

    const run = await ephor(["init", "--remote", "bastion"], environment);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("is not YAML");
    expect(run.stderr).toContain("remove it and run this again");
  });

  it("refuses to repoint a cli.yaml already there", async () => {
    const { here, environment } = setup({ apiPort: 1 });
    writeFileSync(join(here, "cli.yaml"), "remote: old\ntoken: x\n", {
      mode: 0o600,
    });

    const run = await ephor(["init", "--remote", "bastion"], environment);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      "already names old: remove it to point at bastion",
    );
  });
});

describe("ephor api-access", () => {
  it("prints the token, API port and config this machine's serve uses", async () => {
    const there = directory("ephor-there-");
    writeFileSync(join(there, "config.yaml"), "api:\n  port: 41556\n");
    writeFileSync(join(there, "token"), `${TOKEN}\n`, { mode: 0o600 });

    const run = await ephor(["api-access"], {
      EPHOR_CONFIG: join(there, "config.yaml"),
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      token: TOKEN,
      apiPort: 41556,
      configPath: join(there, "config.yaml"),
      nodes: 0,
      configHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("says there is no token yet, with the port and config it would use", async () => {
    const run = await ephor([
      "api-access",
      "--config",
      "/nonexistent/config.yaml",
    ]);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      token: null,
      apiPort: 31556,
      configPath: "/nonexistent/config.yaml",
      nodes: 0,
      configHash: null,
    });
  });
});
