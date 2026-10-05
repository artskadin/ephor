import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "@ephorate/collector";
import { ConfigError, parseConfig } from "@ephorate/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CONFIG_TEMPLATE } from "../commands/config-template";
import { runInit } from "../commands/init";
import { UsageError } from "../exit-code";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ephor-init-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function init(
  configPath = join(directory, "ephor", "config.yaml"),
  environmentToken?: string,
): string[] {
  const lines: string[] = [];
  runInit({ configPath, environmentToken, print: (line) => lines.push(line) });
  return lines;
}

describe("runInit", () => {
  it("writes the template and a token only its owner can read", () => {
    const lines = init();
    const config = join(directory, "ephor", "config.yaml");
    const token = join(directory, "ephor", "token");

    expect(readFileSync(config, "utf8")).toBe(CONFIG_TEMPLATE);
    expect(readFileSync(token, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    expect(statSync(token).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "ephor")).mode & 0o777).toBe(0o700);
    expect(lines.slice(0, 2)).toEqual([
      `created ${config}`,
      `created ${token}, the API token, readable by you only`,
    ]);
    expect(lines.join("\n")).toContain(
      `next: add your servers under \`nodes:\` in ${config}`,
    );
  });

  it("keeps both files when run again, and says so", () => {
    init();
    const config = join(directory, "ephor", "config.yaml");
    const token = join(directory, "ephor", "token");
    writeFileSync(config, "nodes: [edited]\n");
    const before = readFileSync(token, "utf8");

    const lines = init();

    expect(readFileSync(config, "utf8")).toBe("nodes: [edited]\n");
    expect(readFileSync(token, "utf8")).toBe(before);
    expect(lines.slice(0, 2)).toEqual([
      `kept ${config}: already there`,
      `kept ${token}: already there`,
    ]);
    // A config already there may hold nodes: no telling to add them.
    expect(lines).toContain("next:");
    expect(lines.join("\n")).not.toContain("add your servers");
  });

  // Someone who configured ephor before there was a token file.
  it("adds only the token beside a config already there", () => {
    const config = join(directory, "config.yaml");
    writeFileSync(config, "nodes: [mine]\n");

    init(config);

    expect(readFileSync(config, "utf8")).toBe("nodes: [mine]\n");
    expect(statSync(join(directory, "token")).isFile()).toBe(true);
  });

  it("gives a different token each time", () => {
    init(join(directory, "a", "config.yaml"));
    init(join(directory, "b", "config.yaml"));

    expect(readFileSync(join(directory, "a", "token"), "utf8")).not.toBe(
      readFileSync(join(directory, "b", "token"), "utf8"),
    );
  });

  it("says when EPHOR_TOKEN will win over the file", () => {
    expect(init(undefined, "from-env")).toContain(
      "note: EPHOR_TOKEN is set in this shell and wins over the file",
    );
    expect(init(join(directory, "c", "config.yaml"), "")).not.toContain(
      "note: EPHOR_TOKEN is set in this shell and wins over the file",
    );
  });

  it("refuses a directory it cannot create, naming it", () => {
    writeFileSync(join(directory, "taken"), "a file, not a directory");

    expect(() => init(join(directory, "taken", "config.yaml"))).toThrow(
      UsageError,
    );
    expect(() => init(join(directory, "taken", "config.yaml"))).toThrow(
      `cannot create ${join(directory, "taken")}`,
    );
  });
});

describe("CONFIG_TEMPLATE", () => {
  // The daemon's own registry: what `serve` accepts, nothing looser.
  const descriptors = createRegistry().descriptors();

  /** The template with one commented example node made real. */
  function withExample(name: string): string {
    const lines = CONFIG_TEMPLATE.split("\n");
    const start = lines.indexOf(`  # - name: ${name}`);
    if (start === -1) throw new Error(`no example node "${name}"`);
    const end = lines.findIndex(
      (line, index) => index > start && line.trim() === "#",
    );

    return [
      ...lines.slice(0, start),
      ...lines.slice(start, end).map((line) => line.replace(/^ {2}# /, "  ")),
      ...lines.slice(end),
    ].join("\n");
  }

  it("is refused as written, saying where the nodes go", () => {
    expect(() => parseConfig(parse(CONFIG_TEMPLATE), descriptors)).toThrow(
      ConfigError,
    );
    expect(() => parseConfig(parse(CONFIG_TEMPLATE), descriptors)).toThrow(
      "at least one node: list yours under `nodes:`",
    );
  });

  it.each(["amsterdam", "frankfurt", "helsinki"])(
    "is valid with the %s example uncommented",
    (name) => {
      const config = parseConfig(parse(withExample(name)), descriptors);

      expect(config.nodes.map((node) => node.name)).toEqual([name]);
    },
  );

  it("is valid with the ports example on a node", () => {
    const text = withExample("amsterdam").replace(
      "  #   ports: [443, 2222]",
      "    ports: [443, 2222]",
    );

    expect(
      parseConfig(parse(text), descriptors).nodes[0]?.ports.map(
        (port) => port.port,
      ),
    ).toEqual([443, 2222]);
  });

  // Documentation addresses only: no real server leaks through the template.
  it("names only documentation addresses", () => {
    const addresses = CONFIG_TEMPLATE.match(/\b\d+\.\d+\.\d+\.\d+\b/g) ?? [];

    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) expect(address).toMatch(/^203\.0\.113\./);
  });
});
