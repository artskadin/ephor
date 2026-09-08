import type { StateResponse } from "@ephorate/core";

/**
 * What went wrong between the client and the collector, for code that
 * branches on it; the message is for the person and already says what to do.
 */
export type ApiFailure =
  | "unreachable"
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

export interface ApiClientOptions {
  apiUrl: string;
  token: string;
  /**
   * How long one request may take, body included. The collector reads
   * `/api/state` from `metrics_latest` in about a millisecond (measured), so
   * a request that takes seconds is a route that drops packets, and waiting
   * on it is waiting for nothing.
   */
  timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Talks to one collector over its API. Every failure becomes an `ApiError`
 * that names the collector and says what to do about it; nothing else
 * escapes.
 */
export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  async state(): Promise<StateResponse> {
    const answer = await this.get("/api/state");

    if (!isStateResponse(answer)) {
      throw this.badAnswer("/api/state", "is not a state");
    }

    return answer;
  }

  private async get(path: string): Promise<unknown> {
    const { apiUrl, token } = this.options;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let response: Response;

    try {
      response = await fetch(`${apiUrl}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw this.nothingCameBack(cause, timeoutMs);
    }

    if (response.status === 401) {
      throw new ApiError(
        "unauthorized",
        `the collector at ${apiUrl} rejected the token: EPHOR_TOKEN must ` +
          "be the one `ephor serve` runs with",
      );
    }

    if (!response.ok) {
      throw new ApiError(
        "rejected",
        `the collector at ${apiUrl} answered ${response.status}` +
          `${await reasonIn(response)}`,
      );
    }

    try {
      return await response.json();
    } catch (cause) {
      // The signal covers the body too: a tunnel that stalls mid-answer is
      // a timeout, not a wrong program on the port.
      if (isTimeout(cause)) throw this.nothingCameBack(cause, timeoutMs);

      throw this.badAnswer(path, "is not JSON", cause);
    }
  }

  /** No usable answer at all: which of the ways, and what to do about it. */
  private nothingCameBack(cause: unknown, timeoutMs: number): ApiError {
    const { apiUrl } = this.options;

    if (isTimeout(cause)) {
      return new ApiError(
        "timeout",
        `no answer from the collector at ${apiUrl} within ${timeoutMs / 1000} s`,
        { cause },
      );
    }

    // "Is it running?" answers a refused connection and nothing else: a
    // name that does not resolve, a certificate that does not verify or a
    // URL fetch will not take are told as they are.
    const hint = refusedConnection(cause)
      ? " Is `ephor serve` running there?"
      : "";

    return new ApiError(
      "unreachable",
      `cannot reach the collector at ${apiUrl}: ${describe(cause)}.${hint}`,
      { cause },
    );
  }

  private badAnswer(path: string, what: string, cause?: unknown): ApiError {
    return new ApiError(
      "bad-answer",
      `the answer from ${this.options.apiUrl}${path} ${what}: is that ` +
        "really an ephor collector?",
      cause === undefined ? undefined : { cause },
    );
  }
}

/**
 * The little the client checks before trusting the wire shape: enough to
 * tell another program answering on that port from a collector, not a
 * schema. The shapes are `core`'s and both sides are built from them.
 */
function isStateResponse(value: unknown): value is StateResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { now?: unknown }).now === "number" &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  );
}

/** The collector's own words for a refusal, when it gave any. */
async function reasonIn(response: Response): Promise<string> {
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
    // Not JSON: there is no reason to quote.
  }

  return " with no error text";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * The socket errors behind a failed `fetch`. Node wraps them: "fetch
 * failed" says nothing, its cause says "connect ECONNREFUSED
 * 127.0.0.1:53556" — or, for a name with several addresses such as
 * `localhost`, holds one such error per address in an `AggregateError`
 * with no message of its own. An error with no cause is its own reason.
 */
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

function refusedConnection(error: unknown): boolean {
  return socketErrors(error).some(
    (socketError) =>
      "code" in socketError && socketError.code === "ECONNREFUSED",
  );
}

function describe(error: unknown): string {
  const messages = socketErrors(error)
    .map((socketError) => socketError.message)
    .filter((message) => message !== "");

  if (messages.length > 0) return messages.join("; ");

  return error instanceof Error ? error.message : String(error);
}
