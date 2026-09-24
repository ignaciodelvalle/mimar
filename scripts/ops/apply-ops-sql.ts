// Minimal runner for dated ops SQL instruments under scripts/ops/.
//
// Usage:
//   node --env-file=<env-file> --import tsx scripts/ops/apply-ops-sql.ts <file.sql>
//
// Executes the file's statements against DATABASE_URL inside `postgres.unsafe`
// (the instruments carry their own begin/commit). Prints the file name and the
// target host (never credentials). Refuses to run without an explicit file
// argument — there is no default target and no directory sweep on purpose:
// each run is one deliberate, auditable instrument.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import postgres from "postgres";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: apply-ops-sql.ts <file.sql>");
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }
  const path = resolve(file);
  const body = readFileSync(path, "utf8");
  const host = new URL(url).host;
  console.log(`Applying ${file} against ${host} …`);
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(body);
    console.log("ok");
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
