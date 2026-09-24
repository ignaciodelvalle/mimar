"use server";

import { db, pets } from "@/db";
import { checkOccurredAtPlausible } from "@/lib/events/plausibility";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { parseDateInput } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { replaceMicrochipForUser } from "@/src/modules/pets/application/microchip/replace-microchip";
import { and, eq, isNull } from "drizzle-orm";

const ADMIN_REASONS = new Set([
  "damaged",
  "unreadable",
  "owner_request",
  "device_failure",
  "other",
  "duplicate_detected",
  "fraud_detected",
]);

const REVOCATION_REASONS = new Set(["owner_request", "device_failure", "fraud_detected"]);

export async function replaceMicrochipAdminAction(
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const { user } = await requireAdminOrRedirect();

  // Art. 16 (Ley 25.326) — the WRITE twin of the page's read guard, and the
  // half that actually matters: the page can stop OFFERING the form, but this
  // action is hand-POSTable with a token alone. Same reasoning as the page —
  // token-addressed, no state record about this pet mediating the access, so no
  // welfare/health nexus to carve out (contrast `loadGobPetSubView`, which is
  // unfiltered because an in-jurisdiction report or case is what gets it there).
  // Erasure releases the pet's chip, so before this term the refusal came from
  // `!canonicalIds.microchip` — a side effect of another invariant, with the
  // wrong copy: "deleted" must read as "never existed", not as "has no chip".
  const [pet] = await db
    // dateOfBirth feeds the plausibility guard's BEFORE_BIRTH leg below.
    .select({ id: pets.id, dateOfBirth: pets.dateOfBirth })
    .from(pets)
    .where(and(eq(pets.publicToken, publicToken), isNull(pets.deletedAt)))
    .limit(1);
  if (!pet) return { error: "Mascota no encontrada." };

  // ARCH-S: legacy pets.microchipId column dropped — read from canonical.
  const canonicalIds = await fetchActiveIdentifications(pet.id);
  if (!canonicalIds.microchip) {
    return { error: "Esta mascota no tiene microchip registrado." };
  }

  const reason = String(formData.get("reason") ?? "").trim();
  const newChipNumberRaw = String(formData.get("newChipNumber") ?? "").trim();
  const replacedBy = String(formData.get("replacedBy") ?? "").trim() || null;
  const replacedAtRaw = String(formData.get("replacedAt") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  if (!ADMIN_REASONS.has(reason)) {
    return { error: "Motivo inválido." };
  }

  if (reason === "fraud_detected" && !notes) {
    return {
      error:
        "Las acciones por fraude requieren una nota que justifique la decisión (pista de auditoría).",
    };
  }

  const newChipNumber = newChipNumberRaw || null;

  if (newChipNumber === null && !REVOCATION_REASONS.has(reason)) {
    return {
      error:
        "Para dejar la mascota sin chip, el motivo debe ser 'Fraude detectado', 'Solicitud del dueño' o 'Falla del dispositivo'.",
    };
  }

  if (!replacedAtRaw) return { error: "Falta la fecha del reemplazo." };
  const replacedAtDate = parseDateInput(replacedAtRaw);
  if (!replacedAtDate) return { error: "Fecha de reemplazo inválida." };
  // Date-only plausibility guard (PO decision 2026-07-16 — same family as P4
  // item 1 on the events edge): AR calendar-day compare + BEFORE_BIRTH.
  const plausibility = checkOccurredAtPlausible(replacedAtDate, pet.dateOfBirth);
  if (plausibility) return plausibility;

  const result = await replaceMicrochipForUser(user.id, {
    petId: pet.id,
    previousChipNumber: canonicalIds.microchip.code,
    newChipNumber,
    reason: reason as
      | "damaged"
      | "unreadable"
      | "owner_request"
      | "device_failure"
      | "other"
      | "duplicate_detected"
      | "fraud_detected",
    replacedBy,
    replacedAt: replacedAtDate.toISOString(),
    notes,
    clientIdempotencyKey,
    actorContext: { kind: "admin" },
  });

  if ("error" in result) {
    return { error: result.error };
  }

  // N3: see the org-side twin (app/org/.../microchip/reemplazar/action.ts).
  // The App Router drops a Server Action's own redirect in production, so the
  // action returns the destination and the form navigates.
  return { error: null, ok: true, redirectTo: "/admin/observaciones" };
}
