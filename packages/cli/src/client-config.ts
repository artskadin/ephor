import { cliFilePath, readCliFile } from "./cli-file";
import { resolveConfigPath } from "./config-path";
import { UsageError } from "./exit-code";
import { findToken, tokenPath } from "./token";

export const DEFAULT_API_URL = "http://127.0.0.1:31556";

interface ClientConfig {
  apiUrl: string;
  token: string;
  /** For stderr, once: the token file is readable by others. */
  tokenWarning?: string | undefined;
}

/** Where the collector is: on this machine, or behind an ssh tunnel. */
type CollectorSource =
  | { kind: "here"; config: ClientConfig }
  | {
      kind: "remote";
      remote: string;
      remotePort: number;
      token: string;
      /** Named when the token is rejected. */
      tokenSource: string;
      warning?: string | undefined;
    };

/**
 * `EPHOR_API_URL` names one directly; else `cli.yaml` beside the config
 * names a remote one; else it is here. `EPHOR_TOKEN` wins over any file.
 */
export function collectorSourceFrom(
  environment: NodeJS.ProcessEnv,
  configPath: string = resolveConfigPath({ environment }),
): CollectorSource {
  if (!environment.EPHOR_API_URL) {
    const path = cliFilePath(configPath);
    const cli = readCliFile(path);

    if (cli !== undefined) {
      const fromEnvironment = environment.EPHOR_TOKEN;
      return {
        kind: "remote",
        remote: cli.remote,
        remotePort: cli.apiPort,
        token: fromEnvironment || cli.token,
        tokenSource: fromEnvironment ? "EPHOR_TOKEN" : path,
        warning: cli.warning,
      };
    }
  }

  return { kind: "here", config: clientConfigFrom(environment, configPath) };
}

export class ClientConfigError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "ClientConfigError";
  }
}

/**
 * The token from `EPHOR_TOKEN`, else the `token` file `ephor serve` reads
 * on this machine; the address from `EPHOR_API_URL`. `cli.yaml` comes next.
 */
export function clientConfigFrom(
  environment: NodeJS.ProcessEnv,
  configPath: string = resolveConfigPath({ environment }),
): ClientConfig {
  const found = findToken({ environment, configPath });

  if (found === undefined) {
    const path = tokenPath(configPath);
    throw new ClientConfigError(
      `no API token: EPHOR_TOKEN is not set and ${path} does not exist. ` +
        "If `ephor serve` runs here with another config, set EPHOR_CONFIG " +
        "to it; else export the token it runs with as EPHOR_TOKEN.",
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

  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    token: found.token,
    tokenWarning: found.warning,
  };
}

function parseUrl(candidate: string): URL | undefined {
  try {
    return new URL(candidate);
  } catch {
    return undefined;
  }
}
