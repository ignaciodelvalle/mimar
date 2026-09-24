// Prints the seed INSERT of pii.pet_event_redaction_rules from
// lib/events/payload-privacy.ts's redactionRules() (T3-A2b).
//
// The migration that creates the table commits this output LITERALLY — a
// migration is immutable SQL and must not import TypeScript at apply time.
// The two can then drift only one way, and that way is fenced: the DB half of
// scripts/check-subject-rights-coverage.ts compares the LIVE table with
// redactionRules() in both directions. When the classification changes, a new
// migration re-seeds the table from a fresh run of this script.
//
// Run:  pnpm tsx scripts/generate-pet-event-redaction-rules.ts

import { type RedactionRule, redactionRules } from "@/lib/events/payload-privacy";

function lit(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function arr(xs: readonly string[] | null): string {
  return xs === null ? "null" : `array[${xs.map(lit).join(", ")}]`;
}

export function renderSeed(rules: readonly RedactionRule[]): string {
  const rows = rules.map(
    (r) =>
      `  (${lit(r.event_type)}, ${arr(r.key_path)}, ${lit(r.transform)}, ${r.author_gated}, ${arr(r.party_keys)})`,
  );
  return [
    "insert into pii.pet_event_redaction_rules",
    "  (event_type, key_path, transform, author_gated, party_keys)",
    "values",
    `${rows.join(",\n")};`,
  ].join("\n");
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("generate-pet-event-redaction-rules.ts") ||
    process.argv[1].endsWith("generate-pet-event-redaction-rules.js"));

if (isMain) {
  console.log(renderSeed(redactionRules()));
}
