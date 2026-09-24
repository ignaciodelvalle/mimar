"use server";

import { checkOccurredAtPlausible } from "@/lib/events/plausibility";
import { type SupabaseServerClient, requireAlivePetAccess } from "@/lib/infra/pet-access";
import { uploadAttachmentIfPresent } from "@/lib/infra/uploads";
import { parseDateInput } from "@/lib/utils/format";
import {
  VALID_LOCATIONS,
  createTattooForUser as _createTattooForUser,
} from "@/src/modules/pets/application/tattoo/create-tattoo";
import type { EventFormState, TattooLocation } from "@/src/modules/pets/application/tattoo/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  CreateTattooResult,
  EventFormState,
  TattooInput,
  TattooLocation,
} from "@/src/modules/pets/application/tattoo/types";

// ---------------------------------------------------------------------------
// Private helper — cleanup on failed insert (stays in shim: uses SupabaseServerClient).
// ---------------------------------------------------------------------------

async function cleanupAttachment(
  supabase: SupabaseServerClient,
  path: string | null,
): Promise<void> {
  if (!path) return;
  try {
    await supabase.storage.from("event-attachments").remove([path]);
  } catch {
    // Orphan file at worst — the row was never inserted.
  }
}

// ---------------------------------------------------------------------------
// Private helper — optional recordedAt: parse + date-only plausibility guard
// (PO decision 2026-07-16 — same family as P4 item 1 on the events edge).
// ---------------------------------------------------------------------------

function parseRecordedAt(
  raw: string,
  petDateOfBirth: string | null,
): { ok: true; recordedAt: Date | null } | { ok: false; error: string } {
  if (!raw) return { ok: true, recordedAt: null };
  const recordedAt = parseDateInput(raw);
  if (!recordedAt) return { ok: false, error: "Fecha del tatuaje inválida." };
  const plausibility = checkOccurredAtPlausible(recordedAt, petDateOfBirth);
  if (plausibility) return { ok: false, error: plausibility.error };
  return { ok: true, recordedAt };
}

// ---------------------------------------------------------------------------
// Outer server action — gates via requireAlivePetAccess, then delegates to writer.
// ---------------------------------------------------------------------------

export async function createTattooAction(
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await requireAlivePetAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { supabase, user, pet, eventAuthorship } = access;

  const code = String(formData.get("tattooCode") ?? "").trim();
  const locationRaw = String(formData.get("locationOnBody") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const recordedBy = String(formData.get("recordedBy") ?? "").trim() || null;
  const recordedAtRaw = String(formData.get("recordedAt") ?? "").trim();
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  if (!code) return { error: "Falta el código del tatuaje." };

  const location = (VALID_LOCATIONS as readonly string[]).includes(locationRaw)
    ? (locationRaw as TattooLocation)
    : null;

  const recordedAtParsed = parseRecordedAt(recordedAtRaw, pet.dateOfBirth);
  if (!recordedAtParsed.ok) return { error: recordedAtParsed.error };
  const { recordedAt } = recordedAtParsed;

  const attachmentFile = formData.get("attachment") as File | null;
  if (!attachmentFile || attachmentFile.size === 0) {
    return {
      error:
        "Subí una foto del tatuaje — es la mejor forma de que quien encuentre a tu mascota la reconozca.",
    };
  }

  // `stripMetadata: true` — EL EXIF SE VA, Y ESTA PUERTA NO LO HACIA.
  //
  // La opcion es opt-in y por defecto `false` (lib/infra/uploads.ts), y
  // `event-attachments` no esta en `PUBLIC_REENCODE_BUCKETS`, asi que hasta
  // 2026-09-10 toda foto de tatuaje cargada desde el navegador conservaba sus
  // coordenadas GPS. Una foto de tatuaje se saca en casa, y el adjunto lo
  // alcanza cualquier miembro de una organizacion con `event.write` a traves de
  // una URL firmada — o sea, el domicilio de una persona viajando adentro de un
  // registro de identificacion.
  //
  // Mismo opt-in que ya pasan las dos puertas anonimas de foto
  // (report-pet-sighting.ts:228, encontre/action.ts:275), por la misma razon.
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments", {
    stripMetadata: true,
  });
  if (upload.error) return { error: upload.error };
  if (!upload.uploadedPath) {
    return { error: "No se pudo subir la foto del tatuaje." };
  }

  const result = await _createTattooForUser(pet.id, user.id, eventAuthorship, {
    code,
    location,
    description,
    recordedAt,
    recordedBy,
    uploadedAttachment: {
      path: upload.uploadedPath,
      mimeType: upload.mimeType ?? "image/jpeg",
      size: upload.size ?? 0,
    },
    clientIdempotencyKey,
  });

  if ("error" in result) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return { error: result.error };
  }

  // Duplicate submit deduped by idempotency key — the original attachment is
  // already linked to the event; remove the redundant upload.
  if (result.wasNoop) {
    await cleanupAttachment(supabase, upload.uploadedPath);
  }

  // N3: return the destination; the form navigates (useActionRedirect).
  return { error: null, redirectTo: `/mis-mascotas/${publicToken}` };
}
