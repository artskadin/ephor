import { HttpRequestError, type HttpRequester } from "@ephor/core";

/**
 * Issues the request from the collector itself. The default, and the only
 * origin that keeps working when a node is unreachable.
 */
export class DirectHttpRequester implements HttpRequester {
  constructor(private readonly timeoutMs = 15_000) {}

  async getJson<T>(url: string): Promise<T> {
    let response: Response;

    try {
      response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new HttpRequestError(url, undefined, describeFailure(cause), {
        cause,
      });
    }

    if (!response.ok) {
      throw new HttpRequestError(
        url,
        response.status,
        response.status === 429
          ? "rate limit reached"
          : `unexpected status ${response.status}`,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new HttpRequestError(url, response.status, "body is not JSON", {
        cause,
      });
    }
  }
}

function describeFailure(cause: unknown): string {
  // AbortSignal.timeout rejects with a TimeoutError, which reads as a bare
  // "The operation was aborted" without this.
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return "request timed out";
  }

  return cause instanceof Error ? cause.message : String(cause);
}
