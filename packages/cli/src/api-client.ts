import type { StateResponse } from "@ephorate/core";

type ApiFailure =
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

interface ApiClientOptions {
  apiUrl: string;
  token: string;
  /** `/api/state` answers in a millisecond; seconds mean a bad route. */
  timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Every failure is an `ApiError` naming the collector and what to do. */
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

  private nothingCameBack(cause: unknown, timeoutMs: number): ApiError {
    const { apiUrl } = this.options;

    if (isTimeout(cause)) {
      return new ApiError(
        "timeout",
        `no answer from the collector at ${apiUrl} within ${timeoutMs / 1000} s`,
        { cause },
      );
    }

    // Only a refused connection means "is it running?".
    const hint = refusedConnection(cause)
      ? " Is `ephor serve` running there?"
      : "";

    return new ApiError(
      "unreachable",
      `cannot reach the collector at ${apiUrl}: ${failureText(cause)}.${hint}`,
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

/** Enough to tell another program on the port from a collector; no schema. */
function isStateResponse(value: unknown): value is StateResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { now?: unknown }).now === "number" &&
    Array.isArray((value as { nodes?: unknown }).nodes)
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

function refusedConnection(error: unknown): boolean {
  return socketErrors(error).some(
    (socketError) =>
      "code" in socketError && socketError.code === "ECONNREFUSED",
  );
}

function failureText(error: unknown): string {
  const messages = socketErrors(error)
    .map((socketError) => socketError.message)
    .filter((message) => message !== "");

  if (messages.length > 0) return messages.join("; ");

  return error instanceof Error ? error.message : String(error);
}
