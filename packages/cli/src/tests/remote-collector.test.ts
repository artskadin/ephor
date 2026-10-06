import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../api-client";
import { RemoteCollector } from "../remote-collector";
import type { Tunnel } from "../tunnel";
import { closedPortUrl, collectorOf, stateOf, TOKEN } from "./test-server";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Tunnels whose local end is `url`; `isOpen` as the test sets it. */
function tunnelsTo(url: string) {
  const opened: { open: boolean }[] = [];
  const open = async (): Promise<Tunnel> => {
    const state = { open: true };
    opened.push(state);
    return {
      url,
      isOpen: () => state.open,
      close: () => {
        state.open = false;
      },
    };
  };

  return { open, opened };
}

function remoteOf(open: () => Promise<Tunnel>, token = TOKEN) {
  const collector = new RemoteCollector({
    remote: "bastion",
    remotePort: 31556,
    token,
    tokenSource: "/home/me/.config/ephor/cli.yaml",
    open,
  });
  cleanups.push(() => collector.close());
  return collector;
}

describe("RemoteCollector", () => {
  it("names itself by the remote, never as a loopback address", () => {
    expect(remoteOf(tunnelsTo("http://127.0.0.1:1").open).apiUrl).toBe(
      "ssh://bastion",
    );
  });

  it("asks through one tunnel, and opens another once it has died", async () => {
    const state = stateOf({ name: "achilles", status: "ok" });
    const collector = await collectorOf(state);
    cleanups.push(collector.close);
    const tunnels = tunnelsTo(collector.url);
    const remote = remoteOf(tunnels.open);

    await expect(remote.state()).resolves.toEqual(state);
    await expect(remote.state()).resolves.toEqual(state);
    expect(tunnels.opened).toHaveLength(1);

    // ssh died: a dropped link under `watch`.
    (tunnels.opened[0] as { open: boolean }).open = false;
    await expect(remote.state()).resolves.toEqual(state);
    expect(tunnels.opened).toHaveLength(2);
  });

  it("names the remote and the token's file when the token is rejected", async () => {
    const collector = await collectorOf(stateOf());
    cleanups.push(collector.close);

    const failure = await remoteOf(tunnelsTo(collector.url).open, "wrong")
      .state()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toBe(
      "the collector on bastion rejected the token in /home/me/.config/ephor/cli.yaml: it must be the one `ephor serve` there runs with",
    );
  });

  // Measured through real ssh: nothing listening there is a reset here.
  it("reads a reset through the tunnel as no ephor serve there", async () => {
    const resetting: Server = createServer((socket) =>
      socket.resetAndDestroy(),
    );
    await new Promise<void>((resolve) =>
      resetting.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(
      () => new Promise<void>((resolve) => resetting.close(() => resolve())),
    );
    const address = resetting.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const failure = await remoteOf(tunnelsTo(`http://127.0.0.1:${port}`).open)
      .state()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).failure).toBe("refused");
    expect((failure as ApiError).message).toBe(
      "no `ephor serve` on bastion: ssh connected, but nothing answers on port 31556 there",
    );
  });

  // Not "no serve there": `check` must not run it there a second time.
  it("reads a refusal at the tunnel's own end as the ssh link gone, once more on a new one", async () => {
    const tunnels = tunnelsTo(await closedPortUrl());

    const failure = await remoteOf(tunnels.open)
      .state()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).failure).toBe("link-closed");
    expect((failure as ApiError).message).toBe(
      "the ssh link to bastion closed",
    );
    expect(tunnels.opened.map((tunnel) => tunnel.open)).toEqual([false, true]);
  });

  it("asks again through a new tunnel when ssh died unnoticed", async () => {
    const state = stateOf({ name: "achilles", status: "ok" });
    const collector = await collectorOf(state);
    cleanups.push(collector.close);
    const dead = tunnelsTo(await closedPortUrl());
    const live = tunnelsTo(collector.url);
    let opens = 0;

    // The first still reads open: its exit has not been seen yet.
    const remote = remoteOf(() => (opens++ === 0 ? dead.open() : live.open()));

    await expect(remote.state()).resolves.toEqual(state);
    expect(dead.opened.map((tunnel) => tunnel.open)).toEqual([false]);
  });
});
