"use server";

import { checkOccurredAtPlausible } from "@/lib/events/plausibility";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { parseDateInput } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { replaceMicrochipForUser } from "@/src/modules/pets/application/microchip/replace-microchip";

const OWNER_REASONS = new Set([
  "damaged",
  "unreadable",
  "owner_request",
  "device_failure",
  "other",
]);

const REVOCATION_REASONS = new Set(["owner_request", "device_failure"]);

export async function replaceMicrochipOwnerAction(
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const session = await requireOwnedPetByToken(publicToken);
  const { user, pet } = session;

  const reason = String(formData.get("reason") ?? "").trim();
  const newChipNumberRaw = String(formData.get("newChipNumber") ?? "").trim();
  const replacedBy = String(formData.get("replacedBy") ?? "").trim() || null;
  const replacedAtRaw = String(formData.get("replacedAt") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  if (!OWNER_REASONS.has(reason)) {
    return { error: "Motivo inválido para el rol de dueño/a." };
  }

  const newChipNumber = newChipNumberRaw || null;

  if (newChipNumber === null && !REVOCATION_REASONS.has(reason)) {
    return {
      error:
        "Para dejar la mascota sin chip, el motivo debe ser 'Solicitud del dueño' o 'Falla del dispositivo'.",
    };
  }

  if (!replacedAtRaw) return { error: "Falta la fecha del reemplazo." };
  const replacedAtDate = parseDateInput(replacedAtRaw);
  if (!replacedAtDate) return { error: "Fecha de reemplazo inválida." };
  // Date-only plausibility guard (PO decision 2026-07-16 — same family as P4
  // item 1 on the events edge): AR calendar-day compare + BEFORE_BIRTH.
  const plausibility = checkOccurredAtPlausible(replacedAtDate, pet.dateOfBirth);
  if (plausibility) return plausibility;

  // ARCH-S: legacy pets.microchipId column dropped — read from canonical.
  const canonicalIds = await fetchActiveIdentifications(pet.id);
  if (!canonicalIds.microchip) {
    return { error: "Esta mascota no tiene microchip registrado." };
  }

  const result = await replaceMicrochipForUser(user.id, {
    petId: pet.id,
    previousChipNumber: canonicalIds.microchip.code,
    newChipNumber,
    reason: reason as "damaged" | "unreadable" | "owner_request" | "device_failure" | "other",
    replacedBy,
    replacedAt: replacedAtDate.toISOString(),
    notes,
    clientIdempotencyKey,
    actorContext: { kind: "owner" },
  });

  if ("error" in result) {
    return { error: result.error };
  }

  // N3: see the org-side twin (app/org/.../microchip/reemplazar/action.ts).
  // The App Router drops a Server Action's own redirect in production, so the
  // action returns the destination and the form navigates.
  return { error: null, ok: true, redirectTo: `/mis-mascotas/${publicToken}` };
}
