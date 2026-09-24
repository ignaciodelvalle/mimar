// Use-case: returnCustodyToOwner — govt/admin closes a custody_episode by
// returning the animal to its immediate former owner (the terminal
// `closed_to_owner_return` documented in
// src/modules/cases/domain/lifecycles/custody-episode.ts but, until this
// use-case, never reached by any action).
//
// Spec: docs/superpowers/specs/2026-05-19-decomiso-welfare-authority-design.md §5.1–5.3
// (the handoff family this use-case joins), PO decision 2026-07-18 (former-
// owner read access during custody — "Si se lo devuelve, nunca se le fue.").
//
// Auth: the caller runs requireDecomisoPrincipal and resolves the govt org.
// The JURISDICTIONAL fence lives here, in validateReturnCustodyToOwner,
// because only this function has the case row to fence against — see
// decomiso-jurisdiction-fence.ts for why org membership was never it
// (RA-8 R3). Returning an animal to a previous owner is an irreversible
// custody decision; a stale membership in another province's authority org
// must not authorize it.
//
// Transaction steps:
//   1. custody_transferred event (shelter_custody → owner, govt org → former
//      owner user). Same shape/reason ("return_to_original_owner") as
//      ownerAcceptReturnUseCase's org→owner transfer
//      (src/modules/return-to-owner/application/owner-accept-return.ts) —
//      that is the established precedent for this exact polymorphic shape.
//   2. REACTIVATE the former owner's SAME ended ownership row (endedAt =
//      NULL) — continuity ("nunca se le fue"), not a new insert.
//   3. Close the govt's transitional shelter_custody ownership.
//   4. Close the custody_episode (closedReason='resolved' — the DB enum for
//      cases.closed_reason is only resolved/cancelled/auto_expired; the
//      lifecycle doc's `closed_to_owner_return` is a documentation-level
//      phase distinguished by the terminal event, not a stored column value,
//      same as `closed_handoff_completed` / `closed_to_adoption` today).
//   5. Notify the returned owner.
//   6. Audit log: decomiso_returned_to_owner.
//
// Ordering note (task-requested): reactivating the former owner's row and
// closing the govt's shelter_custody row do NOT collide on the partial
// unique indexes in db/schema.ts (`ownerships_one_active_owner_per_pet` is
// scoped to role='owner' rows; `ownerships_one_active_org_shelter_custody_per_pet`
// is scoped to org-held role='shelter_custody' rows — disjoint predicates). No
// govt-custody-first ordering is required to avoid a collision; the order
// below (event → reactivate → close govt custody → close case) mirrors
// acceptDecomisoHandoffInTx's step order for parity, not for correctness.

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { auditLog, cases, type db, ownerships, petEvents, pets } from "@/db";
import type { Case } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase as libCloseCase } from "@/lib/infra/case-helpers";
// Shared former-owner derivation (docs-sync 2026-07-18 — this used to be a
// hand-copied PARALLEL implementation of getFormerOwnerReadAccess's "most-
// recently-ended ownership row" query; unified into one function so the two
// call sites can't drift). See the extensive derivation comment above
// findImmediateFormerOwnerOwnership in lib/infra/pet-access.ts.
import {
  type ImmediateFormerOwnerOwnership,
  findImmediateFormerOwnerOwnership,
} from "@/lib/infra/pet-access";

import type { GovtOrg, NewNotification } from "../domain/types";
import {
  type DecomisoActorScope,
  actorCoversCaseJurisdiction,
} from "./decomiso-jurisdiction-fence";

export type { ImmediateFormerOwnerOwnership };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReturnCustodyToOwnerInput = {
  casePublicCode: string;
};

export type ReturnCustodyToOwnerContext = {
  user: { id: string };
  govtOrg: GovtOrg;
};

/**
 * Validation context. `actor` carries the operator's GRANTED jurisdiction
 * assignments — not interchangeable with `govtOrg`, which only says which
 * authority they belong to. See decomiso-jurisdiction-fence.ts.
 */
export type ValidateReturnContext = {
  govtOrg: GovtOrg;
  actor: DecomisoActorScope;
};

type ValidateReturnOk = {
  ok: true;
  caseRow: Case;
  formerOwner: ImmediateFormerOwnerOwnership;
  petName: string;
  petPublicToken: string;
};

type ValidateReturnErr = { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pre-tx validation (runs before opening the transaction)
// ---------------------------------------------------------------------------

export async function validateReturnCustodyToOwner(
  input: ReturnCustodyToOwnerInput,
  ctx: ValidateReturnContext,
  dbInstance: typeof db,
): Promise<ValidateReturnOk | ValidateReturnErr> {
  const { govtOrg, actor } = ctx;

  const [caseRow] = await dbInstance
    .select()
    .from(cases)
    .where(eq(cases.publicCode, input.casePublicCode))
    .limit(1);
  if (!caseRow) return { ok: false, error: "Caso no encontrado." };

  // JURISDICTIONAL FENCE (RA-8 R3) — first, and with the not-found wording, for
  // the same two reasons as validateReassignDecomiso: every later check leaks a
  // fact about a case out-of-scope operators must not learn exists, and a
  // distinct "out of your jurisdiction" message is an existence oracle over the
  // national custody register.
  if (!actorCoversCaseJurisdiction(actor, caseRow)) {
    return { ok: false, error: "Caso no encontrado." };
  }

  if (caseRow.caseKind !== "custody_episode") {
    return { ok: false, error: "Este caso no es un episodio de custodia." };
  }
  if (caseRow.status !== "open") {
    return { ok: false, error: "Este caso ya no está abierto." };
  }
  if (!caseRow.primaryPetId) {
    return { ok: false, error: "Caso sin mascota asociada." };
  }

  // Must be the opening govt org — same authority scope as
  // validateReassignDecomiso (only the authority that opened the episode may
  // act on it).
  if (caseRow.openedByOrganizationId !== govtOrg.id) {
    return {
      ok: false,
      error: "Solo la autoridad que abrió el decomiso puede devolver la mascota al dueño.",
    };
  }

  // Govt must still hold ACTIVE shelter_custody on this pet. Given the case
  // is open and opened by this org, this should always be true — a
  // defensive pre-check for a clean error instead of a silent no-op UPDATE
  // inside the transaction.
  const [govtCustody] = await dbInstance
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, caseRow.primaryPetId),
        eq(ownerships.ownerOrganizationId, govtOrg.id),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (!govtCustody) {
    return {
      ok: false,
      error: "La autoridad sanitaria ya no tiene custodia activa de esta mascota.",
    };
  }

  const formerOwner = await findImmediateFormerOwnerOwnership(caseRow.primaryPetId, dbInstance);
  if (!formerOwner) {
    return {
      ok: false,
      error:
        "No se encontró un dueño anterior para devolver la mascota (¿era un animal sin dueño?).",
    };
  }

  const [pet] = await dbInstance
    .select({ name: pets.name, publicToken: pets.publicToken })
    .from(pets)
    .where(eq(pets.id, caseRow.primaryPetId))
    .limit(1);
  const petName = pet?.name ?? "el animal";
  const petPublicToken = pet?.publicToken ?? "";

  return { ok: true, caseRow, formerOwner, petName, petPublicToken };
}

// ---------------------------------------------------------------------------
// In-tx body
// ---------------------------------------------------------------------------

type TxType = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function returnCustodyToOwnerInTx(
  caseRow: { id: string; primaryPetId: string | null; publicCode: string },
  formerOwner: ImmediateFormerOwnerOwnership,
  petName: string,
  ctx: ReturnCustodyToOwnerContext,
  tx: TxType,
): Promise<{ ok: true; pendingNotifications: NewNotification[] }> {
  const now = new Date();
  const pendingNotifications: NewNotification[] = [];
  const petId = caseRow.primaryPetId as string;

  // THE PET ADVISORY LOCK (L-9) — the known gap `src/modules/rehome/README.md`
  // named as "the three decomiso writers". This return closes the govt org's
  // custody row and reopens the former owner's; a finalize or a titular's
  // withdraw takes the same `ownerships` row locks while holding this key, in
  // the opposite order — the 40P01 cycle. This function is the first call
  // inside its `db.transaction`, so this is the transaction's first statement.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${petId}))`);

  // 1. custody_transferred (shelter_custody → owner, govt org → former owner
  // user). Same shape as ownerAcceptReturnUseCase's org→owner transfer.
  const transferPayload = validateEventPayload("custody_transferred", {
    from_user_id: null,
    from_organization_id: ctx.govtOrg.id,
    to_user_id: formerOwner.ownerUserId,
    to_organization_id: null,
    from_role: "shelter_custody",
    to_role: "owner",
    reason: "return_to_original_owner",
    matched_against_pet_id: null,
    foster_ended_event_id: null,
    notes: `from_decomiso=true return_to_owner=true case=${caseRow.publicCode}`,
  });
  await tx.insert(petEvents).values({
    petId,
    eventType: "custody_transferred",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: ctx.user.id,
    authorRole: "govt",
    authorOrganizationId: ctx.govtOrg.id,
    authorVerified: true,
    payload: transferPayload,
    caseId: caseRow.id,
  });

  // 2. Reactivate the former owner's SAME ownership row (endedAt = NULL) —
  // continuity ("nunca se le fue"), not a new insert. See the file-header
  // note: no partial-unique-index collision with the govt's shelter_custody
  // row, so this can run in either order relative to step 3.
  const [reactivated] = await tx
    .update(ownerships)
    .set({ endedAt: null })
    .where(and(eq(ownerships.id, formerOwner.id), isNotNull(ownerships.endedAt)))
    .returning({ id: ownerships.id });
  if (!reactivated) {
    throw new Error(
      "No se pudo reactivar la titularidad anterior (ya estaba activa o fue modificada).",
    );
  }

  // 3. Close the govt's transitional shelter_custody ownership.
  await tx
    .update(ownerships)
    .set({ endedAt: now })
    .where(
      and(
        eq(ownerships.petId, petId),
        eq(ownerships.ownerOrganizationId, ctx.govtOrg.id),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    );

  // 4. Close the custody_episode. closedReason enum is resolved/cancelled/
  // auto_expired — 'resolved' is the successful-close value, matching every
  // other decomiso close (accept handoff, owner-accept-return).
  await libCloseCase({ caseId: caseRow.id, reason: "resolved", closedByUserId: ctx.user.id }, tx);

  // 5. Notify the returned owner.
  pendingNotifications.push({
    // no-cta: informational status update — the return already happened;
    // the recipient has nothing further to action.
    userId: formerOwner.ownerUserId,
    notificationType: "decomiso_returned_to_owner",
    severity: "success",
    title: `Mascota devuelta — ${petName}`,
    body: `Tu mascota ${petName} te fue devuelta — el proceso de custodia se cerró.`,
    relatedCaseId: caseRow.id,
    relatedPetId: petId,
  });

  // 6. Audit log.
  await tx.insert(auditLog).values({
    actorUserId: ctx.user.id,
    action: "decomiso_returned_to_owner",
    payload: {
      case_id: caseRow.id,
      case_public_code: caseRow.publicCode,
      pet_id: petId,
      govt_org_id: ctx.govtOrg.id,
      returned_owner_user_id: formerOwner.ownerUserId,
      reactivated_ownership_id: formerOwner.id,
    },
  });

  return { ok: true, pendingNotifications };
}
