/**
 * Standalone slot materialization runner.
 *
 * Calls materializeAllActiveSlots() and prints results.
 * Mirrors the env-loading pattern from scripts/seed-test-users.ts:
 *   - dotenv loaded from .env.local then .env BEFORE any db import
 *   - Safety guard: refuses to run against non-localhost DATABASE_URL
 *
 * Usage:
 *   pnpm materialize:slots
 */

import { config as loadEnv } from "dotenv";

// IMPORTANT: load env BEFORE importing anything that reads process.env at
// module load time (db/index.ts throws if DATABASE_URL is missing).
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const DATABASE_URL = process.env.DATABASE_URL ?? "";

const isLocalUrl = (u: string) => u.includes("127.0.0.1") || u.includes("localhost");

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env.local — aborting.");
  process.exit(2);
}

if (!isLocalUrl(DATABASE_URL)) {
  console.error(
    `Refusing to run: DATABASE_URL (${DATABASE_URL}) is not localhost.\nTo run against a remote DB use the cron route instead.`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Deferred imports (after env load)
// ---------------------------------------------------------------------------

const { materializeAllActiveSlots } = await import(
  "../src/modules/service-offerings/application/slot-materialization/materialize-slots"
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const start = Date.now();
console.log("[INFO] Starting slot materialization...");

try {
  const { rulesProcessed, slotsInserted } = await materializeAllActiveSlots();
  const durationMs = Date.now() - start;
  console.log(
    `[DONE] rulesProcessed=${rulesProcessed} slotsInserted=${slotsInserted} durationMs=${durationMs}`,
  );
  process.exit(0);
} catch (err) {
  console.error("[FATAL]", err);
  process.exit(1);
}
