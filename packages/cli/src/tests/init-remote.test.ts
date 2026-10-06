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

  it("points at moving a config here, and keeps it", async () => {
    const { here, environment } = setup({
      apiPort: await nobodyServing(),
    });
    writeFileSync(join(here, "config.yaml"), "nodes: [mine]\n");

    const run = await ephor(["init", "--remote", "bastion"], environment);

    expect(run.stdout).toContain(
      `scp ${join(here, "config.yaml")} bastion:.config/ephor/config.yaml`,
    );
    expect(readFileSync(join(here, "config.yaml"), "utf8")).toBe(
      "nodes: [mine]\n",
    );
  });

  // A unit's EPHOR_CONFIG is not in ssh's environment: it is passed, and
  // quoted for the remote shell, an apostrophe in the path included.
  it("asks the remote's own config, when its serve runs with another", async () => {
    const { here, environment } = setup({ apiPort: 1, token: false });
    const etc = directory("ephor-it's-etc-");
    writeFileSync(join(etc, "token"), "etc-token\n", { mode: 0o600 });

    const run = await ephor(
      [
        "init",
        "--remote",
        "bastion",
        "--remote-config",
        join(etc, "config.yaml"),
      ],
      environment,
    );

    expect(run.code).toBe(0);
    expect(parse(readFileSync(join(here, "cli.yaml"), "utf8"))).toMatchObject({
      remote: "bastion",
      token: "etc-token",
    });
  });

  it.each([
    [
      "no ephor there",
      { withEphor: false },
      "ephor or node is not on bastion's PATH for commands run over ssh (",
    ],
    ["no token there", { token: false }, "on bastion: no API token here"],
  ])("exits 2 with %s, and writes nothing", async (_name, options, message) => {
    const { here, environment } = setup({ apiPort: 1, ...options });

    const run = await ephor(["init", "--remote", "bastion"], environment);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(() => statSync(join(here, "cli.yaml"))).toThrow();
  });

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
  it("prints the token and the API port this machine's serve uses", async () => {
    const there = directory("ephor-there-");
    writeFileSync(join(there, "config.yaml"), "api:\n  port: 41556\n");
    writeFileSync(join(there, "token"), `${TOKEN}\n`, { mode: 0o600 });

    const run = await ephor(["api-access"], {
      EPHOR_CONFIG: join(there, "config.yaml"),
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ token: TOKEN, apiPort: 41556 });
  });

  it("says to run init when there is no token", async () => {
    const run = await ephor([
      "api-access",
      "--config",
      "/nonexistent/config.yaml",
    ]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Run `ephor init` here first");
  });
});
