import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Import reflect-metadata once before any test so Inversify decorators work.
    setupFiles: ["./tests/setup.ts"],
    env: {
      // config.ts calls req("VAULT_PATH") at import time — give it a safe temp value.
      VAULT_PATH: "/tmp/career-os-test-vault",
      // Tests write notes to the jobs dir directly and immediately read them back, so
      // the vault's note cache must not serve a stale list. 0 = always re-scan.
      VAULT_CACHE_TTL_MS: "0",
    },
    // Limit to 1 worker: vault.test.ts and workflow-vault.test.ts both write to
    // vault.jobsDir in beforeEach/afterEach — concurrent execution causes race
    // conditions when files are cleaned while another test is reading them.
    maxWorkers: 1,
    minWorkers: 1,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: [
        "src/web/**",          // browser bundle — different runtime
        "src/**/*.d.ts",
        "src/index.ts",        // pure wiring entrypoint
        "src/cli.ts",          // CLI entrypoint — no testable logic
        "src/logbus.ts",       // thin console wrapper
      ],
    },
  },
});
