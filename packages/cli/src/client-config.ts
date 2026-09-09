import { UsageError } from "./exit-code.js";

export const DEFAULT_API_URL = "http://127.0.0.1:31556";

interface ClientConfig {
  apiUrl: string;
  token: string;
}

export class ClientConfigError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "ClientConfigError";
  }
}

/** `EPHOR_TOKEN` and `EPHOR_API_URL`; `cli.yaml` from `init` sits below. */
export function clientConfigFrom(environment: NodeJS.ProcessEnv): ClientConfig {
  const token = environment.EPHOR_TOKEN;

  if (token === undefined || token === "") {
    throw new ClientConfigError(
      "EPHOR_TOKEN is not set. The collector's API requires it: export the " +
        "token `ephor serve` runs with.",
    );
  }

  // An `export EPHOR_API_URL=` left in a profile reads as not set.
  const configured = environment.EPHOR_API_URL;
  const apiUrl =
    configured === undefined || configured === ""
      ? DEFAULT_API_URL
      : configured;
  const url = parseUrl(apiUrl);

  if (url === undefined) {
    throw new ClientConfigError(`EPHOR_API_URL is not a URL: "${apiUrl}"`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ClientConfigError(
      `EPHOR_API_URL must start with http:// or https://, got "${apiUrl}"`,
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new ClientConfigError(
      "EPHOR_API_URL must not carry credentials; the token goes in EPHOR_TOKEN",
    );
  }

  // Paths are appended to the address.
  if (url.search !== "" || url.hash !== "") {
    throw new ClientConfigError(
      `EPHOR_API_URL must be an address without a query or fragment, got "${apiUrl}"`,
    );
  }

  return { apiUrl: apiUrl.replace(/\/+$/, ""), token };
}

function parseUrl(candidate: string): URL | undefined {
  try {
    return new URL(candidate);
  } catch {
    return undefined;
  }
}
