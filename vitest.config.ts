import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The application logs to stdout; a test run should only show test output.
    env: { LOG_LEVEL: "silent" },
    coverage: { reporter: ["text", "html"] },
  },
});

