import { describe, expect, it } from "vitest";
import { unitText } from "../commands/service";
import { ephor } from "./run-binary";

describe("the service's unit", () => {
  it("starts this node with this ephor, on this config, and not again on exit 2", () => {
    const text = unitText({
      nodePath: "/home/bruce/.local/node/bin/node",
      scriptPath:
        "/home/bruce/.local/node/lib/node_modules/ephorate/bin/ephor.js",
      configPath: "/home/bruce/.config/ephor/config.yaml",
      logPath: "/home/bruce/.local/state/ephor/serve.log",
    });

    expect(text).toContain(
      "StandardOutput=append:/home/bruce/.local/state/ephor/serve.log\n",
    );
    expect(text).toMatch(/^# Written by `ephor service install`/);
    expect(text).toContain(
      'ExecStart="/home/bruce/.local/node/bin/node" "/home/bruce/.local/node/lib/node_modules/ephorate/bin/ephor.js" serve\n',
    );
    expect(text).toContain(
      'Environment="EPHOR_CONFIG=/home/bruce/.config/ephor/config.yaml"\n',
    );
    expect(text).toContain("Restart=on-failure\n");
    expect(text).toContain("RestartPreventExitStatus=2\n");
    expect(text).toContain("WantedBy=default.target\n");
  });

  // `%` doubled everywhere; `$` only in ExecStart, measured on systemd 252.
  it("keeps a path with a space, a quote, % or $ as it is", () => {
    const text = unitText({
      nodePath: "/opt/my node/bin/node",
      scriptPath: '/opt/$a"b/ephor.js',
      configPath: "/srv/100%/$HOME/config.yaml",
      logPath: "/srv/100%/serve.log",
    });

    expect(text).toContain(
      'ExecStart="/opt/my node/bin/node" "/opt/$$a\\"b/ephor.js" serve',
    );
    expect(text).toContain(
      'Environment="EPHOR_CONFIG=/srv/100%%/$HOME/config.yaml"',
    );
    expect(text).toContain("StandardOutput=append:/srv/100%%/serve.log");
  });
});

describe("ephor service", () => {
  it.runIf(process.platform !== "linux")(
    "exits 2 where there is no systemd, saying what to do instead",
    async () => {
      const install = await ephor(["service", "install"]);
      const uninstall = await ephor(["service", "uninstall"]);

      for (const run of [install, uninstall]) {
        expect(run.code).toBe(2);
        expect(run.stderr).toContain("`ephor service` needs systemd");
      }
    },
  );
});
