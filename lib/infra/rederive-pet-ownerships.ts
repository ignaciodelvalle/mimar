// Re-derivation harness for the CARETAKER half of the `ownerships` cache.
//
// A SIBLING TO rederive-pet-cache.ts, not an extension of it (design F).
// That module answers "does this `pets` column agree with the spine?" and
// returns `Record<column, {stored, derived}>`; both of its consumers are
// written against that shape. A caretaker arrangement is not a column — it is a
// SET OF ROWS WITH A LIFECYCLE — so it gets its own shape here rather than
// distorting a working abstraction and the two things that read it.
//
// THE GAP THIS CLOSES, and the one it does NOT
// ---------------------------------------------------------------------------
// Before this file, `ownerships` had NO drift detection at all — not for
// caretaker, and not for owner / foster / shelter_custody either. That is worth
// stating plainly because it means the change proposal's success criterion
// ("drift detection is clean") would have passed VACUOUSLY: the harness had
// nothing to say about ownership rows, so it could only ever say clean.
//
// What is covered here: `role='caretaker'` rows, against
// `caretaker_designated` / `caretaker_ended`.
//
// The other four roles (owner, co_owner, shelter_custody, foster) now have their
// own full replay at the bottom of this file (`rederivePetHolderOwnerships`,
// audit K3/W8). The two sections below it are kept: the owner necessary
// condition is cheap and replay-free, and the caretaker replay keys on grants.
//
// OWNER, PARTIALLY (finding A09-5, 2026-09-22): `explainPetOwnerOwnerships`
// below checks a NECESSARY condition that needs no replay — every `owner` row's
// subject must be named somewhere on the pet's spine. It is the security
// direction of the asymmetry described next (a row nothing explains), and it
// cannot mark the corpus drifted just because the replay is incomplete: every
// live writer of an owner row puts the new owner's id on the event it appends
// in the same transaction (recorded_by_user_id for pet_registered, and
// adopter_user_id / to_user_id / claimed_by_user_id in the payload elsewhere;
// swept 2026-09-22, and 0 of 32,125 local owner rows fail it). What it does NOT
// see: a transfer that forgot to END the previous owner's row — that owner is
// named on the spine too. The one-active-owner partial unique index refuses the
// likelier form of that bug; the rest waits for the full replay.
//
// THE TWO FAILURES IT LOOKS FOR ARE NOT SYMMETRIC:
//   - a row with no event → somebody has real write access to an animal and
//     nothing in the append-only log explains why. A security fact.
//   - an event with no row → the spine says an arrangement started and the
//     caretaker cannot act. A broken promise, visible to a user.
// Neither is repairable by a later event, because corrections are new events,
// not edits — which is exactly why they have to be detected.

import { and, asc, eq, inArray } from "drizzle-orm";

import { db, ownerships, petEvents, pets } from "@/db";
import { type CaretakerInterval, replayPetCaretakers } from "@/lib/projections/pet-caretaker";
import {
  HOLDER_EVENT_TYPES,
  HOLDER_ROLES,
  type HolderEvent,
  type HolderInterval,
  orgSubject,
  replayPetHolders,
  userSubject,
} from "@/lib/projections/pet-holders";
import type { ProjectionEvent } from "@/lib/projections/types";

/** One `ownerships` row as the harness compares it. */
export type StoredCaretakerRow = {
  id: string;
  role: string;
  caretakerUserId: string | null;
  startedAt: Date;
  endedAt: Date | null;
};

export type RederivePetOwnershipsReport = {
  petId: string;
  /** Intervals replayed from the spine, in start order. */
  derived: CaretakerInterval[];
  /** Active + historical `role='caretaker'` rows, in start order. */
  stored: StoredCaretakerRow[];
  /** Human-readable mismatches. Empty means clean. */
  mismatches: string[];
};

const CARETAKER_EVENT_TYPES = ["caretaker_designated", "caretaker_ended"] as const;

/** Tolerance for comparing a row timestamp with its event timestamp. */
const TIMESTAMP_TOLERANCE_MS = 1000;

type DbOrTx = typeof db;

export async function rederivePetCaretakerOwnerships(
  petId: string,
  client: DbOrTx = db,
): Promise<RederivePetOwnershipsReport> {
  const eventRows = await client
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      recordedAt: petEvents.recordedAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(
      and(eq(petEvents.petId, petId), inArray(petEvents.eventType, [...CARETAKER_EVENT_TYPES])),
    )
    .orderBy(asc(petEvents.occurredAt), asc(petEvents.recordedAt), asc(petEvents.id));

  const derived = orderIntervals(replayPetCaretakers(eventRows as ProjectionEvent[]));

  const storedRows = await client
    .select({
      id: ownerships.id,
      role: ownerships.role,
      caretakerUserId: ownerships.ownerUserId,
      startedAt: ownerships.startedAt,
      endedAt: ownerships.endedAt,
    })
    .from(ownerships)
    .where(and(eq(ownerships.petId, petId), eq(ownerships.role, "caretaker")))
    .orderBy(asc(ownerships.startedAt), asc(ownerships.id));

  const stored = orderRows(storedRows);

  return { petId, derived, stored, mismatches: compare(derived, stored) };
}

export function hasOwnershipDrift(report: RederivePetOwnershipsReport): boolean {
  return report.mismatches.length > 0;
}

/**
 * Both sides are ordered by (startedAt, then endedAt with OPEN last).
 *
 * The `endedAt` tie-break is not decoration: two arrangements that begin in the
 * same second — a designation immediately corrected, say — would otherwise pair
 * up arbitrarily, because the two sides have no shared key to sort by (see
 * `compare`). With the tie-break, the closed one sorts first on BOTH sides.
 * Measured: without it, a fixture that accepted twice at the same instant
 * reported a false mismatch.
 */
function orderIntervals(intervals: CaretakerInterval[]): CaretakerInterval[] {
  return [...intervals].sort(
    (a, b) =>
      a.startedAt.getTime() - b.startedAt.getTime() ||
      endedRank(a.endedAt) - endedRank(b.endedAt) ||
      a.grantId.localeCompare(b.grantId),
  );
}

function orderRows(rows: StoredCaretakerRow[]): StoredCaretakerRow[] {
  return [...rows].sort(
    (a, b) =>
      a.startedAt.getTime() - b.startedAt.getTime() ||
      endedRank(a.endedAt) - endedRank(b.endedAt) ||
      a.id.localeCompare(b.id),
  );
}

/** OPEN sorts last: an arrangement still running began no earlier than a closed one. */
function endedRank(endedAt: Date | null): number {
  return endedAt === null ? Number.POSITIVE_INFINITY : endedAt.getTime();
}

/**
 * Positional comparison, in the order above.
 *
 * NOT keyed on the grant id, because the `ownerships` row does not carry one —
 * the pointer runs the other way (`pet_caretaker_grants.ownership_id`), and
 * reading the grants table here would make this harness depend on the workflow
 * table it is supposed to be able to contradict. At most one caretaker can be
 * active per pet at a time (partial unique index), so position is a sound key.
 *
 * HONEST RESIDUAL: if overlapping caretakers are ever allowed, position stops
 * being sound and this is the first function that has to change.
 */
function compare(derived: CaretakerInterval[], stored: StoredCaretakerRow[]): string[] {
  const mismatches: string[] = [];
  const max = Math.max(derived.length, stored.length);

  for (let i = 0; i < max; i++) {
    const d = derived[i];
    const s = stored[i];

    if (d && !s) {
      mismatches.push(
        `grant ${d.grantId}: caretaker_designated is in the spine but there is no ownership row — the caretaker cannot act on a pet the log says they were given`,
      );
      continue;
    }
    if (s && !d) {
      mismatches.push(
        `ownership ${s.id}: an active-or-historical caretaker row with no caretaker_designated behind it — somebody holds write access the spine does not explain`,
      );
      continue;
    }
    if (!d || !s) continue;

    if (s.caretakerUserId !== d.caretakerUserId) {
      mismatches.push(
        `ownership ${s.id}: row names ${s.caretakerUserId} but grant ${d.grantId} designated ${d.caretakerUserId}`,
      );
    }
    if (!sameInstant(s.startedAt, d.startedAt)) {
      mismatches.push(
        `ownership ${s.id}: started_at ${iso(s.startedAt)} does not match the designation at ${iso(d.startedAt)}`,
      );
    }
    if ((s.endedAt === null) !== (d.endedAt === null)) {
      mismatches.push(
        `ownership ${s.id}: ended_at ${s.endedAt === null ? "is open" : `is ${iso(s.endedAt)}`} but the spine says ${
          d.endedAt === null ? "the arrangement is still open" : `it ended at ${iso(d.endedAt)}`
        }`,
      );
    } else if (s.endedAt && d.endedAt && !sameInstant(s.endedAt, d.endedAt)) {
      mismatches.push(
        `ownership ${s.id}: ended_at ${iso(s.endedAt)} does not match caretaker_ended at ${iso(d.endedAt)}`,
      );
    }
  }

  return mismatches;
}

/**
 * Timestamps are written in the same transaction from the same `now`, so they
 * should be identical — but a tolerance keeps the harness from reporting drift
 * on a sub-second clock difference, which would be noise rather than a finding.
 */
function sameInstant(a: Date, b: Date): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= TIMESTAMP_TOLERANCE_MS;
}

function iso(value: Date | null): string {
  return value ? value.toISOString() : "null";
}

// ---------------------------------------------------------------------------
// OWNER rows — the necessary condition (finding A09-5)
// ---------------------------------------------------------------------------

/** One `role='owner'` row as the owner check sees it. */
export type StoredOwnerRow = {
  id: string;
  ownerUserId: string | null;
  ownerOrganizationId: string | null;
  endedAt: Date | null;
};

/** The spine fields that can name an owner. */
export type OwnerEvidenceEvent = {
  recordedByUserId: string | null;
  authorOrganizationId: string | null;
  payload: unknown;
};

export type ExplainPetOwnersReport = {
  petId: string;
  /** Human-readable mismatches. Empty means every owner row is explained. */
  mismatches: string[];
};

/** True when `needle` is a string value anywhere inside `value` (keys ignored). */
function payloadNames(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value === needle;
  if (Array.isArray(value)) return value.some((v) => payloadNames(v, needle));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => payloadNames(v, needle));
  }
  return false;
}

/**
 * Pure half of the owner check: each owner row's subject (a user, or an org
 * for organisational permanent custody) must be named by at least one event —
 * as its author, its authoring organisation, or a payload value.
 */
export function unexplainedOwnerRows(
  rows: StoredOwnerRow[],
  events: OwnerEvidenceEvent[],
): string[] {
  const mismatches: string[] = [];
  for (const row of rows) {
    const subject = row.ownerUserId ?? row.ownerOrganizationId;
    const state = row.endedAt === null ? "active" : "ended";
    if (subject === null) {
      mismatches.push(`ownership ${row.id}: ${state} owner row names neither a user nor an org`);
      continue;
    }
    const named = events.some(
      (e) =>
        e.recordedByUserId === subject ||
        e.authorOrganizationId === subject ||
        payloadNames(e.payload, subject),
    );
    if (!named) {
      mismatches.push(
        `ownership ${row.id}: ${state} owner row for ${subject} and no event on the spine names them — somebody holds titularidad the log does not explain`,
      );
    }
  }
  return mismatches;
}

export async function explainPetOwnerOwnerships(
  petId: string,
  client: DbOrTx = db,
): Promise<ExplainPetOwnersReport> {
  const rows = await client
    .select({
      id: ownerships.id,
      ownerUserId: ownerships.ownerUserId,
      ownerOrganizationId: ownerships.ownerOrganizationId,
      endedAt: ownerships.endedAt,
    })
    .from(ownerships)
    .where(and(eq(ownerships.petId, petId), eq(ownerships.role, "owner")))
    .orderBy(asc(ownerships.startedAt), asc(ownerships.id));
  if (rows.length === 0) return { petId, mismatches: [] };

  const events = await client
    .select({
      recordedByUserId: petEvents.recordedByUserId,
      authorOrganizationId: petEvents.authorOrganizationId,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(eq(petEvents.petId, petId));

  return { petId, mismatches: unexplainedOwnerRows(rows, events) };
}

// ---------------------------------------------------------------------------
// OWNER / CO_OWNER / SHELTER_CUSTODY / FOSTER rows — the full replay (K3/W8)
// ---------------------------------------------------------------------------
//
// The necessary condition above cannot see a transfer that forgot to END the
// previous holder, a foster row nobody closed, or an org custody row with the
// wrong ended_at. This replays every holder interval from the spine
// (lib/projections/pet-holders.ts, which documents the event → interval map)
// and compares it with the rows. DETECT ONLY: nothing here repairs, because a
// row that disagrees with the log can mean the row is wrong OR the log is
// incomplete, and only a human can tell which.
//
// SEED DATA. Seed scripts insert holder rows with no event behind them (the
// K3 audit found such shelter_custody rows only on seeded pets). A row with no
// explaining event on a pet whose `pets.seed_tag` is set is reported as
// `seed_unexplained`, not as an extra row, so real drift is not drowned. The
// marker is the column, never a token prefix or a count.

export type HolderMismatchKind =
  /** The spine opened an interval and no row carries it. */
  | "missing_row"
  /** A live row the spine does not explain: somebody holds a role nothing granted. */
  | "extra_active_row"
  /** An ended row the spine does not explain. */
  | "extra_ended_row"
  /** A row whose subject and start match an interval of a different role. */
  | "wrong_role"
  /** Matched row, but started_at disagrees with the opening event. */
  | "wrong_started_at"
  /** Matched row, but ended_at disagrees with the spine (open vs closed, or when). */
  | "wrong_ended_at"
  /** A row nothing explains on a seed-tagged pet. */
  | "seed_unexplained";

export type HolderMismatch = {
  kind: HolderMismatchKind;
  role: string;
  /** `user:<uuid>` or `org:<uuid>`. */
  subject: string;
  ownershipId: string | null;
  detail: string;
};

/** One non-caretaker `ownerships` row as the holder comparison sees it. */
export type StoredHolderRow = {
  id: string;
  role: string;
  ownerUserId: string | null;
  ownerOrganizationId: string | null;
  startedAt: Date;
  endedAt: Date | null;
};

export type RederivePetHoldersReport = {
  petId: string;
  seedTag: string | null;
  derived: HolderInterval[];
  stored: StoredHolderRow[];
  /** Empty means every holder row agrees with the spine. */
  mismatches: HolderMismatch[];
};

function rowSubject(row: StoredHolderRow): string {
  if (row.ownerOrganizationId) return orgSubject(row.ownerOrganizationId);
  return row.ownerUserId ? userSubject(row.ownerUserId) : "none";
}

function rowState(row: StoredHolderRow): string {
  return row.endedAt === null ? "live" : `ended ${iso(row.endedAt)}`;
}

function endsAgree(stored: Date | null, derived: Date | null): boolean {
  if (stored === null || derived === null) return stored === derived;
  return sameInstant(stored, derived);
}

/**
 * Pure comparison. Pairing, in order:
 *   0. same role, subject, start and end (disambiguates same-instant ties);
 *   1. same role and subject, start within tolerance (the normal case);
 *   2. same role and subject, in start order (a row whose start drifted);
 *   3. same subject and start, different role: `wrong_role`.
 * Whatever is left is a missing row (derived) or an unexplained one (stored).
 */
export function compareHolderIntervals(
  derived: HolderInterval[],
  stored: StoredHolderRow[],
  opts: { seeded: boolean },
): HolderMismatch[] {
  const mismatches: HolderMismatch[] = [];
  const freeDerived = new Set(derived);
  const freeStored = new Set(stored);

  const pair = (d: HolderInterval, s: StoredHolderRow) => {
    freeDerived.delete(d);
    freeStored.delete(s);
    if (!sameInstant(s.startedAt, d.startedAt)) {
      mismatches.push({
        kind: "wrong_started_at",
        role: s.role,
        subject: d.subject,
        ownershipId: s.id,
        detail: `ownership ${s.id}: started_at ${iso(s.startedAt)} but ${d.openedByEventType} (${d.openedByEventId}) opened it at ${iso(d.startedAt)}`,
      });
    }
    if (!endsAgree(s.endedAt, d.endedAt)) {
      mismatches.push({
        kind: "wrong_ended_at",
        role: s.role,
        subject: d.subject,
        ownershipId: s.id,
        detail: `ownership ${s.id}: ${s.role} row is ${rowState(s)} but the spine says ${
          d.endedAt === null ? "it is still live" : `it ended ${iso(d.endedAt)}`
        }`,
      });
    }
  };

  // 0. Exact matches first. Two intervals of one holder can share a start (a
  // registration and an adoption in the same instant close one and open the
  // next), and the rows come back in random id order within a tie; pairing on
  // the start alone would cross them and report two wrong_ended_at.
  for (const d of derived) {
    const s = [...freeStored].find(
      (r) =>
        r.role === d.role &&
        rowSubject(r) === d.subject &&
        sameInstant(r.startedAt, d.startedAt) &&
        endsAgree(r.endedAt, d.endedAt),
    );
    if (s) pair(d, s);
  }
  for (const d of [...freeDerived]) {
    const s = [...freeStored].find(
      (r) =>
        r.role === d.role && rowSubject(r) === d.subject && sameInstant(r.startedAt, d.startedAt),
    );
    if (s) pair(d, s);
  }
  for (const d of [...freeDerived]) {
    const s = [...freeStored].find((r) => r.role === d.role && rowSubject(r) === d.subject);
    if (s) pair(d, s);
  }
  for (const d of [...freeDerived]) {
    const s = [...freeStored].find(
      (r) => rowSubject(r) === d.subject && sameInstant(r.startedAt, d.startedAt),
    );
    if (!s) continue;
    freeDerived.delete(d);
    freeStored.delete(s);
    mismatches.push({
      kind: "wrong_role",
      role: s.role,
      subject: d.subject,
      ownershipId: s.id,
      detail: `ownership ${s.id}: row says ${s.role} but ${d.openedByEventType} (${d.openedByEventId}) opened ${d.role}`,
    });
  }

  for (const d of freeDerived) {
    mismatches.push({
      kind: "missing_row",
      role: d.role,
      subject: d.subject,
      ownershipId: null,
      detail: `${d.openedByEventType} (${d.openedByEventId}) opened ${d.role} for ${d.subject} at ${iso(d.startedAt)} and no ownership row carries it`,
    });
  }
  for (const s of freeStored) {
    let kind: HolderMismatchKind = s.endedAt === null ? "extra_active_row" : "extra_ended_row";
    if (opts.seeded) kind = "seed_unexplained";
    mismatches.push({
      kind,
      role: s.role,
      subject: rowSubject(s),
      ownershipId: s.id,
      detail: `ownership ${s.id}: ${rowState(s)} ${s.role} row for ${rowSubject(s)} and no event on the spine opens it`,
    });
  }
  return mismatches;
}

export async function rederivePetHolderOwnerships(
  petId: string,
  client: DbOrTx = db,
): Promise<RederivePetHoldersReport> {
  const [pet] = await client
    .select({ seedTag: pets.seedTag })
    .from(pets)
    .where(eq(pets.id, petId))
    .limit(1);
  const seedTag = pet?.seedTag ?? null;

  const events: HolderEvent[] = await client
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      recordedAt: petEvents.recordedAt,
      payload: petEvents.payload,
      recordedByUserId: petEvents.recordedByUserId,
      authorOrganizationId: petEvents.authorOrganizationId,
      authorRole: petEvents.authorRole,
    })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), inArray(petEvents.eventType, [...HOLDER_EVENT_TYPES])));

  const stored: StoredHolderRow[] = await client
    .select({
      id: ownerships.id,
      role: ownerships.role,
      ownerUserId: ownerships.ownerUserId,
      ownerOrganizationId: ownerships.ownerOrganizationId,
      startedAt: ownerships.startedAt,
      endedAt: ownerships.endedAt,
    })
    .from(ownerships)
    .where(and(eq(ownerships.petId, petId), inArray(ownerships.role, [...HOLDER_ROLES])))
    .orderBy(asc(ownerships.startedAt), asc(ownerships.id));

  const derived = replayPetHolders(events);
  return {
    petId,
    seedTag,
    derived,
    stored,
    mismatches: compareHolderIntervals(derived, stored, { seeded: seedTag !== null }),
  };
}
