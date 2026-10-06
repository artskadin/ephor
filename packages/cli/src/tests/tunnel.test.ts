import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "../exit-code";
import { openTunnel, type Tunnel } from "../tunnel";
import { fakeSshDirectory, fakeSshRunning } from "./fake-ssh";
import { closed } from "./test-server";

const FAKE = fakeSshDirectory();
const SSH = join(FAKE, "ssh");

const sshRunning = () => fakeSshRunning(FAKE);
const tunnels: Tunnel[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const tunnel of tunnels.splice(0)) tunnel.close();
  for (const server of servers.splice(0)) await closed(server);
});

/** The "remote" API: a server on this machine answering one line. */
async function remoteApi(): Promise<number> {
  const server = createServer((_request, response) => response.end("pong"));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("openTunnel", () => {
  it("reaches the remote port through a local one, until closed", async () => {
    const tunnel = await openTunnel({
      remote: "bastion",
      remotePort: await remoteApi(),
      command: SSH,
    });
    tunnels.push(tunnel);

    expect(tunnel.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(tunnel.isOpen()).toBe(true);
    await expect((await fetch(tunnel.url)).text()).resolves.toBe("pong");

    tunnel.close();
    await expect.poll(() => tunnel.isOpen()).toBe(false);
    await expect(fetch(tunnel.url)).rejects.toThrow();
    await expect.poll(sshRunning).toBe(0);
  });

  it("says ssh's own words when it cannot connect", async () => {
    const failure = await openTunnel({
      remote: "unreachable.test",
      remotePort: 31556,
      command: SSH,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageError);
    expect((failure as Error).message).toBe(
      "cannot reach unreachable.test over ssh: ssh: Could not resolve hostname unreachable.test: Name or service not known",
    );
  });

  it("gives up on a tunnel that never comes up, and stops ssh", async () => {
    const failure = await openTunnel({
      remote: "silent.test",
      remotePort: 31556,
      command: SSH,
      timeoutMs: 300,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageError);
    expect((failure as Error).message).toBe(
      "cannot reach silent.test over ssh: no tunnel within 0.3 s",
    );
    await expect.poll(sshRunning).toBe(0);
  });

  it("says when there is no ssh at all", async () => {
    const failure = await openTunnel({
      remote: "bastion",
      remotePort: 31556,
      command: "/nonexistent/ssh",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageError);
    expect((failure as Error).message).toBe(
      "cannot run ssh to reach bastion: spawn /nonexistent/ssh ENOENT",
    );
  });
});
