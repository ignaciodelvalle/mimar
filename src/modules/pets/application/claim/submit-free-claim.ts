// Use-case: submitFreeClaimForUser (variant D)
//
// Direct claim of a pet with NO active custody of any role. Opens a fresh
// owner ownership + ownership_claimed event in one tx. The pet row is locked
// (SELECT ... FOR UPDATE) so two concurrent claims on the same pet serialize
// and the second one fails the re-check.
//
// EVIDENCE GATE (audit 26-#6, pilot MED)
// -------------------------------------
// A free claim is an ownership grant. The ONLY thing that makes it legitimate
// is knowledge of the pet's PRIVATE identifier — the 15-digit microchip number
// or the tattoo code — which is NOT shown on the public credential page. The
// public token (`DIM-XXXX-XXXX`) is printed on the physical tag and resolvable
// by anyone who scans the QR, so it is NOT evidence. This writer therefore
// resolves the pet FROM the supplied identifier value against the canonical
// `pet_identifications` table and never trusts a caller-supplied pet token for
// authorization. A caller who does not know the private identifier cannot reach
// a pet: the lookup returns nothing and the claim is rejected. Mirrors the
// chip/tattoo proof the dispute path (submit-claim-dispute) already requires.

import { and, eq, isNull } from "drizzle-orm";

import { auditLog, db, notifications, ownerships, petEvents, petIdentifications, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";

import type { ClaimFailureCode, FreeClaimResult } from "./types";

// Distinguishes intentional user-facing guard failures from unexpected DB
// errors so the latter are never surfaced verbatim to the client.
//
// IT NOW CARRIES A CODE ALONGSIDE THE SENTENCE. The sentence is es-AR prose
// written for the claim wizard's error paragraph; a second door over this
// use-case (`POST /api/v1/me/pet-claims`) has to answer a status and an error
// key, and matching the prose to pick one would turn a copy edit into a silent
// change of HTTP semantics. See `ClaimFailureCode` in ./types.
class FreeClaimGuardError extends Error {
  readonly code: ClaimFailureCode;

  constructor(message: string, code: ClaimFailureCode) {
    super(message);
    this.code = code;
  }
}

const MICROCHIP_PATTERN = /^\d{15}$/;

export async function submitFreeClaimForUser(
  userId: string,
  input: {
    identifierKind: "microchip" | "tattoo";
    identifierValue: string;
  },
): Promise<FreeClaimResult> {
  const identifierValue = input.identifierValue.trim();

  // Evidence gate — the private identifier value is mandatory. An empty value
  // (or a malformed microchip) can never resolve to a pet, so reject early
  // before spending a rate-limit token or opening a transaction.
  if (!identifierValue) {
    return {
      error: "Ingresá el número de microchip o el código del tatuaje.",
      code: "identifier_invalid",
    };
  }
  if (input.identifierKind === "microchip" && !MICROCHIP_PATTERN.test(identifierValue)) {
    return {
      error: "El microchip debe tener exactamente 15 dígitos.",
      code: "identifier_invalid",
    };
  }

  // Rate limit — same key as lookup so a burst of probes counts together.
  try {
    await enforceRateLimit("claim_lookup", userId, { maxPerMinute: 30, maxPerHour: 200 });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return { error: "Demasiados intentos. Probá en unos minutos.", code: "rate_limited" };
    }
    throw err;
  }

  // Map the wizard's identifier kind to the canonical pet_identifications kind.
  const identificationKind = input.identifierKind === "microchip" ? "microchip_iso" : "tattoo";

  try {
    const claimed = await db.transaction(async (tx) => {
      // Resolve the pet FROM the private identifier — this is the evidence.
      // The active-status partial unique index guarantees at most one match.
      const [ident] = await tx
        .select({ petId: petIdentifications.petId })
        .from(petIdentifications)
        .where(
          and(
            eq(petIdentifications.kind, identificationKind),
            eq(petIdentifications.code, identifierValue),
            eq(petIdentifications.status, "active"),
          ),
        )
        .limit(1);
      if (!ident) throw new FreeClaimGuardError("No encontramos la mascota.", "not_found");

      // ART. 16: `isNull(pets.deletedAt)` IS LOAD-BEARING AND IT CLOSES TWO
      // HOLES AT ONCE, which is why it belongs here and not in a later guard.
      //
      // `pet_identifications` rows stay `status = 'active'` after an erasure, so
      // the lookup above still resolves an erased pet's chip. Without this
      // clause the writer then found the row and fell through to the status
      // guards, and the two outcomes were:
      //
      //   1. AN ORACLE. An erased pet answered `not_claimable` → 409 while an
      //      unregistered chip answered `not_found` → 404, so any self-registered
      //      account could tell "this animal was erased" from "never existed" off
      //      the status line. That is precisely the distinction art. 16 forbids,
      //      and this endpoint's own header refuses to put there.
      //   2. WORSE: an erased pet with NO active custody was CLAIMED. The writer
      //      inserted the ownership, appended `ownership_claimed` to the spine,
      //      notified and audited — and returned the animal's name and public
      //      token to the claimant — while `lookupForClaim` on the same door
      //      still answered `not_found`.
      //
      // Both die on the same clause: with the pet filtered out, `!pet` below
      // throws `not_found`, which is exactly the answer an unregistered chip
      // gets. The sibling resolver already carried this and said why —
      // `lookup-for-claim.ts` joins `isNull(pets.deletedAt)` under "erased must
      // not be distinguishable from never existed" — so this is that rule
      // applied where it was missing, not a new one derived here.
      //
      // NOT A NEW GUARD BRANCH, deliberately: a dedicated `pet_erased` refusal
      // would rebuild the oracle with better manners. There is one answer, and
      // it is the one that says nothing.
      //
      // Pre-existing, and the web's `/mis-mascotas/reclamar` wizard drives this
      // same writer, so it was live on both surfaces.
      const [pet] = await tx
        .select({
          id: pets.id,
          publicToken: pets.publicToken,
          name: pets.name,
          status: pets.status,
          inCustodyDispute: pets.inCustodyDispute,
        })
        .from(pets)
        .where(and(eq(pets.id, ident.petId), isNull(pets.deletedAt)))
        .limit(1)
        .for("update");
      if (!pet) throw new FreeClaimGuardError("No encontramos la mascota.", "not_found");
      if (pet.status === "deceased") {
        throw new FreeClaimGuardError(
          "Esta mascota figura como fallecida en miMAR.",
          "not_claimable",
        );
      }
      if (pet.status === "lost") {
        throw new FreeClaimGuardError(
          "Esta mascota figura como perdida. Si la encontraste, reportá un avistaje.",
          "not_claimable",
        );
      }
      if (pet.inCustodyDispute) {
        throw new FreeClaimGuardError(
          "Hay una disputa abierta para esta mascota.",
          "not_claimable",
        );
      }

      // Re-check inside the tx (the lookup result may be stale).
      const [activeCustody] = await tx
        .select({ id: ownerships.id })
        .from(ownerships)
        .where(and(eq(ownerships.petId, pet.id), isNull(ownerships.endedAt)))
        .limit(1);
      if (activeCustody) {
        throw new FreeClaimGuardError(
          "Esta mascota ya tiene una custodia activa. Podés iniciar una disputa.",
          "not_claimable",
        );
      }

      const now = new Date();
      await tx.insert(ownerships).values({
        petId: pet.id,
        ownerUserId: userId,
        role: "owner",
        startedAt: now,
      });

      const payload = validateEventPayload("ownership_claimed", {
        claimed_by_user_id: userId,
        identifier_kind: input.identifierKind,
      });
      await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "ownership_claimed",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: userId,
        authorRole: "owner",
        payload,
      });

      await tx.insert(notifications).values({
        userId: userId,
        notificationType: "free_pet_claimed",
        title: `${pet.name} ahora está a tu nombre`,
        body: "Registramos la mascota a tu nombre. Ya podés ver su credencial y completar su libreta sanitaria.",
        severity: "info",
        relatedPetId: pet.id,
        ctaLabel: "Ver mi mascota",
        ctaUrl: `/mis-mascotas/${pet.publicToken}`,
        category: "custody",
      });

      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "free_pet_claimed",
        payload: {
          pet_id: pet.id,
          identifier_kind: input.identifierKind,
        },
      });

      return { petToken: pet.publicToken, petName: pet.name };
    });

    return { petToken: claimed.petToken, petName: claimed.petName };
  } catch (err) {
    if (err instanceof FreeClaimGuardError) {
      return { error: err.message, code: err.code };
    }
    const message = err instanceof Error ? err.message : "Error desconocido.";
    return { error: `No se pudo completar el reclamo: ${message}`, code: "failed" };
  }
}
