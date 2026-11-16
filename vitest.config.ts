import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Builds the test database (spatial_rest_test_vitest) once per run; the dev database is never touched.
    globalSetup: ["test/global-setup.ts"],
    // One database for all files: run them one after another, so writes in one never meet reads in another.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
});
