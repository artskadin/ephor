import {
  type Acknowledgement,
  type AcknowledgementResponse,
  type AcknowledgeRequest,
  CHECK_MAX_WAIT_SECONDS,
  type CheckRequest,
  type CheckResponse,
  type RemovedAcknowledgementResponse,
  type StateResponse,
} from "@ephorate/core";

/** `refused` alone means "is `ephor serve` running there?". */
type ApiFailure =
  | "refused"
  | "unreachable"
  /** The tunnel's ssh is gone; the request never left this machine. */
  | "link-closed"
  | "timeout"
  | "unauthorized"
  | "rejected"
  | "bad-answer";

export class ApiError extends Error {
  constructor(
    readonly failure: ApiFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ApiError";
  }
}

interface ApiClientOptions {
  apiUrl: string;
  token: string;
  /** Set when `apiUrl` is a tunnel's local end: the messages name the far end. */
  tunnel?:
    | {
        remote: string;
        remotePort: number;
        /** Where the token came from, for a rejected one. */
        tokenSource: string;
      }
    | undefined;
  /** `/api/state` answers in a millisecond; seconds mean a bad route. */
  timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Above `CHECK_MAX_WAIT_SECONDS`: the daemon answers first, or never. */
const CHECK_TIMEOUT_MS = (CHECK_MAX_WAIT_SECONDS + 10) * 1000;

/** Every failure is an `ApiError` naming the collector and what to do. */
export class ApiClient {
  readonly apiUrl: string;

  constructor(private readonly options: ApiClientOptions) {
    this.apiUrl = options.apiUrl;
  }

  async state(): Promise<StateResponse> {
    const answer = await this.request("GET", "/api/state");

    if (!isStateResponse(answer)) {
      throw this.badAnswer("/api/state", "is not a state");
    }

    return answer;
  }

  /** Blocks while the daemon waits for the run, up to its 240 s cap. */
  async check(request: CheckRequest): Promise<CheckResponse> {
    const answer = await this.request(
      "POST",
      "/api/check",
      request,
      Math.max(CHECK_TIMEOUT_MS, this.options.timeoutMs ?? 0),
    );

    if (!isCheckResponse(answer)) {
      throw this.badAnswer("/api/check", "is not a check result");
    }

    return answer;
  }

  async acknowledge(
    node: string,
    request: AcknowledgeRequest,
  ): Promise<AcknowledgementResponse> {
    const path = acknowledgementPath(node);
    const acknowledgement = acknowledgementIn(
      await this.request("PUT", path, request),
    );

    if (!isAcknowledgement(acknowledgement)) {
      throw this.badAnswer(path, "is not an acknowledgement");
    }

    return { acknowledgement };
  }

  async unacknowledge(node: string): Promise<RemovedAcknowledgementResponse> {
    const path = acknowledgementPath(node);
    const acknowledgement = acknowledgementIn(
      await this.request("DELETE", path),
    );

    if (acknowledgement !== null && !isAcknowledgement(acknowledgement)) {
      throw this.badAnswer(path, "is not an acknowledgement");
    }

    return { acknowledgement };
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    const { apiUrl, token } = this.options;
    let response: Response;

    try {
      response = await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw this.nothingCameBack(cause, timeoutMs);
    }

    if (response.status === 401) {
      const { tunnel } = this.options;
      throw new ApiError(
        "unauthorized",
        tunnel
          ? `${this.collector()} rejected the token in ${tunnel.tokenSource}: ` +
              "it must be the one `ephor serve` there runs with"
          : `${this.collector()} rejected the token: EPHOR_TOKEN, or the ` +
              "token file, must hold the one `ephor serve` runs with",
      );
    }

    if (!response.ok) {
      throw new ApiError(
        "rejected",
        `${this.collector()} answered ${response.status}` +
          `${await errorTextIn(response)}`,
      );
    }

    try {
      return await response.json();
    } catch (cause) {
      // The signal covers the body: a tunnel stalling mid-answer is a timeout.
      if (isTimeout(cause)) throw this.nothingCameBack(cause, timeoutMs);

      throw this.badAnswer(path, "is not JSON", cause);
    }
  }

  /** `the collector at <url>`, or on the far end of a tunnel. */
  private collector(): string {
    const { tunnel, apiUrl } = this.options;
    return tunnel
      ? `the collector on ${tunnel.remote}`
      : `the collector at ${apiUrl}`;
  }

  private nothingCameBack(cause: unknown, timeoutMs: number): ApiError {
    const { tunnel } = this.options;

    if (isTimeout(cause)) {
      return new ApiError(
        "timeout",
        `no answer from ${this.collector()} within ${timeoutMs / 1000} s`,
        { cause },
      );
    }

    // Measured: through a tunnel, nothing listening there reads as a reset
    // here, not a refusal; ssh took the connection, its far end could not.
    if (tunnel && hasSocketCode(cause, "ECONNRESET")) {
      return new ApiError(
        "refused",
        `no \`ephor serve\` on ${tunnel.remote}: ssh connected, but nothing ` +
          `answers on port ${tunnel.remotePort} there`,
        { cause },
      );
    }
    // Closed before the headers: the same, or a serve that stopped mid-way.
    if (tunnel && hasSocketCode(cause, "UND_ERR_SOCKET")) {
      return new ApiError(
        "refused",
        `the collector on ${tunnel.remote} closed the connection before ` +
          `answering: no \`ephor serve\` on port ${tunnel.remotePort} there, ` +
          "or it stopped",
        { cause },
      );
    }

    // ssh listens on the local end while it lives: refused there, it is gone.
    if (tunnel && hasSocketCode(cause, "ECONNREFUSED")) {
      return new ApiError(
        "link-closed",
        `the ssh link to ${tunnel.remote} closed`,
        { cause },
      );
    }

    if (hasSocketCode(cause, "ECONNREFUSED")) {
      return new ApiError(
        "refused",
        `cannot reach ${this.collector()}: ${failureText(cause)}. ` +
          "Is `ephor serve` running there?",
        { cause },
      );
    }

    return new ApiError(
      "unreachable",
      `cannot reach ${this.collector()}: ${failureText(cause)}.`,
      { cause },
    );
  }

  private badAnswer(path: string, what: string, cause?: unknown): ApiError {
    return new ApiError(
      "bad-answer",
      `the answer from ${this.collector()} to ${path} ${what}: is that ` +
        "really an ephor collector?",
      cause === undefined ? undefined : { cause },
    );
  }
}

/** Enough to tell another program on the port from a collector; no schema. */
function isStateResponse(value: unknown): value is StateResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { now?: unknown }).now === "number" &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  );
}

export function isCheckResponse(value: unknown): value is CheckResponse {
  if (!isStateResponse(value)) return false;

  const candidate = value as Partial<CheckResponse>;

  return (
    typeof candidate.startedAt === "number" &&
    typeof candidate.complete === "boolean" &&
    Array.isArray(candidate.pending)
  );
}

// A name is the operator's text: `a/b` or `?` must not reshape the route.
function acknowledgementPath(node: string): string {
  return `/api/nodes/${encodeURIComponent(node)}/ack`;
}

function acknowledgementIn(answer: unknown): unknown {
  return typeof answer === "object" && answer !== null
    ? (answer as { acknowledgement?: unknown }).acknowledgement
    : undefined;
}

function isAcknowledgement(value: unknown): value is Acknowledgement {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { node?: unknown }).node === "string" &&
    typeof (value as { status?: unknown }).status === "string" &&
    typeof (value as { since?: unknown }).since === "number" &&
    typeof (value as { untilOk?: unknown }).untilOk === "boolean"
  );
}

async function errorTextIn(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();

    if (
      typeof body === "object" &&
      body !== null &&
      typeof (body as { error?: unknown }).error === "string"
    ) {
      return `: ${(body as { error: string }).error}`;
    }
  } catch {
    // Not JSON: nothing to quote.
  }

  return " with no error text";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

// Node's "fetch failed" says nothing; its cause says "connect ECONNREFUSED",
// or holds one error per address in an `AggregateError` for `localhost`.
function socketErrors(error: unknown): Error[] {
  if (!(error instanceof Error)) return [];

  const inner = error.cause;

  if (inner instanceof AggregateError) {
    return inner.errors.filter(
      (candidate): candidate is Error => candidate instanceof Error,
    );
  }

  return inner instanceof Error ? [inner] : [error];
}

function hasSocketCode(error: unknown, code: string): boolean {
  return socketErrors(error).some(
    (socketError) => "code" in socketError && socketError.code === code,
  );
}

function failureText(error: unknown): string {
  const messages = socketErrors(error)
    .map((socketError) => socketError.message)
    .filter((message) => message !== "");

  if (messages.length > 0) return messages.join("; ");

  return error instanceof Error ? error.message : String(error);
}
