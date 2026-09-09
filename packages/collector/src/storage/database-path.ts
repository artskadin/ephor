import { homedir } from "node:os";
// The default `join` follows the host, which would make `platform` a no-op.
import { posix, win32 } from "node:path";

interface DatabasePathSources {
  /** `EPHOR_DB`. */
  fromEnvironment?: string | undefined;
  /** `storage.path`. */
  fromConfig?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  environment?: Readonly<Record<string, string | undefined>> | undefined;
  home?: string | undefined;
}

// The fallback is absolute: a relative one follows the working directory,
// and in a container bypasses the mounted volume.
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
