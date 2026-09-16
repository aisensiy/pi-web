import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Native Node storage shadows happy-dom and shares sessionStorage across node tests.
    execArgv: process.allowedNodeEnvironmentFlags.has(
      "--no-experimental-webstorage"
    )
      ? ["--no-experimental-webstorage"]
      : [],
    include: [
      "src/**/*.test.ts",
      "pi-web-plugins/**/*.test.ts",
      "pi-packages/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
  },
});
