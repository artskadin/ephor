import { createRequire } from "node:module";

// `../package.json` from `src/` and from the bundle in `build/` alike.
export const VERSION = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
