/**
 * scripts/seed-demo-compliance-coverage.ts
 *
 * Demo coverage backfill (Wave 0 / demo-blocker B2). Closes the two metrics
 * that read 0% across all jurisdictions on the panorama/compliance surfaces:
 *
 *   1. Microchip penetration (fetchMicrochipPenetration, lib/compliance-metrics.ts)
 *      reads `pet_identifications` (kind='microchip_iso'), NOT the
 *      `microchip_implanted` events the panorama seed emits. The table was
 *      nearly empty (~16 rows) → 0% everywhere. We INSERT a microchip_iso
 *      identification for a per-province VARIED fraction of active pets so the
 *      "Outliers por provincia" table reads as real findings (some over target,
 *      some under), not a missing seed.
 *
 *   2. Rabies coverage (fetchRabiesCoverage, lib/govt-home-kpis.ts) scopes by
 *      `petEventsScopeClause`, which reads `payload->>'pet_jurisdiction_province'`.
 *      The seed's vaccination_administered events carry no province key, so the
 *      ADMIN view computes ~39% but every GOVT (province-scoped) view reads 0%.
 *      We backfill the province key onto those events from the pet's jurisdiction.
 *
 * Both operations are ADDITIVE + IDEMPOTENT (re-running inserts/updates nothing)
 * and LOCAL-DB-ONLY guarded. Wired into seed-panorama.ts so reseeds stay correct.
 */

// ---------------------------------------------------------------------------
// 1. Env bootstrap (must run before ../db is imported)
// ---------------------------------------------------------------------------

import { config as loadEnv } from "dotenv";
import { sql } from "drizzle-orm";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// ---------------------------------------------------------------------------
// 2. Safety guard — local DB only (mirrors seed-panorama.ts)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL — aborting.");
  process.exit(2);
}
const ALLOW_REMOTE = process.argv.includes("--allow-remote");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal", "::1"]);
const dbHost = DATABASE_URL.match(/^postgres(?:ql)?:\/\/[^@]+@([^:/]+)/)?.[1] ?? null;
if (process.env.NODE_ENV === "production") {
  console.error("ABORT: refusing to run in NODE_ENV=production.");
  process.exit(2);
}
if (!ALLOW_REMOTE && dbHost && !LOCAL_HOSTS.has(dbHost)) {
  console.error(
    `ABORT: target is NOT a local Postgres (host: ${dbHost}). Use --allow-remote to override.`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 3. Backfill
// ---------------------------------------------------------------------------

export async function seedDemoComplianceCoverage(database: {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<{ chipsInserted: number; rabiesBackfilled: number }> {
  // ── SEED-SCOPE INVARIANT ──────────────────────────────────────────────────
  // Seeds mutate ONLY seed-owned rows — NEVER a global predicate over user data.
  // Coverage is synthetic aggregate data for the seed's own universe: panorama
  // pets (PANO-*) + demo-scenario pets (DIM-DEMO-*). A real user pet (random
  // DIM-XXXX-XXXX token) must NEVER receive a seeded microchip identification or
  // event. An earlier unscoped `FROM pets p WHERE status='active'` sweep here
  // minted chip 858212950009440 onto a LIVE user pet during a remote re-seed,
  // corrupting its legal identifier — the reason this scope filter exists.
  // (1) Microchip identifications — per-province varied fraction of active pets.
  //     Target rate per province = 20 + hash(province) % 35  → [20%, 54%].
  //     Unique 15-digit ISO code: '858' + 4-digit mfr + 8-digit national
  //     (national from a row_number offset so codes never collide; the
  //     deterministic WHERE means a re-run selects the same pets — all now
  //     excluded by NOT EXISTS — so re-runs insert zero rows).
  const chipRes = (await database.execute(sql`
    INSERT INTO pet_identifications
      (pet_id, kind, status, code, recorded_at,
       iso_country_code, iso_manufacturer_code, iso_national_id, iso_compliant)
    SELECT s.id, 'microchip_iso', 'active', '858' || s.mfr || s.nat, s.rdate,
           '858', s.mfr, s.nat, true
    FROM (
      SELECT p.id,
             lpad((abs(hashtext(p.id::text)) % 10000)::text, 4, '0') AS mfr,
             lpad((50000000 + row_number() OVER (ORDER BY p.id))::text, 8, '0') AS nat,
             (CURRENT_DATE - ((abs(hashtext(p.id::text || 'd')) % 700)))::date AS rdate
      FROM pets p
      WHERE p.status = 'active'
        AND p.jurisdiction_province IS NOT NULL
        -- SEED SCOPE: only the seed's own pets, never live user data.
        AND (p.public_token LIKE 'PANO-%' OR p.public_token LIKE 'DIM-DEMO-%')
        AND NOT EXISTS (
          SELECT 1 FROM pet_identifications pi
          WHERE pi.pet_id = p.id AND pi.kind = 'microchip_iso' AND pi.status = 'active'
        )
        -- Invariant #3 (every view is a projection): aggregate map-coverage must
        -- NOT overwrite a pet whose microchip state is already authoritative from
        -- its event log. A storyline pet whose chip was revoked
        -- (microchip_replaced with new_chip_number=null) correctly ends with NO
        -- active canonical row, but re-chipping it here mints a canonical chip
        -- with no backing microchip_implanted event — and step (1b) below skips it
        -- because it already carries a microchip event — so the pet-cache fitness
        -- sweep rightly flags stored(code) vs derived(null) drift. Coverage is
        -- synthetic aggregate data ONLY for pets with no event-owned chip state.
        AND NOT EXISTS (
          SELECT 1 FROM pet_events e
          WHERE e.pet_id = p.id
            AND e.event_type IN ('microchip_implanted', 'microchip_replaced')
        )
        AND (abs(hashtext(p.id::text || 'chip')) % 100)
            < (20 + (abs(hashtext(p.jurisdiction_province)) % 35))
    ) s
  `)) as { rowCount?: number } | { count?: number } | unknown;

  // (1b) Matching microchip_implanted events — invariant #3: pet_identifications
  //      is a projection of the event log. Inserting only the table row (the
  //      original B2 fix) made the pet-cache fitness sweep flag every coverage
  //      chip as cache<->events drift (task 2026-07-03 #36). Payload keys match
  //      replayPetMicrochip: chip_number + implant_date_known (NOT chip_id).
  await database.execute(sql`
    INSERT INTO pet_events
      (pet_id, event_type, occurred_at, recorded_at, author_role, author_verified, payload)
    SELECT pi.pet_id, 'microchip_implanted',
           pi.recorded_at::timestamptz, pi.recorded_at::timestamptz, 'vet', true,
           jsonb_build_object(
             'source', 'DEMO-coverage',
             'chip_number', pi.code,
             'country_code', pi.iso_country_code,
             'implant_date_known', true,
             'standard', 'ISO 11784/11785'
           )
    FROM pet_identifications pi
    WHERE pi.kind = 'microchip_iso' AND pi.status = 'active'
      -- SEED SCOPE: only back seed-owned chips with events. Pre-existing
      -- microchip_iso rows on real user pets must NEVER get a synthetic event.
      AND EXISTS (
        SELECT 1 FROM pets p
        WHERE p.id = pi.pet_id
          AND (p.public_token LIKE 'PANO-%' OR p.public_token LIKE 'DIM-DEMO-%')
      )
      AND NOT EXISTS (
        SELECT 1 FROM pet_events e
        WHERE e.pet_id = pi.pet_id
          AND e.event_type IN ('microchip_implanted', 'microchip_recorded')
      )
  `);

  // (2) Rabies events — petEventsScopeClause scopes by the payload keys
  //     pet_jurisdiction_province + pet_jurisdiction_locality, which the seed's
  //     vaccination events lack → govt + province-drill views read 0%. pet_events
  //     is APPEND-ONLY (DB trigger), so we cannot backfill the keys onto existing
  //     rows; instead we INSERT new keyed rabies events for a per-province VARIED
  //     fraction of active dogs (25–54%), dated within the metric's 12-month
  //     window. Idempotent via source='DEMO-coverage'.
  const rabiesRes = (await database.execute(sql`
    INSERT INTO pet_events
      (pet_id, event_type, occurred_at, recorded_at, author_role, author_verified, payload)
    SELECT p.id, 'vaccination_administered',
           (CURRENT_DATE - ((abs(hashtext(p.id::text || 'rab')) % 330)))::timestamptz,
           (CURRENT_DATE - ((abs(hashtext(p.id::text || 'rab')) % 330)))::date,
           'owner', false,
           jsonb_build_object(
             'source', 'DEMO-coverage',
             'vaccine_name', 'antirrábica',
             'pet_jurisdiction_province', p.jurisdiction_province,
             'pet_jurisdiction_locality', p.jurisdiction_locality
           )
    FROM pets p
    WHERE p.status = 'active' AND p.species = 'dog'
      AND p.jurisdiction_province IS NOT NULL AND p.jurisdiction_locality IS NOT NULL
      -- SEED SCOPE: only the seed's own pets, never live user data.
      AND (p.public_token LIKE 'PANO-%' OR p.public_token LIKE 'DIM-DEMO-%')
      AND NOT EXISTS (
        SELECT 1 FROM pet_events pe
        WHERE pe.pet_id = p.id AND pe.event_type = 'vaccination_administered'
          AND pe.payload->>'source' = 'DEMO-coverage'
      )
      AND (abs(hashtext(p.id::text || 'rabpick')) % 100)
          < (25 + (abs(hashtext(p.jurisdiction_province)) % 30))
  `)) as { rowCount?: number } | unknown;

  // postgres-js exposes affected-row count as `.count`; node-postgres as `.rowCount`.
  const rc = (r: unknown): number => {
    if (typeof r !== "object" || r === null) return 0;
    if ("count" in r && typeof r.count === "number") return r.count;
    if ("rowCount" in r && typeof r.rowCount === "number") return r.rowCount;
    return 0;
  };
  return { chipsInserted: rc(chipRes), rabiesBackfilled: rc(rabiesRes) };
}

// ---------------------------------------------------------------------------
// 4. Standalone runner
// ---------------------------------------------------------------------------

async function main() {
  const { db } = await import("../db");
  console.log(
    "→ seeding demo compliance coverage (microchip identifications + rabies province key)…",
  );
  const { chipsInserted, rabiesBackfilled } = await seedDemoComplianceCoverage(db);
  console.log(`  microchip identifications inserted: ${chipsInserted}`);
  console.log(`  rabies events province-backfilled:  ${rabiesBackfilled}`);

  // Verify: microchip penetration + govt rabies coverage by province (top 6).
  const rows = (await db.execute(sql`
    SELECT p.jurisdiction_province AS prov,
           round(100.0 * count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM pet_identifications pi
                           WHERE pi.pet_id = p.id AND pi.kind = 'microchip_iso' AND pi.status = 'active')
           ) / nullif(count(*), 0), 1) AS chip_pct
    FROM pets p
    WHERE p.status = 'active' AND p.jurisdiction_province IS NOT NULL
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 6
  `)) as unknown as { prov: string; chip_pct: string }[];
  console.log("  microchip penetration by province (top 6):");
  for (const r of rows) console.log(`    ${r.prov}: ${r.chip_pct}%`);

  process.exit(0);
}

// Run only when invoked directly (not when imported by seed-panorama).
if (process.argv[1]?.replace(/\\/g, "/").endsWith("seed-demo-compliance-coverage.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
