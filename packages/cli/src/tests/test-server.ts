import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CheckResponse, StateResponse } from "@ephorate/core";

export const TOKEN = "0123456789abcdef";

/** What `POST /api/check` answers: a result, or a refusal with its text. */
type CheckAnswer = CheckResponse | { status: 400 | 404; error: string };

interface CollectorBehaviour {
  check?: CheckAnswer | undefined;
  /** Answers to `/api/state` in order, the given state once they run out. */
  statesInOrder?: StateResponse[] | undefined;
}

/** A recorded request, its body read in full. */
export interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}

/**
 * A stand-in for the collector's API on a free loopback port. It answers
 * as the real server does at the edges a client can see — 401 with
 * `{ error }` for a wrong token, 404 for a route it lacks — and hands back
 * the state it was given. Requests are recorded so a test can prove what
 * the client sent.
 */
export async function collectorOf(
  state: StateResponse,
  behaviour: CollectorBehaviour = {},
): Promise<{
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const states = [...(behaviour.statesInOrder ?? [])];

  const server = createServer((request, response) => {
    void bodyOf(request).then((body) => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });

      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      if (request.url === "/api/state") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(states.shift() ?? state));
        return;
      }

      const { check } = behaviour;

      if (request.url === "/api/check" && request.method === "POST" && check) {
        if ("status" in check) {
          response.writeHead(check.status, {
            "content-type": "application/json",
          });
          response.end(JSON.stringify({ error: check.error }));
          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(check));
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => closed(server),
  };
}

function bodyOf(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString()));
    request.on("error", () => resolve(Buffer.concat(chunks).toString()));
  });
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
