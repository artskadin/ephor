#!/usr/bin/env node
// Not bundled: an ESM bundle hoists its external imports above our first
// statement, and React picks its build from NODE_ENV as it loads (a frame
// of 200 nodes: 75 ms dev, 51 ms production). `??=` keeps dev reachable.
process.env.NODE_ENV ??= "production";

await import("../build/index.js");
