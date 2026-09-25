// Client-input vocabulary for the service-dog designation (perro de asistencia,
// Ley 26.858) — D3, 2026-09-25.
//
// THE FOUR COMMANDS LIVE ON `POST /api/v1/pets/{publicToken}/profile`, beside
// the identity edit and the physical-tag toggle, and their schemas are part of
// `petProfileCommandInputSchema` (`./pet-profile-edit.ts`). This file holds what
// those schemas are built from: the enums the database already constrains, and
// the field rules the web form's `<input>`s imply.
//
// THE ENUMS MIRROR `db/schema.ts` (`SERVICE_DOG_TYPES`, `SERVICE_DOG_STATUSES`,
// `SERVICE_DOG_VISIBILITIES`) and cannot import it — this package is what a
// React Native app installs, and the schema module drags drizzle and postgres
// with it. `__tests__/api-v1-pet-profile-route.test.ts` asserts the two lists
// are equal, so a value added to the table's CHECK constraint without being
// added here fails a test rather than a person's save.
//
// THE REFERENCE POINTS, by symbol:
//
//   guardar datos             `upsertServiceDogAction`                    app/actions/service-dog.ts
//   solicitar verificación    `submitServiceDogVerificationRequestAction` app/actions/service-dog.ts
//   banner público            `setServiceDogVisibilityAction`             app/actions/service-dog.ts
//   retirar del servicio      `retireServiceDogAction`                    app/actions/service-dog.ts
//
// `revokeServiceDogCredentialAction` is NOT here and must not be: it is the
// admin/govt revocation (`canRevoke` inside the use-case), not something the
// owner does to their own dog.

import { z } from "zod";

import { isRealArDay } from "./ar-calendar-day.ts";

/** The six service types the table's CHECK constraint admits. */
export const SERVICE_DOG_TYPES = [
  "guia",
  "asistencia_motriz",
  "alerta_medica",
  "senal_auditiva",
  "asistencia_tea",
  "otro",
] as const;
export type ServiceDogTypeV1 = (typeof SERVICE_DOG_TYPES)[number];

/**
 * The five ANDIS categories that may render the public banner — every type but
 * `otro`, which the web form labels "sin banner público" (Res. ANDIS 2588/2022).
 */
export const SERVICE_DOG_BANNER_TYPES: readonly ServiceDogTypeV1[] = SERVICE_DOG_TYPES.filter(
  (t) => t !== "otro",
);

export const SERVICE_DOG_STATUSES = [
  "en_entrenamiento",
  "pendiente_verificacion",
  "vigente",
  "vencida",
  "revocada",
] as const;
export type ServiceDogStatusV1 = (typeof SERVICE_DOG_STATUSES)[number];

export const SERVICE_DOG_VISIBILITIES = ["full_banner", "private_only"] as const;
export type ServiceDogVisibilityV1 = (typeof SERVICE_DOG_VISIBILITIES)[number];

/**
 * Caps on the three free-text fields.
 *
 * THE WEB FORM HAS NONE, and these are set far above anything the fields are
 * for — a training centre's name, a registry number, a note — so a value a
 * person really typed on the web is not refused when carried back from the
 * phone. They exist because a JSON door, unlike an `<input>`, can be handed a
 * megabyte.
 */
export const SERVICE_DOG_TRAINING_CENTER_MAX = 300;
export const SERVICE_DOG_RUPGA_MAX = 120;
export const SERVICE_DOG_NOTES_MAX = 2000;

/**
 * An optional calendar day: `YYYY-MM-DD`, or empty/null for "none".
 *
 * The web posts `<input type="date">`'s value, which can only be a real day or
 * the empty string, and the use-case stores `value || null`. A JSON client can
 * post `2026-02-31`, which is why `isRealArDay` runs here — the same rule the
 * caretaker and record-event schemas import.
 */
export const optionalServiceDogDay = z
  .string({ error: "DATE_INVALID" })
  .trim()
  .nullable()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || (/^\d{4}-\d{2}-\d{2}$/.test(v) && isRealArDay(v)), {
    error: "DATE_INVALID",
  });

/** An optional free-text field: trimmed, blank ⇒ null, capped. */
export function optionalServiceDogText(max: number, code: string) {
  return z
    .string()
    .trim()
    .max(max, { error: code })
    .nullable()
    .transform((v) => (v ? v : null));
}
