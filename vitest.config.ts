import { defineConfig } from "vitest/config";

/**
 * The screener core is pure and network-free, so it needs no DOM environment
 * and no setup file. Scope `include` to lib/ so vitest never tries to collect
 * Next.js route or page files.
 */
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
