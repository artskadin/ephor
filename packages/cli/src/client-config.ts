export const DEFAULT_API_URL = "http://127.0.0.1:53556";

export interface ClientConfig {
  /** Where the collector's API answers; paths are appended to it. */
  apiUrl: string;
  token: string;
}

export class ClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientConfigError";
  }
}

/**
 * Where the collector is, from the environment: the `EPHOR_TOKEN` that
 * `ephor serve` runs with, so a client in the daemon's own shell needs no
 * setup, and `EPHOR_API_URL` when the daemon is not at this machine's
 * default port. `cli.yaml`, written by `init`, comes later and will sit
 * below these.
 */
export function clientConfigFrom(environment: NodeJS.ProcessEnv): ClientConfig {
  const token = environment.EPHOR_TOKEN;

  if (token === undefined || token === "") {
    throw new ClientConfigError(
      "EPHOR_TOKEN is not set. The collector's API requires it: export the " +
        "token `ephor serve` runs with.",
    );
  }

  // An `export EPHOR_API_URL=` left in a profile is the same mistake as an
  // empty token, and reads the same way: as not set.
  const given = environment.EPHOR_API_URL;
  const apiUrl = given === undefined || given === "" ? DEFAULT_API_URL : given;
  const url = parse(apiUrl);

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

  // Paths are appended to the address; anything after them would end up
  // in the middle of the request.
  if (url.search !== "" || url.hash !== "") {
    throw new ClientConfigError(
      `EPHOR_API_URL must be an address without a query or fragment, got "${apiUrl}"`,
    );
  }

  // Trailing slashes go, so `${apiUrl}/api/state` cannot come out with two.
  return { apiUrl: apiUrl.replace(/\/+$/, ""), token };
}

function parse(candidate: string): URL | undefined {
  try {
    return new URL(candidate);
  } catch {
    return undefined;
  }
}
