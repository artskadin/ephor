import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { StateResponse } from "@ephorate/core";

export const TOKEN = "0123456789abcdef";

/**
 * A stand-in for the collector's API on a free loopback port. It answers
 * as the real server does at the edges a client can see — 401 with
 * `{ error }` for a wrong token, 404 for a route it lacks — and hands back
 * the state it was given. Requests are recorded so a test can prove what
 * the client sent.
 */
export async function collectorOf(state: StateResponse): Promise<{
  url: string;
  requests: IncomingMessage[];
  close: () => Promise<void>;
}> {
  const requests: IncomingMessage[] = [];

  const server = createServer((request, response) => {
    requests.push(request);

    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (request.url === "/api/state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(state));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => closed(server),
  };
}

/**
 * Closed without waiting on the client's side of any connection, so a
 * teardown never depends on what the code under test did with its socket.
 */
export function closed(server: Server): Promise<void> {
  server.closeAllConnections();

  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * A loopback port nobody listens on: taken for a moment, then given back.
 * Another test could take it in between, but the kernel cycles through the
 * ephemeral range rather than handing the last port back, and the failure
 * would be a 404 from that test's server, not a hang.
 */
export async function closedPortUrl(): Promise<string> {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return `http://127.0.0.1:${port}`;
}

export const NOW = 1_800_000_000;

export function stateOf(
  ...nodes: { name: string; status: StateResponse["nodes"][number]["status"] }[]
): StateResponse {
  return {
    now: NOW,
    nodes: nodes.map(({ name, status }) => ({
      node: name,
      status,
      reachability: "ok",
      probes: ["system", "reachability"],
      metrics: [],
      reasons: status === "ok" ? [] : [`${name} is ${status}`],
    })),
  };
}
