import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "../api-client";
import {
  closed,
  closedPortUrl,
  collectorOf,
  NOW,
  stateOf,
  TOKEN,
} from "./test-server";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A server answering every request the same way, closed after the test. */
async function serverAnswering(
  status: number,
  body: string,
  contentType = "application/json",
): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": contentType });
    response.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => closed(server));

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A server that takes the connection and then does as told, closed after the test. */
async function serverDoing(
  handle: (response: ServerResponse) => void,
): Promise<string> {
  const server = createServer((_request, response) => handle(response));

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => closed(server));

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function failureOf(client: ApiClient): Promise<ApiError> {
  try {
    await client.state();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }

  throw new Error("the client answered instead of failing");
}

describe("ApiClient.state", () => {
  it("sends the bearer token and hands back the state as the collector sent it", async () => {
    const state = stateOf({ name: "achilles", status: "ok" });
    const collector = await collectorOf(state);
    cleanups.push(collector.close);

    const client = new ApiClient({ apiUrl: collector.url, token: TOKEN });

    await expect(client.state()).resolves.toEqual(state);
    expect(collector.requests.map((request) => request.url)).toEqual([
      "/api/state",
    ]);
    expect(collector.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("posts a check and hands back the daemon's result", async () => {
    const state = stateOf({ name: "achilles", status: "ok" });
    const check = { ...state, startedAt: NOW - 5, complete: true, pending: [] };
    const collector = await collectorOf(state, { check });
    cleanups.push(collector.close);

    const client = new ApiClient({ apiUrl: collector.url, token: TOKEN });

    await expect(client.check({ node: "achilles" })).resolves.toEqual(check);
    expect(collector.requests).toMatchObject([
      { method: "POST", url: "/api/check", body: '{"node":"achilles"}' },
    ]);
  });

  it("passes on the daemon's own words for a node or probe it refuses", async () => {
    const collector = await collectorOf(stateOf(), {
      check: { status: 404, error: 'unknown node "hector"' },
    });
    cleanups.push(collector.close);

    const client = new ApiClient({ apiUrl: collector.url, token: TOKEN });
    const failure = await client
      .check({ node: "hector" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).failure).toBe("rejected");
    expect((failure as ApiError).message).toContain('unknown node "hector"');
  });

  it("says whose token it needs when the collector rejects it", async () => {
    const collector = await collectorOf(stateOf());
    cleanups.push(collector.close);

    const failure = await failureOf(
      new ApiClient({ apiUrl: collector.url, token: "wrong" }),
    );

    expect(failure.failure).toBe("unauthorized");
    expect(failure.message).toMatch(/rejected the token.*EPHOR_TOKEN/);
  });

  it("quotes the collector's own reason for a refusal", async () => {
    const url = await serverAnswering(
      500,
      JSON.stringify({ error: "internal error" }),
    );

    const failure = await failureOf(
      new ApiClient({ apiUrl: url, token: TOKEN }),
    );

    expect(failure.failure).toBe("rejected");
    expect(failure.message).toMatch(/answered 500: internal error/);
  });

  it("says when a refusal came with no reason", async () => {
    const url = await serverAnswering(
      502,
      "<html>bad gateway</html>",
      "text/html",
    );

    const failure = await failureOf(
      new ApiClient({ apiUrl: url, token: TOKEN }),
    );

    expect(failure.message).toMatch(/answered 502 with no error text/);
  });

  // A panel or a proxy on the port the user pointed at answers 200 with a
  // page; a state that is not a state must not reach the renderer.
  it("doubts a 200 that is not a state", async () => {
    const page = await serverAnswering(
      200,
      "<html>a panel</html>",
      "text/html",
    );
    const other = await serverAnswering(200, JSON.stringify({ hello: 1 }));

    for (const url of [page, other]) {
      const failure = await failureOf(
        new ApiClient({ apiUrl: url, token: TOKEN }),
      );

      expect(failure.failure).toBe("bad-answer");
      expect(failure.message).toMatch(/really an ephor collector/);
    }
  });

  it("names the address and the daemon when nobody answers there", async () => {
    const url = await closedPortUrl();

    const failure = await failureOf(
      new ApiClient({ apiUrl: url, token: TOKEN }),
    );

    expect(failure.failure).toBe("refused");
    expect(failure.message).toContain(`cannot reach the collector at ${url}`);
    expect(failure.message).toMatch(/Is `ephor serve` running there\?/);
    expect(failure.message).toMatch(/ECONNREFUSED/);
  });

  // `localhost` is what people type, and it has two addresses: Node then
  // reports one refusal per address inside an error with no message of its
  // own, which read as empty parentheses until the addresses were unpacked.
  it("still names the refusal when the host has several addresses", async () => {
    const url = (await closedPortUrl()).replace("127.0.0.1", "localhost");

    const failure = await failureOf(
      new ApiClient({ apiUrl: url, token: TOKEN }),
    );

    expect(failure.failure).toBe("refused");
    expect(failure.message).toMatch(/ECONNREFUSED/);
    expect(failure.message).toMatch(/Is `ephor serve` running there\?/);
  });

  // A URL fetch refuses to build is not a collector that is down, and the
  // hint about `ephor serve` would send the person to the wrong machine.
  it("does not blame the daemon for a request that could not be made", async () => {
    const failure = await failureOf(
      new ApiClient({ apiUrl: "http://user:secret@127.0.0.1:1", token: TOKEN }),
    );

    expect(failure.failure).toBe("unreachable");
    expect(failure.message).not.toMatch(/ephor serve/);
  });

  // A route that drops packets never refuses; without the timeout the
  // client would sit there for as long as the kernel's own patience.
  it("gives up on a collector that never answers", async () => {
    const url = await serverDoing(() => {});

    const failure = await failureOf(
      new ApiClient({ apiUrl: url, token: TOKEN, timeoutMs: 100 }),
    );

    expect(failure.failure).toBe("timeout");
    expect(failure.message).toMatch(
      /no answer from the collector at .* within 0\.1 s/,
    );
  });

  // A tunnel that stalls after the headers is the same timeout, not a
  // wrong program on the port: the person must not be sent to check the URL.
  it("calls a stall mid-answer a timeout, not a bad answer", async () => {
    const url = await serverDoing((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"now": 1, ');
    });

    const failure = await failureOf(
      new ApiClient({ apiUrl: url, token: TOKEN, timeoutMs: 100 }),
    );

    expect(failure.failure).toBe("timeout");
  });
});
