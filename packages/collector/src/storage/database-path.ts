import { homedir } from "node:os";
// Explicit variants rather than the default `join`: that one follows the
// host's separator, which would make the `platform` argument a no-op.
import { posix, win32 } from "node:path";

export interface DatabasePathSources {
  /** `EPHOR_DB`, when set. */
  fromEnvironment?: string | undefined;
  /** `storage.path` from the config, when set. */
  fromConfig?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  environment?: Readonly<Record<string, string | undefined>> | undefined;
  home?: string | undefined;
}

/**
 * Decides where the database lives.
 *
 * The fallback is deliberately absolute. A relative default follows the
 * working directory, so the same config would write to a different file
 * depending on where the process was started — and in a container it would
 * quietly bypass the mounted volume and lose every metric on recreation.
 */
export function resolveDatabasePath(sources: DatabasePathSources = {}): string {
  const explicit = sources.fromEnvironment ?? sources.fromConfig;

  if (explicit) return explicit;

  const environment = sources.environment ?? process.env;
  const platform = sources.platform ?? process.platform;
  const home = sources.home ?? homedir();

  if (platform === "win32") {
    const base =
      environment.LOCALAPPDATA ?? win32.join(home, "AppData", "Local");

    return win32.join(base, "ephor", "metrics.db");
  }

  const base = environment.XDG_DATA_HOME ?? posix.join(home, ".local", "share");

  return posix.join(base, "ephor", "metrics.db");
}
