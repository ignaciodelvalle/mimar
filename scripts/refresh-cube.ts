#!/usr/bin/env tsx
/**
 * Manual / local panorama aggregate cube rebuild.
 *
 * Runs the SAME TS cube-builder the /api/cron/refresh-cube route runs
 * (src/modules/panorama/infrastructure/cube-builder.ts) — reuses the live
 * choropleth loaders and writes panorama_cube + cube_meta in one transaction.
 *
 * Launch (loads the server-only stub because @/db pulls the `server-only` sentinel):
 *   pnpm cube:refresh
 *   → node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/refresh-cube.ts
 *
 * Env is loaded from .env.local / .env BEFORE @/db is imported (the builder is
 * dynamically imported after loadEnv so the DB pools read the right URLs).
 *
 * Prints row_count, duration_ms, watermark and per-metric (department/province rows,
 * suppressed) so the parity/QA pass can record the numbers.
 */

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not set (copy .env.local.example to .env.local).");
    process.exit(2);
  }

  // NOTE (task #22): no ANALYTICS_STATEMENT_TIMEOUT_MS hack anymore. The builder
  // constructs its OWN lazy read client with a long statement_timeout (default
  // 120s; override via CUBE_BUILDER_STATEMENT_TIMEOUT_MS) — the shared analytics
  // pool keeps its 15s request-path backstop untouched.

  // Dynamic import AFTER env load so @/db constructs its pools with the right URLs.
  const { refreshCube } = await import("@/src/modules/panorama/infrastructure/cube-builder");

  console.log("Rebuilding panorama_cube …\n");
  const r = await refreshCube();

  console.log(`status       : ${r.status}`);
  console.log(`row_count    : ${r.rowCount}`);
  console.log(`duration_ms  : ${r.durationMs}`);
  console.log(`watermark    : ${r.watermark ? r.watermark.toISOString() : "null"}`);
  console.log(`built_at     : ${r.builtAt.toISOString()}`);
  console.log("\nper metric:");
  console.log("  metric                       dept   prov   suppressed");
  for (const m of r.perMetric) {
    console.log(
      `  ${m.metric.padEnd(26)} ${String(m.departmentRows).padStart(5)}  ${String(
        m.provinceRows,
      ).padStart(5)}  ${String(m.suppressed).padStart(10)}`,
    );
  }
  if (r.error) console.error(`\nERROR: ${r.error}`);

  process.exit(r.status === "ok" ? 0 : 1);
}

main().catch((err) => {
  console.error("UNEXPECTED ERROR:", err);
  process.exit(1);
});
