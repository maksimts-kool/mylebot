import { defineConfig } from "vitest/config";

// Isolated from the production suite: only picks up demo tests, so the root
// `npm test` (tests/**) never runs or imports anything under demo/.
export default defineConfig({
  test: {
    // Root stays the repo root; this glob targets only demo/tests so the production
    // suite under tests/** is never picked up by the demo run (and vice versa).
    include: ["demo/tests/**/*.test.ts"],
  },
});
