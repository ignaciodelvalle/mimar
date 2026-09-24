// Projection: derive the 5-field microchip block on `pets` from the event log.
//
// The canonical microchip state is the ACTIVE `pet_identifications` row. This
// projection reconstructs that same state PURELY from events so the drift
// harness compares one model against itself (stored canonical row vs derived
// replay):
//
//   - microchip_implanted binds the chip. EARLIEST wins while a chip is active
//     ("a chip is a permanent implant — never overwrite existing chip data").
//     A second implant while one is already active is ignored; an implant AFTER
//     a revocation re-binds (active === null → free to bind again).
//   - microchip_replaced folds the lifecycle the replace writer applies to
//     pet_identifications (src/modules/pets/application/microchip/replace-microchip.ts):
//       * replacement (new_chip_number set) → the new chip becomes the active
//         canonical row. Fields mirror what the writer inserts: iso_country_code
//         = new_chip.slice(0,3); recorded_at = the replace date (event.occurredAt,
//         same instant the writer stamps); recorded_by_label = replaced_by;
//         implantation_site is not set (null).
//       * pure revocation (new_chip_number = null) → the active row is flipped to
//         'replaced' with no successor, so no chip remains active.

import type { ProjectionEvent } from "./types";

export type PetMicrochipProjection = {
  microchipId: string | null;
  microchipCountryCode: string | null;
  microchipImplantedAt: string | null;
  microchipImplantedBy: string | null;
  microchipLocation: string | null;
};

const EMPTY: PetMicrochipProjection = {
  microchipId: null,
  microchipCountryCode: null,
  microchipImplantedAt: null,
  microchipImplantedBy: null,
  microchipLocation: null,
};

export function replayPetMicrochip(events: ProjectionEvent[]): PetMicrochipProjection {
  // Fold implant + replace/revoke chronologically. `active` mirrors the single
  // active canonical row (null when no chip is active).
  let active: PetMicrochipProjection | null = null;

  for (const e of events) {
    if (e.eventType === "microchip_implanted") {
      // Earliest-wins: never overwrite a chip that is already active.
      if (active !== null) continue;
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      const chipNumber = strOrNull(payload.chip_number);
      if (!chipNumber) continue; // a chip event with no number is malformed; skip
      // implant_date_known is the flag the writers (createPetAction +
      // createMicrochipAction) use to mark whether the user actually knew the
      // implant date. When false, occurredAt defaulted to `now` (the recordedAt)
      // and is NOT a real implant date — surface null to match the canonical row.
      const dateKnown = payload.implant_date_known === true;
      active = {
        microchipId: chipNumber,
        microchipCountryCode: strOrNull(payload.country_code),
        microchipImplantedAt: dateKnown ? formatDate(e.occurredAt) : null,
        microchipImplantedBy: strOrNull(payload.implanted_by),
        microchipLocation: strOrNull(payload.location_on_body),
      };
      continue;
    }

    if (e.eventType === "microchip_replaced") {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      const newChip = strOrNull(payload.new_chip_number);
      if (!newChip) {
        // Pure revocation — old active row flipped to 'replaced', no successor.
        active = null;
        continue;
      }
      // Replacement — the new chip becomes active. Mirror the canonical row the
      // replace writer inserts so stored and derived speak one model.
      active = {
        microchipId: newChip,
        microchipCountryCode: newChip.slice(0, 3),
        microchipImplantedAt: formatDate(e.occurredAt),
        microchipImplantedBy: strOrNull(payload.replaced_by),
        microchipLocation: null,
      };
    }
  }

  return active ?? EMPTY;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function formatDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}
