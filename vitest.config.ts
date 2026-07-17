import { defineConfig } from "vitest/config";

process.env.NODE_NO_WARNINGS ??= "1";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
