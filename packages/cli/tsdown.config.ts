import { defineConfig } from "tsdown";

// `@ephorate/*` are never published: bundled in from their sources.
// `dependencies` stay external.
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "build",
  platform: "node",
  target: "node24",
  format: "esm",
  // `.js`: the package is `type: module`, and `bin/ephor.js` imports it.
  outExtensions: () => ({ js: ".js" }),
  dts: false,
  // Node ignores maps without `--enable-source-maps`; they were 60% of the
  // package.
  sourcemap: false,
  clean: true,
});
