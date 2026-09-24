// Authorship gate for amendEvent — PO decision 3B (2026-09-22), hardened by the
// fresh-context security review of the same day.
//
// The RULE lives in lib/infra/amendment.ts (`amendAuthorshipRefusal`), pure, so
// the screens that decide whether to offer "Corregir" apply the same one. This
// file is the server half: it reads the facts the rule needs — who wrote the
// record, who wrote each correction already on it, and (only for legacy rows
// with no recorded author) the actor's titular-side tenures on the animal — and
// it runs INSIDE the use-case, so every door that reaches `amendEvent` (the web
// server action and `POST /api/v1/.../amend`) is gated by construction rather
// than by each caller remembering to.
//
// IT RUNS TWICE. Once before the transaction, for a cheap early refusal, and
// once INSIDE it, on the transaction's executor, after a per-record advisory
// lock (`lockAmendmentRoot`). The early read alone is a check-then-act race: a
// vet's correction committed between it and the insert would be overwritten by
// an owner who was, by then, no longer allowed to. The idempotency lock does
// not close that — its key includes the actor, so two different actors never
// serialize on it.
//
// THE CHAIN READ IS NOT CAPPED, on purpose (review item 4). It is already
// bounded by what it is — the corrections of ONE record, filtered in SQL by
// pet, type and target — which is human-scale. A `.limit()` would bound it by
// dropping rows, and the row dropped could be the one professional correction
// the gate exists to see.

import { db, ownerships, petEvents } from "@/db";
import {
  AMEND_AUTHORSHIP_REFUSAL_COPY,
  type AmendAuthorshipSubject,
  TITULAR_SIDE_HOLDER_ROLES,
  type TitularTenure,
  amendAuthorshipRefusal,
  resolveAmendActorStanding,
} from "@/lib/infra/amendment";
import type { PetEventAuthorship } from "@/lib/infra/pet-access";
import { and, eq, inArray, sql } from "drizzle-orm";

/** `db` itself or a transaction handle — both read the same way. */
export type AmendExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serialize every correction of ONE record, whoever makes it. Transaction-scoped:
 * released at commit or rollback.
 */
export async function lockAmendmentRoot(tx: AmendExecutor, rootEventId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`amend-root:${rootEventId}`}))`);
}

/** Every correction already appended to `rootEventId`, as authorship subjects. */
async function readCorrectionAuthors(
  executor: AmendExecutor,
  petId: string,
  rootEventId: string,
): Promise<AmendAuthorshipSubject[]> {
  const rows = await executor
    .select({
      authorRole: petEvents.authorRole,
      authorVerified: petEvents.authorVerified,
      recordedByUserId: petEvents.recordedByUserId,
      recordedAt: petEvents.recordedAt,
      actorRole: sql<string | null>`${petEvents.payload}->>'actor_role'`,
    })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "event_amended"),
        sql`${petEvents.payload}->>'target_event_id' = ${rootEventId}`,
      ),
    );
  return rows;
}

/**
 * The actor's titular-side ownerships of this animal, past AND present — the
 * legacy null-author rule asks whether one of them covers the row's
 * recorded_at, not whether the actor holds the animal today.
 */
export async function readTitularTenures(
  petId: string,
  userId: string,
  executor: AmendExecutor = db,
): Promise<TitularTenure[]> {
  return executor
    .select({ startedAt: ownerships.startedAt, endedAt: ownerships.endedAt })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, petId),
        eq(ownerships.ownerUserId, userId),
        inArray(ownerships.role, [...TITULAR_SIDE_HOLDER_ROLES]),
      ),
    );
}

/**
 * The es-AR refusal when this actor may not correct this record, or null.
 *
 * `root` is the ORIGINAL event (amendEvent always resolves the chain to it).
 * `executor` is `db` for the early check and the transaction for the recheck.
 */
export async function checkAmendAuthorship(
  input: {
    userId: string;
    profileRole: string | null;
    eventAuthorship: PetEventAuthorship;
    petId: string;
    root: AmendAuthorshipSubject & { id: string };
  },
  executor: AmendExecutor = db,
): Promise<string | null> {
  const standing = resolveAmendActorStanding(input.profileRole, input.eventAuthorship);
  // Override and verified professionals pass without a single read.
  if (standing === "override" || standing === "verified_professional") return null;

  const subjects: AmendAuthorshipSubject[] = [
    input.root,
    ...(await readCorrectionAuthors(executor, input.petId, input.root.id)),
  ];

  // Tenures only adjudicate a legacy owner row with no recorded author — skip
  // the read for everything else.
  const needsTenures =
    standing === "person" &&
    subjects.some((s) => s.recordedByUserId == null && s.authorRole === "owner");
  const titularTenures = needsTenures
    ? await readTitularTenures(input.petId, input.userId, executor)
    : [];

  const refusal = amendAuthorshipRefusal(
    { userId: input.userId, standing, titularTenures },
    subjects,
  );
  return refusal ? AMEND_AUTHORSHIP_REFUSAL_COPY[refusal] : null;
}
