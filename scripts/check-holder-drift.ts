// Holder-drift fence — the fourth section of scripts/detect-pet-cache-drift.ts,
// run over the whole database as a gate (invariant #3: no cache outranks the
// spine).
//
// WHAT IT CHECKS
// ---------------------------------------------------------------------------
// Every `ownerships` row of role owner / co_owner / shelter_custody / foster
// must agree with the holder intervals REPLAYED from the pet's append-only
// events (lib/projections/pet-holders.ts documents the event → interval map;
// lib/infra/rederive-pet-ownerships.ts → compareHolderIntervals pairs them).
// A row the spine does not explain means somebody holds a role nothing
// granted; an interval with no row means somebody lost a role the log says
// they still hold. Either is drift, and it fails the gate.
//
// THE ONE TOLERANCE — `seed_unexplained`
// On a pet whose pets.seed_tag is set, a row no event explains is classified
// `seed_unexplained` by the comparison itself (the marker is the column, never
// a token prefix). It is COUNTED and printed on every run, and does not fail.
// Every other mismatch kind fails — on a seeded pet too: a seed that writes
// events and rows that contradict each other is drift, not provenance. The
// seeds are consistent by construction (scripts/seed-history-utils.ts plans
// their rows, pinned against the same replay by its own tests), so a clean
// local rebuild reports 0.
//
// WHY A SET-BASED LOAD, not detect-pet-cache-drift's per-pet loop: that script
// takes an advisory lock and runs three queries per pet, which is right for an
// operator on a live database and minutes too slow for a gate over ~32k seeded
// pets. This reads the pets, their holder events and their holder rows in
// three queries and runs the SAME pure replay + comparison in memory. It is a
// gate over a quiescent database, not a concurrent audit.
//
// WHICH DATABASE — a remote one is a skip unless --allow-remote, and an
// unreachable one is a skip, exactly as lint:spine (scripts/_db-target.ts).
//
// Run:  pnpm lint:holder-drift
//   (node --conditions=react-server --import tsx scripts/check-holder-drift.ts —
//   the comparison lives next to @/db, whose `server-only` import throws under
//   plain tsx; @/db itself is never queried here.)
// Exits 0 when every holder row agrees with the spine (seed_unexplained aside),
//   or when the run was skipped.
// Exits 1 listing the drifted pets.

import postgres from "postgres";

import {
  type HolderMismatch,
  type StoredHolderRow,
  compareHolderIntervals,
} from "@/lib/infra/rederive-pet-ownerships";
import {
  HOLDER_EVENT_TYPES,
  HOLDER_ROLES,
  type HolderEvent,
  replayPetHolders,
} from "@/lib/projections/pet-holders";

import {
  DEFAULT_LOCAL_URL,
  describeTarget,
  lines,
  remoteRemedy,
  remoteSkipReason,
  reportSkip as reportDbSkip,
} from "./_db-target";

export type HolderPet = { id: string; publicToken: string; seedTag: string | null };

export type HolderDriftFinding = {
  publicToken: string;
  seedTag: string | null;
  /** Only the mismatches that fail — seed_unexplained ones are counted apart. */
  mismatches: HolderMismatch[];
};

export type HolderDriftResult = {
  scanned: number;
  blocking: HolderDriftFinding[];
  /** Pets whose only mismatches are seed_unexplained rows. */
  seedUnexplainedPets: number;
  /** Total seed_unexplained rows across all pets. */
  seedUnexplainedRows: number;
};

/**
 * Pure core: replay each pet's holder events, compare with its rows, and split
 * the mismatches into failing drift and tolerated seed_unexplained rows.
 */
export function classifyHolderDrift(
  pets: HolderPet[],
  eventsByPet: Map<string, HolderEvent[]>,
  rowsByPet: Map<string, StoredHolderRow[]>,
): HolderDriftResult {
  const blocking: HolderDriftFinding[] = [];
  let seedUnexplainedPets = 0;
  let seedUnexplainedRows = 0;
  for (const pet of pets) {
    const derived = replayPetHolders(eventsByPet.get(pet.id) ?? []);
    const stored = rowsByPet.get(pet.id) ?? [];
    const mismatches = compareHolderIntervals(derived, stored, { seeded: pet.seedTag !== null });
    if (mismatches.length === 0) continue;
    const failing = mismatches.filter((m) => m.kind !== "seed_unexplained");
    const tolerated = mismatches.length - failing.length;
    seedUnexplainedRows += tolerated;
    if (failing.length > 0) {
      blocking.push({ publicToken: pet.publicToken, seedTag: pet.seedTag, mismatches: failing });
    } else {
      seedUnexplainedPets++;
    }
  }
  return { scanned: pets.length, blocking, seedUnexplainedPets, seedUnexplainedRows };
}

function groupBy<T extends { petId: string }, U>(rows: T[], map: (row: T) => U): Map<string, U[]> {
  const out = new Map<string, U[]>();
  for (const row of rows) {
    const list = out.get(row.petId);
    if (list) list.push(map(row));
    else out.set(row.petId, [map(row)]);
  }
  return out;
}

/** How many offenders to print in full before summarising the rest. */
const MAX_LISTED = 20;

const SKIPPED_CHECKS =
  "  NOT run: the holder replay over every pet (the whole gate). The comparison\n" +
  "  LOGIC is still pinned offline by __tests__/check-holder-drift.test.ts and\n" +
  "  __tests__/rederive-pet-holders.test.ts.";

type EventRow = {
  petId: string;
  id: string;
  eventType: string;
  occurredAt: Date;
  recordedAt: Date;
  payload: unknown;
  recordedByUserId: string | null;
  authorOrganizationId: string | null;
  authorRole: string | null;
};

type OwnershipRow = StoredHolderRow & { petId: string };

export async function runCheck(argv: string[] = []): Promise<void> {
  const allowRemote = argv.includes("--allow-remote");
  const rawUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;
  const usingDefault = process.env.DATABASE_URL === undefined;
  const target = describeTarget(rawUrl);

  const remoteSkip = remoteSkipReason(target, allowRemote);
  if (remoteSkip !== null) {
    reportDbSkip({
      fence: "check-holder-drift",
      reason: remoteSkip,
      target,
      skipped: SKIPPED_CHECKS,
      remedy: remoteRemedy("SELECTs from pets / pet_events / ownerships"),
    });
    return;
  }

  const sql = postgres(rawUrl, { max: 1, connect_timeout: 5 });
  let pets: HolderPet[];
  let events: EventRow[];
  let rows: OwnershipRow[];
  try {
    pets = await sql<HolderPet[]>`
      SELECT id, public_token AS "publicToken", seed_tag AS "seedTag" FROM pets
    `;
    events = await sql<EventRow[]>`
      SELECT pet_id AS "petId", id, event_type AS "eventType",
             occurred_at AS "occurredAt", recorded_at AS "recordedAt", payload,
             recorded_by_user_id AS "recordedByUserId",
             author_organization_id AS "authorOrganizationId",
             author_role AS "authorRole"
      FROM pet_events
      WHERE event_type IN ${sql([...HOLDER_EVENT_TYPES])}
    `;
    rows = await sql<OwnershipRow[]>`
      SELECT pet_id AS "petId", id, role::text AS role,
             owner_user_id AS "ownerUserId",
             owner_organization_id AS "ownerOrganizationId",
             started_at AS "startedAt", ended_at AS "endedAt"
      FROM ownerships
      WHERE role::text IN ${sql([...HOLDER_ROLES])}
      ORDER BY started_at, id
    `;
  } catch (err) {
    reportDbSkip({
      fence: "check-holder-drift",
      reason: `could not reach the database (${err instanceof Error ? err.message : String(err)}).`,
      target,
      skipped: SKIPPED_CHECKS,
      remedy: lines(
        "  Start the local stack with pnpm db:start, or set DATABASE_URL to a reachable database.",
        "  A DB-less CI box is not a failure — but this run proved nothing about the holders.",
      ),
    });
    await sql.end({ timeout: 1 }).catch(() => {});
    return;
  }
  await sql.end({ timeout: 1 }).catch(() => {});

  const origin = usingDefault ? "default local URL" : "DATABASE_URL";
  const remoteNote = target.isLocal ? "" : " [REMOTE — --allow-remote]";
  const dbLine = `  Database: ${target.label} (from ${origin})${remoteNote}`;

  // Non-vacuity: every pet carries a pet_registered, which is a holder event.
  // Pets with none loaded means the query broke, not that the spine is empty.
  if (pets.length > 0 && events.length === 0) {
    console.error(
      `✗ check-holder-drift: ${pets.length} pet(s) but 0 holder events loaded — every pet has a pet_registered, so the event query broke and this fence would wave everything through.`,
    );
    console.error(dbLine);
    process.exit(1);
  }

  const eventsByPet = groupBy(events, ({ petId: _petId, ...e }) => e as HolderEvent);
  const rowsByPet = groupBy(rows, ({ petId: _petId, ...r }) => r as StoredHolderRow);
  const result = classifyHolderDrift(pets, eventsByPet, rowsByPet);

  const toleratedLine = `  Tolerated (seed_unexplained on seed-tagged pets): ${result.seedUnexplainedRows} row(s) on ${result.seedUnexplainedPets} pet(s) with no other mismatch.`;

  if (result.blocking.length > 0) {
    const kinds: Record<string, number> = {};
    for (const f of result.blocking) {
      for (const m of f.mismatches) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
    }
    for (const f of result.blocking.slice(0, MAX_LISTED)) {
      console.error(`✗ ${f.publicToken} (seed_tag=${f.seedTag ?? "null"}):`);
      for (const m of f.mismatches) console.error(`    ${m.kind}: ${m.detail}`);
    }
    if (result.blocking.length > MAX_LISTED) {
      console.error(`  … and ${result.blocking.length - MAX_LISTED} more pet(s).`);
    }
    console.error(
      `\n✗ ${result.blocking.length} pet(s) whose holder rows disagree with the spine (invariant #3). Kinds: ${JSON.stringify(kinds)}`,
    );
    console.error(
      "  A writer changed `ownerships` without the event that explains it, or appended the\n" +
        "  event without the row. Fix the WRITER (it must write both in one transaction); heal\n" +
        "  the data with a correcting event, never by editing the log. A seed that fails here\n" +
        "  must plan its rows from its events (scripts/seed-history-utils.ts). Per-pet detail:\n" +
        "    node --conditions=react-server --import tsx scripts/detect-pet-cache-drift.ts --pet <token>",
    );
    console.error(`\n${toleratedLine}`);
    console.error(dbLine);
    process.exit(1);
  }

  console.log(
    `✓ Holder rows agree with the spine — ${result.scanned} pet(s), ${events.length} holder event(s), ${rows.length} holder row(s) replayed and compared.`,
  );
  console.log(toleratedLine);
  console.log(dbLine);
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-holder-drift.ts") ||
    process.argv[1].endsWith("check-holder-drift.js"));

if (isMain) {
  runCheck(process.argv.slice(2));
}
