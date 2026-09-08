import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Both: a test written beside a component in `.tsx` is a test too, and
    // an include that misses it skips it without a word.
    include: ["packages/*/src/**/*.test.{ts,tsx}"],
  },
});
