// Side-effect-only env loader. Import this FIRST in any script that touches
// `@/db` so DATABASE_URL is set before db/index.ts is evaluated.
//
// Why this exists: in ESM, all `import` statements are hoisted and executed
// before the body of the module runs. If a script does:
//
//   import { config as loadEnv } from "dotenv";
//   loadEnv({ path: ".env.local" });
//   import { db } from "../db";  // ← this is hoisted to the top, runs before loadEnv()
//
// then db/index.ts evaluates with process.env.DATABASE_URL still undefined and
// throws. The fix is to put the dotenv side-effect in a separate module and
// import it FIRST:
//
//   import "./_load-env";   // first import → dotenv runs immediately as a side effect
//   import { db } from "../db";  // now DATABASE_URL is set
//
// Reference: seed-demo-spine.ts (was broken), seed-test-users.ts (works because
// it imports schema only, not db).

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
