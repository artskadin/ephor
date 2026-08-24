import * as z from "zod";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";

const ALLOWED_ROOTS: string[] = process.argv
  .slice(2)
  .map((p) => realpathSync(path.resolve(p)));

if (ALLOWED_ROOTS.length === 0) {
  console.error("Usage: tsx fs-readonly.ts <allowed-dir> [more-dirs...]");
  process.exit(1);
}

const IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
]);
const DENY_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx)$/i,
  /^id_(rsa|ed25519|ecdsa)/i,
  /credential|secret/i,
  /^\.npmrc$/i,
];
const MAX_FILE_SIZE = 256 * 1024;

const server = new McpServer({ name: "fs-readonly", version: "1.0.0" });

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`fs-readonly MCP started. Roots: ${ALLOWED_ROOTS.join(", ")}`);
}

server.registerTool(
  "list_dir",
  {
    title: "List directory",
    description:
      "List files and subdirectories at a path (read-only). " +
      `Allowed roots: ${ALLOWED_ROOTS.join(", ")}`,
    inputSchema: {
      path: z.string().describe("Absolute path or path inside an allowed root"),
    },
  },
  async ({ path: dirPath }) => {
    const real = await resolveSafe(dirPath);
    const entries = await fs.readdir(real, { withFileTypes: true });
    const lines = entries
      .filter((e) => !IGNORE.has(e.name) && !isDenied(e.name))
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      )
      .map((e) => (e.isDirectory() ? `[dir] ${e.name}` : `[file] ${e.name}`));

    return ok(lines.join("\n") || "empty");
  },
);

server.registerTool(
  "read_file",
  {
    title: "Read file",
    description: "Read a UTF-8 text file (read-only, max 256 KB)",
    inputSchema: {
      path: z.string().describe("Path to the file"),
    },
  },
  async ({ path: filePath }) => {
    const real = await resolveSafe(filePath);
    const stat = await fs.stat(real);

    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(`File too large (${stat.size} bytes > ${MAX_FILE_SIZE})`);
    }

    return ok(await fs.readFile(real, "utf-8"));
  },
);

server.registerTool(
  "search_files",
  {
    title: "Search files by name",
    description:
      "Recursively find files whose name contains a substring (case-insensitive). Read-only",
    inputSchema: {
      root: z.string().describe("Directory to search in"),
      query: z
        .string()
        .describe(
          'Substring of the file name, e.g. "schema.prisma" or ".prisma"',
        ),
    },
  },
  async ({ root, query }) => {
    const realRoot = await resolveSafe(root);
    const q = query.toLowerCase();
    const hits: string[] = [];

    async function walk(dir: string): Promise<void> {
      if (hits.length >= 200) {
        return;
      }

      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const e of entries) {
        if (IGNORE.has(e.name) || isDenied(e.name)) {
          continue;
        }

        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.name.toLowerCase().includes(q)) {
          hits.push(full);
        }
      }
    }

    await walk(realRoot);

    return ok(hits.length ? hits.join("\n") : "No matches found");
  },
);

async function resolveSafe(requested: string): Promise<string> {
  const abs = path.resolve(requested);
  const real = await fs.realpath(abs);
  const ok = ALLOWED_ROOTS.some(
    (root) => real === root || real.startsWith(root + path.sep),
  );

  if (!ok) {
    throw new Error(`Access denied: "${requested}" is outside allowed roots`);
  }

  if (isDenied(path.basename(real))) {
    throw new Error(
      `Access denied: "${path.basename(real)}" is a sensitive file`,
    );
  }

  return real;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function isDenied(name: string): boolean {
  return DENY_PATTERNS.some((re) => re.test(name));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
