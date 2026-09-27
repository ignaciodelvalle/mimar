#!/usr/bin/env tsx
/**
 * Catalogue drift report (localidades-por-id E3): what still points at a
 * catalogue row the INDEC import renamed or removed. Run it after every
 * import; the importer prints the same summary when it finishes.
 *
 * READ-ONLY. It lists and never fixes: see lib/place/drift-report.ts for why
 * a rename is not refreshed and a removed id is not re-pointed automatically.
 * Removed-locality memberships are closed by an admin on /admin/localidades.
 *
 *   pnpm place:drift-report           human-readable lines
 *   pnpm place:drift-report --json    the report as JSON
 *
 * Exits 0 whatever it finds: drift is a list for a person, not a failure.
 */

import "./_load-env";

import { db } from "@/db";
import { collectPlaceDrift, formatPlaceDrift } from "@/lib/place/drift-report";

async function main(): Promise<void> {
  const report = await collectPlaceDrift(db);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatPlaceDrift(report)) console.log(line);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("place-drift-report failed:", err);
    process.exit(1);
  });
