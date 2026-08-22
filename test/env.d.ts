import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as WorldEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends WorldEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
