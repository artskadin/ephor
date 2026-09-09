import { homedir } from "node:os";
// The default `join` follows the host, which would make `platform` a no-op.
import { posix, win32 } from "node:path";

interface ConfigPathSources {
  /** `--config`. */
  flag?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  /** `EPHOR_CONFIG`, then `XDG_CONFIG_HOME` or `APPDATA`. */
  environment?: Readonly<Record<string, string | undefined>> | undefined;
  home?: string | undefined;
}

// Beside the database's `~/.local/share/ephor`: `npm i -g` needs no root,
// so neither does the default. A bastion's unit points at `/etc` if wanted.
export function resolveConfigPath(sources: ConfigPathSources = {}): string {
  const environment = sources.environment ?? process.env;

  // An `export EPHOR_CONFIG=` left in a profile reads as not set.
  const explicit = sources.flag || environment.EPHOR_CONFIG;
  if (explicit) return explicit;

  const platform = sources.platform ?? process.platform;
  const home = sources.home ?? homedir();

  if (platform === "win32") {
    const base = environment.APPDATA ?? win32.join(home, "AppData", "Roaming");

    return win32.join(base, "ephor", "config.yaml");
  }

  const base = environment.XDG_CONFIG_HOME ?? posix.join(home, ".config");

  return posix.join(base, "ephor", "config.yaml");
}
