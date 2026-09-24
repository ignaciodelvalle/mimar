// Use-case: replaceMicrochipForUser — strangler migration 13/61.
//
// Pure writer: receives userId + validated input, runs the DB transaction,
// and returns the result. No Next.js request context.
//
// The outer shim (app/actions/microchip.ts) gates via the Supabase session.
// Tests call replaceMicrochipForUser directly with a known userId.

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import {
  auditLog,
  db,
  notifications,
  ownerships,
  petEvents,
  petIdentifications,
  pets,
  profiles,
} from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { openCase } from "@/lib/infra/case-helpers";

import { replaceMicrochipSchema } from "./types";
import type { ReplaceMicrochipInput, ReplaceMicrochipResult } from "./types";

// ---------------------------------------------------------------------------
// Reason sets per actor kind
// ---------------------------------------------------------------------------

const OWNER_REASONS = [
  "damaged",
  "unreadable",
  "owner_request",
  "device_failure",
  "other",
] as const;

const VET_REASONS = [...OWNER_REASONS, "duplicate_detected"] as const;

const ADMIN_REASONS = [...VET_REASONS, "fraud_detected"] as const;

// new_chip_number=null (pure revocation) is only valid for these reasons.
const REVOCATION_REASONS = ["fraud_detected", "device_failure", "owner_request"] as const;

// ---------------------------------------------------------------------------
// Access refusal
// ---------------------------------------------------------------------------

/**
 * The actor-pet gate said no.
 *
 * ADDED 2026-09-08 BECAUSE THE CATCH BELOW FLATTENS EVERYTHING. Every throw in
 * the transaction became one `{ error }` string, and `POST /api/v1/pets/{token}
 * /events` answered all of them with 500 + Sentry. A sanctuary that OWNS the
 * animal resolves to `vet_in_org`, whose gate demands `shelter_custody` or
 * `foster` — a request the system refuses exactly as designed, reported as a
 * server fault and paging an engineer. A refusal is not a fault; this class is
 * what lets the caller tell them apart without matching on message text.
 */
class MicrochipAccessDeniedError extends Error {}

// ---------------------------------------------------------------------------
// Inner writer — testable without Next.js request context.
//
// The outer action (replaceMicrochipAction) gates via the Supabase session.
// Tests call replaceMicrochipForUser directly with a known userId.
// ---------------------------------------------------------------------------

export async function replaceMicrochipForUser(
  userId: string,
  rawInput: ReplaceMicrochipInput,
): Promise<ReplaceMicrochipResult> {
  let parsed: ReplaceMicrochipInput;
  try {
    parsed = replaceMicrochipSchema.parse(rawInput);
  } catch (err) {
    return {
      error: `Invalid input: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Validate allowed reasons per actor kind.
  const allowedReasons: readonly string[] =
    parsed.actorContext.kind === "owner"
      ? OWNER_REASONS
      : parsed.actorContext.kind === "vet_in_org"
        ? VET_REASONS
        : ADMIN_REASONS;

  if (!allowedReasons.includes(parsed.reason)) {
    return {
      error: `Reason '${parsed.reason}' not allowed for actor '${parsed.actorContext.kind}'.`,
    };
  }

  // Validate that pure revocation (newChipNumber=null) uses a terminal reason.
  if (
    parsed.newChipNumber === null &&
    !(REVOCATION_REASONS as readonly string[]).includes(parsed.reason)
  ) {
    return {
      error:
        "Pure revocation (newChipNumber=null) requires reason 'fraud_detected', 'device_failure', or 'owner_request'.",
    };
  }

  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];
  let result: { ok: true; eventId: string; caseId: string | null; wasDuplicate: boolean };

  try {
    result = await db.transaction(async (tx) => {
      // Load the pet.
      const [pet] = await tx.select().from(pets).where(eq(pets.id, parsed.petId)).limit(1);
      if (!pet) throw new Error("Pet not found.");

      // Actor-pet gate.
      if (parsed.actorContext.kind === "owner") {
        const [ownership] = await tx
          .select({ id: ownerships.id })
          .from(ownerships)
          .where(
            and(
              eq(ownerships.petId, pet.id),
              eq(ownerships.ownerUserId, userId),
              isNull(ownerships.endedAt),
            ),
          )
          .limit(1);
        if (!ownership)
          throw new MicrochipAccessDeniedError("No active ownership for this user on this pet.");
      } else if (parsed.actorContext.kind === "vet_in_org") {
        const [custody] = await tx
          .select({ id: ownerships.id })
          .from(ownerships)
          .where(
            and(
              eq(ownerships.petId, pet.id),
              eq(ownerships.ownerOrganizationId, parsed.actorContext.organizationId),
              isNull(ownerships.endedAt),
              inArray(ownerships.role, ["shelter_custody", "foster"]),
            ),
          )
          .limit(1);
        if (!custody)
          throw new MicrochipAccessDeniedError(
            "Organization does not hold active shelter_custody or foster on this pet.",
          );
      } else {
        // admin — verify caller actually has admin role.
        const [profile] = await tx
          .select({
            role: profiles.role,
            accountType: profiles.accountType,
            deactivatedAt: profiles.deactivatedAt,
          })
          .from(profiles)
          .where(eq(profiles.id, userId))
          .limit(1);
        if (
          !profile ||
          profile.role !== "admin" ||
          profile.accountType !== "institutional" ||
          profile.deactivatedAt !== null
        ) {
          throw new MicrochipAccessDeniedError("Caller does not have active admin role.");
        }
      }

      // Idempotency guard (projection-writes audit §6): a double-submit of the
      // replace form must not emit a second microchip_replaced event, open a
      // second remediation case, or flip canonical rows twice. The advisory
      // lock serializes concurrent same-key submits; the lookup then returns
      // the original event for the retry. Must run BEFORE openCase below.
      const idemKey = parsed.clientIdempotencyKey ?? null;
      if (idemKey) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${idemKey}))`);
        const [existingEvent] = await tx
          .select({ id: petEvents.id, caseId: petEvents.caseId })
          .from(petEvents)
          .where(
            and(
              eq(petEvents.petId, pet.id),
              eq(petEvents.eventType, "microchip_replaced"),
              eq(petEvents.clientIdempotencyKey, idemKey),
            ),
          )
          .limit(1);
        if (existingEvent) {
          // WAS `wasDuplicate`-LESS UNTIL 2026-09-08, and the caller could not
          // tell a replay from a first write. `POST /api/v1/pets/{token}/events`
          // has to answer that boolean — its contract says `true` means the key
          // resolved to an event that already existed, which is exactly this
          // branch — so the fact travels instead of being re-derived.
          return {
            ok: true,
            eventId: existingEvent.id,
            caseId: existingEvent.caseId,
            wasDuplicate: true,
          };
        }
      }

      // Cross-pet duplicate scan — only for duplicate_detected.
      // Reads from canonical pet_identifications (legacy pets.microchipId
      // writes removed in ARCH-R — scanning the legacy column would miss
      // new chips inserted after this PR).
      let secondaryPetId: string | null = null;
      if (parsed.reason === "duplicate_detected") {
        const dupes = await tx
          .select({ petId: petIdentifications.petId })
          .from(petIdentifications)
          .where(
            and(
              eq(petIdentifications.code, parsed.previousChipNumber),
              eq(petIdentifications.kind, "microchip_iso"),
              eq(petIdentifications.status, "active"),
              ne(petIdentifications.petId, pet.id),
            ),
          )
          .limit(1);
        secondaryPetId = dupes[0]?.petId ?? null;
      }

      // Open a microchip_remediation case for fraud or duplicate reasons.
      let caseId: string | null = null;
      let casePublicCode: string | null = null;
      if (parsed.reason === "fraud_detected" || parsed.reason === "duplicate_detected") {
        const caseRow = await openCase(
          {
            kind: "microchip_remediation",
            primarySubjectKind: "registered_pet",
            primaryPetId: pet.id,
            jurisdictionProvince: pet.jurisdictionProvince,
            jurisdictionLocality: pet.jurisdictionLocality,
            openedByUserId: userId,
            openedReason: {
              code: "microchip_replaced",
              reason: parsed.reason,
              // The FACT a duplicate was found. The secondary pet's UUID is
              // audit-only — it stays in the prose (as always) and cannot
              // reach the renderer.
              duplicateDetected: Boolean(secondaryPetId),
            },
            openedReasonAudit: { secondaryPetId },
          },
          tx,
        );
        caseId = caseRow.id;
        casePublicCode = caseRow.publicCode;
      }

      // Resolve authorship fields — inlined per decision (no separate helper for
      // a single action).
      //
      // authorRole maps actorContext.kind to the petEvents DB enum
      // ["owner","scanner","vet","shelter","govt","system"]. The DB enum has no
      // "admin" value; admin actors map to "govt" here (platform authority).
      // The event payload carries actor_role="admin" separately via the Zod
      // schema, which does allow it.
      const authorRole =
        parsed.actorContext.kind === "owner"
          ? ("owner" as const)
          : parsed.actorContext.kind === "vet_in_org"
            ? ("vet" as const)
            : ("govt" as const);

      const authorOrganizationId =
        parsed.actorContext.kind === "vet_in_org" ? parsed.actorContext.organizationId : null;

      // For authorVerified: vets/admins acting in an org context are considered
      // verified; owners are not. This mirrors the intake.ts pattern where
      // `organization.verified` is spread into the event.
      const authorVerified = parsed.actorContext.kind !== "owner";

      // Build and validate the event payload.
      const eventPayload = validateEventPayload("microchip_replaced", {
        previous_chip_number: parsed.previousChipNumber,
        new_chip_number: parsed.newChipNumber,
        reason: parsed.reason,
        replaced_by: parsed.replacedBy ?? null,
        replaced_at: parsed.replacedAt,
        actor_role: authorRole,
        actor_user_id: userId,
        notes: parsed.notes ?? null,
      });

      const now = new Date();

      // Insert the event row.
      const [event] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "microchip_replaced",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: userId,
          authorRole,
          authorOrganizationId,
          authorVerified,
          payload: eventPayload,
          caseId,
          // DB-level backstop: pet_events_idempotency_idx (partial unique on
          // pet_id + event_type + key) rejects a concurrent duplicate insert.
          clientIdempotencyKey: idemKey,
        })
        .returning();

      // Bump updatedAt on the pets row (legacy microchipId column write removed
      // in ARCH-R — canonical row managed via petIdentifications below).
      await tx.update(pets).set({ updatedAt: now }).where(eq(pets.id, pet.id));

      // Canonical dual-write: flip old active canonical row to 'replaced',
      // then insert the new active row (skip insert on pure revocation).
      await tx
        .update(petIdentifications)
        .set({ status: "replaced", updatedAt: now })
        .where(
          and(
            eq(petIdentifications.petId, pet.id),
            eq(petIdentifications.kind, "microchip_iso"),
            eq(petIdentifications.status, "active"),
          ),
        );

      if (parsed.newChipNumber) {
        const newChip = parsed.newChipNumber;
        await tx.insert(petIdentifications).values({
          petId: pet.id,
          kind: "microchip_iso",
          code: newChip,
          recordedAt: now.toISOString().slice(0, 10),
          recordedByUserId: userId,
          recordedByLabel: parsed.replacedBy ?? null,
          isoCountryCode: newChip.slice(0, 3),
          isoManufacturerCode: newChip.slice(3, 7),
          isoNationalId: newChip.slice(7, 15),
          isoCompliant: true,
        });
      }

      // Write audit_log row. The audit_log table has no targetPetId column;
      // pet identity is carried in the JSONB payload alongside event_id.
      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "microchip.replace",
        payload: {
          reason: parsed.reason,
          actor_context_kind: parsed.actorContext.kind,
          event_id: event.id,
          case_id: caseId,
          target_pet_id: pet.id,
        },
      });

      // Build notifications inside the tx so they share the case/event IDs,
      // but collect into pendingNotifications and insert outside the tx
      // (same pattern as intake.ts and cross-org-transfer.ts — notification
      // failure must not roll back the committed mutation).

      if (parsed.reason === "fraud_detected") {
        // Fan out to all active institutional admins.
        const admins = await tx
          .select({ id: profiles.id })
          .from(profiles)
          .where(
            and(
              eq(profiles.role, "admin"),
              eq(profiles.accountType, "institutional"),
              isNull(profiles.deactivatedAt),
            ),
          );
        for (const admin of admins) {
          pendingNotifications.push({
            userId: admin.id,
            notificationType: "microchip_fraud_detected",
            severity: "urgent",
            title: `Microchip fraud detected — ${pet.name}`,
            body: `A microchip_replaced event with reason='fraud_detected' was emitted for ${pet.name}. Review case ${caseId}.`,
            relatedPetId: pet.id,
            relatedCaseId: caseId,
            relatedEventId: event.id,
            ctaLabel: "Ver caso",
            ctaUrl: casePublicCode ? `/casos/${casePublicCode}` : "/admin/casos",
          });
        }
      }

      if (parsed.reason === "duplicate_detected" && secondaryPetId) {
        // Fan out to govt users covering the jurisdiction, falling back to admins.
        //
        // The null-jurisdiction branch used to re-implement the admin fallback
        // inline, right here, with its own copy of the role/accountType/
        // deactivatedAt predicate — a second definition of "who is a fallback
        // admin" that could drift from the resolver's. Coercing null to "" gets
        // the SAME fallback from the SAME place (2026-08-17).
        const govtOrAdminIds = await findAuthoritiesForJurisdiction(
          {
            province: pet.jurisdictionProvince ?? "",
            locality: pet.jurisdictionLocality ?? "",
          },
          { route: "microchip_duplicate_detected" },
        );

        for (const uid of govtOrAdminIds) {
          pendingNotifications.push({
            userId: uid,
            notificationType: "microchip_duplicate_detected",
            severity: "warning",
            title: `Duplicate microchip detected — ${pet.name}`,
            body: `Chip ${parsed.previousChipNumber} appears on multiple pets. Review case ${caseId}.`,
            relatedPetId: pet.id,
            relatedCaseId: caseId,
            relatedEventId: event.id,
            // Recipients are govt or admin; /casos/{code} is the shared case viewer
            // both roles can open.
            ctaLabel: "Ver caso",
            ctaUrl: casePublicCode ? `/casos/${casePublicCode}` : "/admin/casos",
          });
        }
      }

      // Heads-up to the pet owner when a vet or admin emits the event.
      if (parsed.actorContext.kind !== "owner") {
        const [ownerRow] = await tx
          .select({ ownerUserId: ownerships.ownerUserId })
          .from(ownerships)
          .where(
            and(
              eq(ownerships.petId, pet.id),
              eq(ownerships.role, "owner"),
              isNull(ownerships.endedAt),
            ),
          )
          .limit(1);

        if (ownerRow?.ownerUserId) {
          pendingNotifications.push({
            userId: ownerRow.ownerUserId,
            notificationType: "microchip_updated_by_institution",
            severity: parsed.reason === "fraud_detected" ? "urgent" : "info",
            title: `Microchip de ${pet.name} actualizado`,
            body: `Motivo: ${parsed.reason}. Si no reconocés el cambio, contactá soporte.`,
            relatedPetId: pet.id,
            relatedEventId: event.id,
            ...(caseId ? { relatedCaseId: caseId } : {}),
            ctaLabel: "Ver mascota",
            ctaUrl: `/mis-mascotas/${pet.publicToken}`,
          });
        }
      }

      return { ok: true, eventId: event.id, caseId, wasDuplicate: false };
    });
  } catch (err) {
    return {
      error: `replaceMicrochipForUser failed: ${err instanceof Error ? err.message : String(err)}`,
      ...(err instanceof MicrochipAccessDeniedError ? { denied: true } : {}),
    };
  }

  // Insert notifications outside the transaction — failure must not roll back
  // the committed mutation (D8 pattern, same as intake.ts and cross-org-transfer.ts).
  if (pendingNotifications.length > 0) {
    try {
      await db.insert(notifications).values(pendingNotifications);
    } catch (e) {
      console.error("notifications insert failed (replaceMicrochipForUser did succeed)", e);
    }
  }

  return result;
}
