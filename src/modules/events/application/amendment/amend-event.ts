// Use-case: amendEvent — strangler migration 27/61.
//
// Pure writer: receives the validated auth context (user + pet + eventAuthorship)
// and input, runs the DB operations, and returns the result.
// ACCESS is the caller's: the web shim (app/actions/amendment.ts) gates via
// requireAlivePetAccess, `/api/v1` via resolvePetHolderAccess. AUTHORSHIP is
// checked here (PO decision 3B — see amend-authorship.ts), so both doors get it
// by construction.
//
// Amendment-of-amendment is allowed (D5 edge): the action always resolves the
// original target_event_id, so the chain stays one hop from the root event.

import { createHash } from "node:crypto";

import { auditLog, db, notifications, ownerships, petEvents, profiles } from "@/db";
import { deriveBulkIdempotencyKey, insertEventIdempotent } from "@/lib/events/event-idempotency";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { classifiedTopLevelKeys } from "@/lib/events/payload-privacy";
import { ADMIN_AMENDMENT_NOTIFICATION_TYPE, isAmendableEventType } from "@/lib/infra/amendment";
import type { PetEventAuthorship } from "@/lib/infra/pet-access";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { type AmendExecutor, checkAmendAuthorship, lockAmendmentRoot } from "./amend-authorship";
import { refreshPetCacheAfterAmendment } from "./refresh-pet-cache-after-amendment";
import type { AmendEventCommand, AmendEventResult } from "./types";

/**
 * Server-derived idempotency key for an amendment (EL-F1). Deterministic in
 * (targetEventId, actorUserId, changes) so a double-click on "Corregir" that
 * fires the same correction twice dedupes at the DB unique index instead of
 * appending a second event_amended row (+ duplicate audit_log + notification).
 * Distinct corrections (different changes) still produce distinct keys and
 * append normally. No form/client change required.
 */
export function deriveAmendmentIdempotencyKey(
  targetEventId: string,
  actorUserId: string,
  changes: unknown,
): string {
  const changesHash = createHash("sha256")
    .update(JSON.stringify(changes ?? []))
    .digest("hex")
    .slice(0, 16);
  return deriveBulkIdempotencyKey(`amend:${targetEventId}:${changesHash}`, actorUserId);
}

/** Aborts the correction transaction when the locked recheck refuses. */
class AuthorshipRefusedError extends Error {}

/**
 * The BINDING authorship check: take the per-record lock, then re-read the
 * correction chain on the transaction and refuse by throwing, which rolls the
 * transaction back before anything is appended.
 */
async function assertAuthorshipUnderLock(
  tx: AmendExecutor,
  rootEventId: string,
  input: Parameters<typeof checkAmendAuthorship>[0],
): Promise<void> {
  await lockAmendmentRoot(tx, rootEventId);
  const refusal = await checkAmendAuthorship(input, tx);
  if (refusal) throw new AuthorshipRefusedError(refusal);
}

/**
 * What a failed correction transaction answers: the locked recheck's refusal is
 * a caller-facing refusal, not a server incident; anything else is.
 */
function writeFailure(err: unknown): AmendEventResult {
  if (err instanceof AuthorshipRefusedError) {
    return { ok: false, code: "authorship_refused", error: err.message };
  }
  return {
    ok: false,
    code: "write_failed",
    error: "Error al guardar la enmienda. Intentá de nuevo.",
  };
}

export async function amendEvent(
  user: { id: string },
  pet: { id: string; name: string; publicToken: string },
  eventAuthorship: PetEventAuthorship,
  input: AmendEventCommand,
): Promise<AmendEventResult> {
  const { publicToken, targetEventId, reason, changes } = input;

  // --- 2. Resolve target event + allowlist check (D4) ----------------------
  const [targetEvent] = await db
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      payload: petEvents.payload,
      authorRole: petEvents.authorRole,
      authorVerified: petEvents.authorVerified,
      recordedByUserId: petEvents.recordedByUserId,
      recordedAt: petEvents.recordedAt,
    })
    .from(petEvents)
    .where(and(eq(petEvents.id, targetEventId), eq(petEvents.petId, pet.id)))
    .limit(1);

  if (!targetEvent) {
    return { ok: false, code: "target_not_found", error: "Evento no encontrado." };
  }

  if (!isAmendableEventType(targetEvent.eventType)) {
    return {
      ok: false,
      code: "not_amendable",
      error: `El tipo de evento "${targetEvent.eventType}" no admite enmiendas.`,
    };
  }

  // --- 3. Validate changes non-empty ----------------------------------------
  if (!changes || changes.length === 0) {
    return { ok: false, code: "changes_required", error: "Debés indicar al menos un cambio." };
  }

  // --- 3b. Every changed field is a key of the target's payload -------------
  // (T3-A2b security review, item 9.) The erasure classifies a correction's
  // old/new by the TARGET's rule for that field; a field the target schema
  // does not have would carry a value no rule classifies.
  const targetKeys = classifiedTopLevelKeys(targetEvent.eventType);
  const unknownField = changes.find((c) => !targetKeys.has(c.field));
  if (unknownField) {
    return {
      ok: false,
      code: "unknown_field",
      error: `El campo "${unknownField.field}" no existe en este tipo de evento.`,
    };
  }

  // --- 4. Determine actor role + D5 sensitive path --------------------------
  // For v1 all access through requireAlivePetAccess is owner or org-shelter.
  // Admin/govt access is not yet routed through this page, but D5 is wired
  // here so when institutional actors gain pet access it works automatically.
  // We detect by checking profiles.role.
  const [profile] = await db
    .select({ role: profiles.role })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);

  const role = profile?.role ?? "owner";
  const isSensitive = role === "admin" || role === "govt";

  // --- 4b. Authorship (PO decision 3B) --------------------------------------
  // An owner corrects only what they wrote; a professional record (or one a
  // professional already corrected) only by a professional; admin/govt keep
  // the override. The target is the ROOT here: event_amended is outside the
  // allowlist, so a correction can never be the target of another.
  // This is the EARLY check — a cheap refusal before any transaction. The
  // binding one runs again inside the transaction, under a per-record lock.
  const authorshipInput = {
    userId: user.id,
    profileRole: profile?.role ?? null,
    eventAuthorship,
    petId: pet.id,
    root: {
      id: targetEvent.id,
      authorRole: targetEvent.authorRole,
      authorVerified: targetEvent.authorVerified,
      recordedByUserId: targetEvent.recordedByUserId,
      recordedAt: targetEvent.recordedAt,
    },
  };
  const authorshipRefusal = await checkAmendAuthorship(authorshipInput);
  if (authorshipRefusal) {
    return { ok: false, code: "authorship_refused", error: authorshipRefusal };
  }

  // D5: admin/govt reason is mandatory ≥5 chars.
  if (isSensitive) {
    if (!reason || reason.trim().length < 5) {
      return {
        ok: false,
        code: "reason_required",
        error:
          "El motivo es obligatorio para enmiendas de administrador/gobierno (mínimo 5 caracteres).",
      };
    }
  }

  // --- 5. Amendment-of-amendment: always reference the ORIGINAL event -------
  // If targetEvent is itself an event_amended, we follow its target_event_id
  // so the chain is always one hop from the root (auditable, not deeply nested).
  let resolvedTargetEventId = targetEvent.id;
  if (targetEvent.eventType === "event_amended") {
    const targetPayload = targetEvent.payload as Record<string, unknown>;
    if (typeof targetPayload.target_event_id === "string") {
      resolvedTargetEventId = targetPayload.target_event_id;
    }
  }

  // --- 6. Build + validate the amendment payload ----------------------------
  const rawPayload = {
    target_event_id: resolvedTargetEventId,
    reason: reason?.trim() ?? null,
    changes,
    actor_role: (role === "vet"
      ? "vet"
      : role === "admin"
        ? "admin"
        : role === "govt"
          ? "govt"
          : "owner") as "owner" | "vet" | "admin" | "govt",
    actor_user_id: user.id,
  };

  const validatedPayload = validateEventPayload("event_amended", rawPayload) as Record<
    string,
    unknown
  >;

  // --- 7. Insert the amendment event + refresh the denormalized pets cache --
  // ONE transaction: the amendment fact and the cache refresh it invalidates
  // commit together (Invariant #3 — a correction must supersede in the pets.*
  // caches too, not only in the projection read boundaries). The D5 audit +
  // notify writes join the same tx so a partial correction can never surface.
  const now = new Date();
  // EL-F1: server-derived key so an identical rapid resubmit dedupes — unless
  // the CALLER brought one. A form post has no header to carry a key, so the
  // web keeps the derived one byte for byte; `/api/v1` requires
  // `Idempotency-Key` and passes it here, because the retry that matters to a
  // phone is a resend of the same REQUEST and the derived key only knows about
  // identical CORRECTIONS. See `AmendEventCommand.clientIdempotencyKey`.
  const idempotencyKey =
    input.clientIdempotencyKey ??
    deriveAmendmentIdempotencyKey(resolvedTargetEventId, user.id, changes);
  let committed: { id: string; wasDuplicate: boolean };
  try {
    committed = await db.transaction(async (tx) => {
      // Recheck authorship UNDER A PER-RECORD LOCK (fresh-context security
      // review, 2026-09-22). The early check ran outside this transaction, and
      // the idempotency lock is keyed by actor, so a vet's correction could
      // commit between the two and be overwritten by an owner the rule no
      // longer admits. Every correction of this record takes the same lock, so
      // this read sees every correction that committed before us.
      await assertAuthorshipUnderLock(tx, resolvedTargetEventId, authorshipInput);

      // Route the append through the idempotency path (advisory lock + partial
      // unique index) instead of a raw insert (EL-F1): a double-submit with the
      // same key is a no-op that returns the original row rather than appending
      // a second event_amended (+ duplicate audit_log + notification).
      const { event: amendmentEvent, wasNoop } = await insertEventIdempotent(
        {
          petId: pet.id,
          eventType: "event_amended",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: user.id,
          authorRole: eventAuthorship.authorRole,
          authorOrganizationId: eventAuthorship.authorOrganizationId,
          authorVerified: eventAuthorship.authorVerified,
          payload: validatedPayload,
          notes: null,
          clientIdempotencyKey: idempotencyKey,
        },
        tx as Parameters<typeof insertEventIdempotent>[1],
      );

      // Identical resubmit → the amendment already exists. Skip the cache
      // refresh, audit_log and notification so the append-only log isn't
      // polluted with duplicate correction side effects.
      if (wasNoop) return { id: amendmentEvent.id, wasDuplicate: true };

      // Re-derive any pets cache column the corrected (root) event feeds. Reads
      // the full stream INCLUDING the row just inserted, so the correction is
      // already overlaid. Keyed by the root event's type — no pets.* UPDATE is
      // append-only-guarded (only pet_events is), so a plain UPDATE is fine.
      await refreshPetCacheAfterAmendment(tx, pet.id, resolvedTargetEventId);

      // --- D5 sensitive path: audit_log + notify owner ---------------------
      if (isSensitive) {
        await tx.insert(auditLog).values({
          actorUserId: user.id,
          action: "event_amended_sensitive",
          targetUserId: null,
          targetOrganizationId: null,
          payload: {
            pet_id: pet.id,
            target_event_id: resolvedTargetEventId,
            amendment_event_id: amendmentEvent.id,
            reason: reason?.trim(),
            changes,
            actor_role: rawPayload.actor_role,
          },
        });

        // Find the active owner of the pet to notify.
        const [ownerRow] = await tx
          .select({ userId: ownerships.ownerUserId })
          .from(ownerships)
          .where(
            and(
              eq(ownerships.petId, pet.id),
              eq(ownerships.role, "owner"),
              isNull(ownerships.endedAt),
            ),
          )
          .limit(1);

        if (ownerRow?.userId && ownerRow.userId !== user.id) {
          await tx.insert(notifications).values({
            userId: ownerRow.userId,
            notificationType: ADMIN_AMENDMENT_NOTIFICATION_TYPE,
            title: "Un administrador corrigió un registro de tu mascota",
            body: `Se corrigió un registro de **${pet.name}**. El original sigue visible en el historial. Motivo: ${reason?.trim() ?? "(sin especificar)"}.`,
            severity: "warning",
            ctaLabel: "Ver historial",
            ctaUrl: `/mis-mascotas/${pet.publicToken}?tab=historial`,
            relatedPetId: pet.id,
            relatedEventId: amendmentEvent.id,
          });
        }
      }

      return { id: amendmentEvent.id, wasDuplicate: false };
    });
  } catch (err) {
    return writeFailure(err);
  }

  // --- 9. Revalidate paths --------------------------------------------------
  revalidatePath(`/mis-mascotas/${publicToken}`);
  revalidatePath(`/mis-mascotas/${publicToken}/eventos/${targetEventId}`);

  return { ok: true, amendmentEventId: committed.id, wasDuplicate: committed.wasDuplicate };
}
