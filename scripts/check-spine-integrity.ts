// Spine-integrity CI gate — enforces project invariant #3.
//
// Every pet MUST have its `pet_registered` event in the append-only event
// spine. The pets table is an operational CACHE; the spine is the record of
// fact. A pets row with no pet_registered event is a pet that, as far as the
// log is concerned, was never registered — a cache row outranking the spine,
// which is exactly what invariant #3 forbids.
//
// This is BLOCKING FROM DAY ONE, with NO grandfather baseline for existing
// rows (PO decision 2026-07-26). Deliberately unlike lint:seed-ids, which
// ratchets against scripts/seed-ids-baseline.json: a baseline here would
// legitimise precisely the drift this gate exists to stop. The 930 orphans
// present when this gate was written were fixed at the source (leaking test
// fixtures) and then purged, so the starting state is genuinely 0.
//
// THE ONE EXEMPTION — pets.seed_tag = 'perf'
// Bulk volume fixtures for performance work are inserted by the thousand and
// deliberately skip the real intake circuit; making them go through registerPet
// would defeat their purpose. The exemption is therefore:
//   * EXPLICIT — a named seed_tag value, listed in EXEMPT_SEED_TAGS below;
//   * VISIBLE  — the exempted count is always printed, including when it is 0;
//   * NARROW   — it is NOT a token-prefix LIKE. Matching on `public_token LIKE
//     'PERF-%'` would let anything that merely names itself right slip through,
//     and a token prefix is unowned: any test can mint one. seed_tag is a
//     column a writer must set on purpose (migration 0160).
// Nothing else is exempt. Test fixtures are NOT exempt — a fixture that needs a
// pet either registers it through the real circuit or cleans it up.
//
// THE SECOND ARM — orphaned rehome sponsorships (rehome-by-titular, WU4)
// ---------------------------------------------------------------------------
// A rehome sponsorship is a spine fact: `rehome_sponsorship_started` names the
// `ownerships(role='shelter_custody')` row it opened, and the arrangement runs
// until a `rehome_sponsorship_ended` with the same ownership_id lands. Every
// hand-off that closes that row writes the closing event in the same
// transaction (lib/infra/end-pet-ownerships.ts) — and explicitly refuses to
// paper over a row someone else already closed without its event, deferring
// it here. An orphan of that shape keeps REQ-16 refusing every future request
// on the pet with nothing left for the titular to withdraw, and would make the
// rollback script (design ADR-7) "end" an arrangement that ended months ago
// onto whoever holds the animal by then. Same rule as the first arm: blocking,
// no baseline, no exemption. __tests__/rehome-sponsorship-drift.test.ts plants
// both orphan shapes and proves this query sees them.
//
// WHICH DATABASE — a remote one is a skip, not an audit
// ---------------------------------------------------------------------------
// This gate counts rows, so the database it counts them in decides the answer.
// The cutover runbook leaves a shell with the staging pooler in DATABASE_URL
// (readiness doc §B4); `pnpm verify` there used to make this fence audit
// staging without saying so and fail on the 13 orphans of an old seed — half an
// hour of ghost-hunting, and a fence blamed for a database nobody chose. So a
// non-local host is a SKIP unless the operator typed --allow-remote, exactly as
// in lint:scope-authz. Shared contract: scripts/_db-target.ts.
//
// Run:  pnpm tsx scripts/check-spine-integrity.ts   (or: pnpm lint:spine)
// Exits 0 when every non-exempt pet is anchored in the spine, OR when the run
//   was skipped — DB unreachable (same as lint:locality / lint:db-budget, so a
//   DB-less CI box does not hard-fail) or a remote host without the opt-in. The
//   partition LOGIC is enforced offline by __tests__/check-spine-integrity.test.ts.
// Exits 1 listing the orphan pets, with the two ways to remediate.

import postgres from "postgres";

import {
  DEFAULT_LOCAL_URL,
  describeTarget,
  lines,
  remoteRemedy,
  remoteSkipReason,
  reportSkip as reportDbSkip,
} from "./_db-target";

/**
 * seed_tag values whose pets may legitimately lack a pet_registered event.
 * Adding a value here is a deliberate, reviewable act — keep this list tiny.
 */
export const EXEMPT_SEED_TAGS = ["perf"] as const;

export type OrphanPetRow = {
  public_token: string;
  name: string;
  seed_tag: string | null;
  created_at: Date | string;
};

export type SpinePartition = {
  /** Orphans that fail the gate. */
  blocking: OrphanPetRow[];
  /** Orphans covered by an explicit seed_tag exemption. */
  exempt: OrphanPetRow[];
};

/**
 * Pure core: split orphan pets into blocking vs explicitly exempt.
 * Extracted so the exemption rule is unit-testable without a database.
 */
export function partitionOrphans(rows: OrphanPetRow[]): SpinePartition {
  const exemptTags = new Set<string>(EXEMPT_SEED_TAGS);
  const blocking: OrphanPetRow[] = [];
  const exempt: OrphanPetRow[] = [];
  for (const row of rows) {
    // Only a real seed_tag match exempts. Never the public_token.
    if (row.seed_tag !== null && exemptTags.has(row.seed_tag)) exempt.push(row);
    else blocking.push(row);
  }
  return { blocking, exempt };
}

export type OrphanSponsorshipRow = {
  public_token: string;
  /** `payload.ownership_id` of the unmatched `rehome_sponsorship_started`. */
  ownership_id: string;
  organization_id: string;
  started_at: Date | string;
  /** `ended`: the row exists and carries ended_at. `missing`: no row has that id. */
  row_state: "ended" | "missing";
};

/**
 * Every unmatched `rehome_sponsorship_started` whose custody row is no longer
 * live. Matched on `payload.ownership_id` both ways — the started event names
 * the row, the ended event must name the same row — never on the pet's
 * owner+shelter_custody shape, which also describes a decomiso or an intake.
 * Exported so the db test can run it against planted orphans.
 */
export async function queryOrphanedSponsorships(
  sql: postgres.Sql,
): Promise<OrphanSponsorshipRow[]> {
  return sql<OrphanSponsorshipRow[]>`
    SELECT p.public_token,
           started.payload->>'ownership_id' AS ownership_id,
           started.payload->>'sponsoring_organization_id' AS organization_id,
           started.occurred_at AS started_at,
           CASE WHEN o.id IS NULL THEN 'missing' ELSE 'ended' END AS row_state
    FROM pet_events started
    JOIN pets p ON p.id = started.pet_id
    LEFT JOIN ownerships o ON o.id::text = started.payload->>'ownership_id'
    WHERE started.event_type = 'rehome_sponsorship_started'
      AND NOT EXISTS (
        SELECT 1 FROM pet_events ended
        WHERE ended.pet_id = started.pet_id
          AND ended.event_type = 'rehome_sponsorship_ended'
          AND ended.payload->>'ownership_id' = started.payload->>'ownership_id'
      )
      AND (o.id IS NULL OR o.ended_at IS NOT NULL)
    ORDER BY started.occurred_at DESC
  `;
}

/** How many offenders to print in full before summarising the rest. */
const MAX_LISTED = 20;

const SKIPPED_CHECKS =
  "  NOT run: the orphan-pet count over the spine and the orphaned-sponsorship\n" +
  "  count (the whole gate). The exemption LOGIC is still pinned offline by\n" +
  "  __tests__/check-spine-integrity.test.ts.";

export async function runCheck(argv: string[] = []): Promise<void> {
  const allowRemote = argv.includes("--allow-remote");

  const rawUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;
  const usingDefault = process.env.DATABASE_URL === undefined;
  const target = describeTarget(rawUrl);

  const remoteSkip = remoteSkipReason(target, allowRemote);
  if (remoteSkip !== null) {
    reportDbSkip({
      fence: "check-spine-integrity",
      reason: remoteSkip,
      target,
      skipped: SKIPPED_CHECKS,
      remedy: remoteRemedy("SELECTs from pets / pet_events"),
    });
    return;
  }

  const sql = postgres(rawUrl, { max: 1, connect_timeout: 5 });

  let rows: OrphanPetRow[];
  let totalPets: number;
  let orphanedSponsorships: OrphanSponsorshipRow[];
  try {
    // Every pet with no pet_registered event, exemptions included — the
    // partition happens in JS so the exempted count can be REPORTED rather
    // than filtered away invisibly in SQL.
    rows = await sql<OrphanPetRow[]>`
      SELECT p.public_token, p.name, p.seed_tag, p.created_at
      FROM pets p
      WHERE NOT EXISTS (
        SELECT 1 FROM pet_events e
        WHERE e.pet_id = p.id AND e.event_type = 'pet_registered'
      )
      ORDER BY p.created_at DESC
    `;
    const [countRow] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM pets`;
    totalPets = Number(countRow?.n ?? 0);
    orphanedSponsorships = await queryOrphanedSponsorships(sql);
  } catch (err) {
    reportDbSkip({
      fence: "check-spine-integrity",
      reason: `could not reach the database (${err instanceof Error ? err.message : String(err)}).`,
      target,
      skipped: SKIPPED_CHECKS,
      remedy: lines(
        "  Start the local stack with pnpm db:start, or set DATABASE_URL to a reachable database.",
        "  A DB-less CI box is not a failure — but this run proved nothing about the spine.",
      ),
    });
    await sql.end({ timeout: 1 }).catch(() => {});
    return;
  }
  await sql.end({ timeout: 1 }).catch(() => {});

  // The database being judged is named on EVERY exit path, pass or fail.
  const origin = usingDefault ? "default local URL" : "DATABASE_URL";
  const remoteNote = target.isLocal ? "" : " [REMOTE — --allow-remote]";
  const dbLine = `  Database: ${target.label} (from ${origin})${remoteNote}`;

  const { blocking, exempt } = partitionOrphans(rows);

  // The exempted count is printed on EVERY run, pass or fail. A fence that
  // hides what it waves through is not a fence.
  const exemptLine =
    exempt.length === 0
      ? `  Exempt (seed_tag in ${EXEMPT_SEED_TAGS.join(", ")}): 0 pet(s).`
      : `  Exempt (seed_tag in ${EXEMPT_SEED_TAGS.join(", ")}): ${exempt.length} pet(s) allowed to skip the spine.`;

  if (blocking.length > 0) {
    for (const p of blocking.slice(0, MAX_LISTED)) {
      const created = new Date(p.created_at).toISOString().slice(0, 19).replace("T", " ");
      console.error(
        `✗ ${p.public_token} ("${p.name}", created ${created}, seed_tag=${p.seed_tag ?? "null"}) has no pet_registered event.`,
      );
    }
    if (blocking.length > MAX_LISTED) {
      console.error(`  … and ${blocking.length - MAX_LISTED} more.`);
    }
    console.error(
      `\n✗ ${blocking.length} pet(s) exist only as a cache row, with no pet_registered event in the append-only spine (invariant #3).`,
    );
    console.error(
      "  If this came from a TEST: register the pet through registerPet, or delete it in afterAll —\n" +
        "  scope the delete to the ids that test created, and use withMutationOverride\n" +
        "  (__tests__/_helpers/db-overrides.ts) for the pet_events cascade.",
    );
    console.error(
      "  If this is a BULK PERF FIXTURE: set pets.seed_tag = 'perf' at insert time.\n" +
        "  Do not add a new exemption without a reviewed decision.",
    );
    // Naming the way OUT, not only the problem. This fence caught three leaks in
    // one day and each time cost a hand-written GUC transaction under a blocked
    // commit — pet_events has a BEFORE DELETE trigger, so the obvious DELETE
    // fails and the escape hatch is not discoverable from the error alone.
    console.error(
      "\n  To clear residue a PREVIOUS run left behind (local DB, known test prefixes only):\n" +
        "    pnpm tsx scripts/clean-test-orphans.ts           — lists what it would remove\n" +
        "    pnpm tsx scripts/clean-test-orphans.ts --apply   — removes it",
    );
    console.error(`\n${exemptLine}`);
    console.error(dbLine);
    process.exit(1);
  }

  if (orphanedSponsorships.length > 0) {
    for (const s of orphanedSponsorships.slice(0, MAX_LISTED)) {
      const started = new Date(s.started_at).toISOString().slice(0, 19).replace("T", " ");
      console.error(
        `✗ ${s.public_token}: rehome_sponsorship_started (${started}, org ${s.organization_id}) names custody row ${s.ownership_id}, which is ${s.row_state}, and no rehome_sponsorship_ended matches it.`,
      );
    }
    if (orphanedSponsorships.length > MAX_LISTED) {
      console.error(`  … and ${orphanedSponsorships.length - MAX_LISTED} more.`);
    }
    console.error(
      `\n✗ ${orphanedSponsorships.length} rehome sponsorship(s) still "running" on the spine over a custody row that is already closed (invariant #3).`,
    );
    console.error(
      "  Something ended the org's shelter_custody row without writing rehome_sponsorship_ended\n" +
        "  in the same transaction. Route the close through endAllLiveOwnerships\n" +
        "  (lib/infra/end-pet-ownerships.ts) or endRehomeSponsorship, and heal the row\n" +
        "  by writing the closing event for it — never by deleting the started event.",
    );
    console.error(`\n${dbLine}`);
    process.exit(1);
  }

  console.log(
    `✓ Spine integrity clean — every one of ${totalPets} pet(s) has its pet_registered event; 0 orphaned rehome sponsorship(s).`,
  );
  console.log(exemptLine);
  console.log(dbLine);
}

// Only query the DB when invoked as a CLI. Importing this module from unit
// tests must not trigger the query or process.exit.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-spine-integrity.ts") ||
    process.argv[1].endsWith("check-spine-integrity.js"));

if (isMain) {
  runCheck(process.argv.slice(2));
}
