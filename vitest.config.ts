import { defineConfig } from "vitest/config";

// Vitest runs the desk service's tests only. The team skills under skills/
// carry node:test suites of their own: npm run test:skills.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
