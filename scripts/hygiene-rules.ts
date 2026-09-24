// Seed-hygiene shared rules — plan-maestro-integridad C5 ("el seed es
// ciudadano de primera").
//
// ONE list of renderable text columns + ONE set of seed-marker patterns,
// consumed by all three C5 gates so a column added to one is automatically
// covered by the others:
//   - scripts/check-seed-hygiene.ts   (DB validator — queries live rows,
//     post-seed + __tests__/seed-hygiene.test.ts)
//   - scripts/check-seed-ids.ts       (static fence — scans seed script
//     source for writes of a marker literal into a renderable column)
//
// Principle (S5 in the plan): demo/seed content must obey the same
// invariants as production content — a funcionario cannot tell "demo" from
// "broken", so any column a citizen or operator screen renders must never
// carry an internal seed-correlation marker. Markers belong in columns that
// are never rendered (e.g. welfare_reports.seed_tag, migration 0155) or in
// id-shaped columns whose whole point IS to be a token (pets.public_token —
// PANO- is a recognizable-but-harmless credential id, not prose).

/**
 * Renderable text columns seed scripts are known to touch. `table`/`column`
 * are the live Postgres identifiers (for the DB validator); `tsKey` is the
 * Drizzle/object-literal property name the static fence greps for in seed
 * script source (camelCase, as written in `.values({ ... })` calls).
 */
export const RENDERABLE_TEXT_COLUMNS: ReadonlyArray<{
  readonly table: string;
  readonly column: string;
  readonly tsKey: string;
}> = [
  { table: "profiles", column: "display_name", tsKey: "displayName" },
  { table: "welfare_reports", column: "description", tsKey: "description" },
  { table: "pets", column: "name", tsKey: "name" },
  { table: "organizations", column: "display_name", tsKey: "displayName" },
  // notifications.title — added after the owner-notifications badge/page
  // investigation (sweep-fixes-2 2026-07-23) found the handle_new_user()
  // trigger's welcome notification carrying a wrong-cased brand literal
  // ("MiMAR" instead of canonical "miMAR") with no gate covering it. This
  // column is DB-trigger-authored, not seed-script-authored, so it is exempt
  // from check-seed-ids.ts's static fence (which only scans scripts/seed-*.ts
  // source) but IS covered by the dynamic DB validator below.
  { table: "notifications", column: "title", tsKey: "title" },
] as const;

/** Seed-marker patterns — any hit inside a renderable column is a violation. */
export const SEED_MARKER_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly regex: RegExp;
}> = [
  { name: "PANO- prefix", regex: /PANO-/ },
  { name: "-Seed- marker", regex: /-Seed-/ },
  { name: "HIST-WEL code", regex: /HIST-WEL/ },
  { name: "n-<digits> marker", regex: /\bn-\d+\b/ },
];

/** Returns the FIRST matching pattern's name, or null if `text` is clean. */
export function findSeedMarker(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const p of SEED_MARKER_PATTERNS) {
    if (p.regex.test(text)) return p.name;
  }
  return null;
}
