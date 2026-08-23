import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        // Keep everything local: tests stub the AI binding themselves.
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, ADMIN_TOKEN: "test-admin-secret" },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      // One shared world per run: genesis seeds once and tests build on it.
      fileParallelism: false,
    },
  };
});
