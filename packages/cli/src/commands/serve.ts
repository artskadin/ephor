import { MissingTokenError, serve } from "@ephorate/collector";
import { ConfigError, type Logger } from "@ephorate/core";
import { EXIT_OK, UsageError } from "../exit-code";

interface ServeOptions {
  configPath: string;
  /** `EPHOR_DB`; wins over `storage.path`. */
  databasePath: string | undefined;
  /** `EPHOR_TOKEN`. */
  token: string;
  logger: Logger;
}

class ServeError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "ServeError";
  }
}

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Foreground until a signal; systemd or compose keeps it alive. SIGHUP is
 * a dropped ssh session, not a reload: the daemon stops like on SIGTERM.
 */
export async function runServe(options: ServeOptions): Promise<never> {
  // Before the start, which migrations can hold for seconds: a signal
  // then would take the default action, exit 143, a failure to systemd.
  const signalled = firstSignal(options.logger);

  const daemon = await serve(options).catch((error: unknown) => {
    throw explainStartFailure(error);
  });

  const signal = await signalled;
  options.logger.info("shutting down", { signal });
  await daemon.stop();

  // A probe still in flight holds an ssh child, and the loop with it,
  // until the probe's timeout; that run is lost, the exit is not delayed.
  process.exit(EXIT_OK);
}

// Handlers stay: a second signal during shutdown must not kill the
// process before the database is closed.
function firstSignal(logger: Logger): Promise<string> {
  return new Promise((resolve) => {
    let received: string | undefined;

    for (const name of STOP_SIGNALS) {
      process.on(name, () => {
        if (received !== undefined) {
          logger.warn("still stopping; SIGKILL to force", { signal: name });
          return;
        }

        received = name;
        resolve(name);
      });
    }
  });
}

function explainStartFailure(error: unknown): unknown {
  if (error instanceof ConfigError || error instanceof MissingTokenError) {
    return new ServeError(error.message);
  }

  if (!(error instanceof Error && "code" in error && "address" in error)) {
    return error;
  }

  const where = `${error.address}:${"port" in error ? error.port : ""}`;

  if (error.code === "EADDRINUSE") {
    return new ServeError(
      `${where} is taken: another \`ephor serve\`? Stop it, or set api.port in config.yaml.`,
    );
  }

  if (error.code === "EACCES") {
    return new ServeError(
      `${where} needs root to listen on: ports below 1024 do. Set api.port in config.yaml.`,
    );
  }

  return error;
}
