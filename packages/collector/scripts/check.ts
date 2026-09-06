/**
 * Runs a check without a daemon and prints what the API would have answered:
 * deployment 5 before there is a client. For checking by hand against the
 * real world; exit code 2 when the check could not run as asked.
 *
 *   pnpm --filter @ephor/collector exec tsx scripts/check.ts \
 *     ../../examples/config.local.yaml [node] [probe]
 */
import { type CheckRequest, createLogger, loadConfig } from "@ephor/core";
import { checkWithoutDaemon } from "../src/check.js";
import { createRegistry } from "../src/probes/create-registry.js";

const configPath = process.argv[2] ?? "../../examples/config.local.yaml";
const node = process.argv[3];
const probe = process.argv[4];

const request: CheckRequest = {};
if (node !== undefined) request.node = node;
if (probe !== undefined) request.probe = probe;

const registry = createRegistry();
const config = await loadConfig(configPath, registry.descriptors());
const startedAt = Date.now();

const outcome = await checkWithoutDaemon({
  config,
  registry,
  logger: createLogger(),
  request,
});

console.log(JSON.stringify(outcome, null, 2));
console.error(`\ntook ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
// Not `process.exit()`: on macOS a pipe is written asynchronously, and
// exiting at once cuts stdout at 64 KB — a fleet's state is bigger. Nothing
// is left running after the check, so the loop drains and ends by itself.
process.exitCode = outcome.kind === "ran" ? 0 : 2;
