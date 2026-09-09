import { HttpRequestError, type HttpRequester } from "@ephorate/core";

/** From the collector: the only origin that works when a node is down. */
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
      throw new HttpRequestError(url, undefined, failureMessage(cause), {
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

function failureMessage(cause: unknown): string {
  // AbortSignal.timeout says only "The operation was aborted".
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return "request timed out";
  }

  return cause instanceof Error ? cause.message : String(cause);
}
