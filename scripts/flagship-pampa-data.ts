/**
 * Pampa (DIM-PAMP-0001) — the flagship pet's facts, as pure data.
 *
 * ONE source for two readers:
 *   - scripts/seed-flagship-pampa.ts writes these facts into a database;
 *   - components/landing/landing-content.ts tells Pampa's story on the public
 *     landing, whose hero QR resolves to the pet that seed creates.
 *
 * Before this module the landing kept its own copy of the story, and the two
 * drifted: the landing named a vet the seed never created, showed a libreta
 * row the seed cannot keep, and alerted neighbours the product never alerts.
 * Every Pampa fact the landing shows must come from here —
 * __tests__/flagship-pampa-consistency.test.ts fences it.
 *
 * PURE ON PURPOSE: no imports at all (no DB, no env, no node:*). The landing
 * bundles this file into the browser, and the seed reads it before its env
 * bootstrap. Changing a fact here changes what the NEXT seed run writes; it
 * never rewrites a database that was already seeded (the libreta is
 * append-only and the seed skips a pet that already has events).
 */

export const PAMPA_TOKEN = "DIM-PAMP-0001";

/** ISO 11784 15-digit chip: 941 (country) · 0001 (manufacturer) · 00000001. */
export const PAMPA_CHIP = "941000100000001";

export const OWNER_EMAIL = "owner@dim.test";
/**
 * The owner's display name. It used to be "Dueño Demo CABA", so the public
 * credential the hero QR opens read "Lo busca Dueño" while the landing told
 * the story of Martín (PO, 2026-09-25). Changing it here only affects the NEXT
 * seed run on a fresh database: an environment that was already seeded keeps
 * its profile until someone renames it by hand — never by re-running a seed.
 */
export const OWNER_NAME = "Martín";

export const VET_EMAIL = "lilian@dim.test";
export const VET_NAME = "Dra. Lilian Marrone";
export const VET_LICENSE = "V-99001-CABA";
export const VET_LICENSE_JURISDICTION = "CABA";
export const VET_CLINIC = "Veterinaria Belgrano";

/** The pet row as the seed inserts it. */
export const PAMPA_PET = {
  publicToken: PAMPA_TOKEN,
  species: "dog",
  breed: "Caniche",
  name: "Pampa",
  sex: "female",
  dateOfBirth: "2021-11-20",
  birthDateIsEstimated: true,
  color: "blanco",
  status: "active",
  acquisitionMethod: "adopted",
  jurisdictionCountry: "AR",
  jurisdictionProvince: "CABA",
  jurisdictionLocality: "Belgrano",
} as const;

export type PampaAuthorRole = "owner" | "vet" | "shelter" | "scanner";

export type PampaSeedEvent = {
  /** Calendar date (YYYY-MM-DD); the seed stores it at 12:00 UTC. */
  date: string;
  eventType: string;
  authorRole: PampaAuthorRole;
  authorVerified: boolean;
  payload: Record<string, unknown>;
};

/**
 * Pampa's libreta, oldest first, in the canonical payload shapes of
 * lib/events/event-schemas.ts. Vet-authored entries are signed by VET_NAME
 * (the seed records them under that account).
 */
export const PAMPA_EVENTS: readonly PampaSeedEvent[] = [
  // 2022-03 — Alta en el registro (Martín · dueño)
  {
    date: "2022-03-14",
    eventType: "pet_registered",
    authorRole: "owner",
    authorVerified: false,
    payload: {
      name: PAMPA_PET.name,
      species: PAMPA_PET.species,
      sex: PAMPA_PET.sex,
      breed: PAMPA_PET.breed,
      date_of_birth: PAMPA_PET.dateOfBirth,
      birth_date_is_estimated: PAMPA_PET.birthDateIsEstimated,
      color: PAMPA_PET.color,
      acquisition_method: PAMPA_PET.acquisitionMethod,
      has_photo: true,
      has_microchip: false,
    },
  },
  // 2022-04 — Microchip implantado (Dra. Marrone · vet)
  {
    date: "2022-04-05",
    eventType: "microchip_implanted",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      chip_number: PAMPA_CHIP,
      country_code: "941",
      implanted_by: VET_CLINIC,
      location_on_body: "interescapular",
      implant_date_known: true,
    },
  },
  // 2022-04 — Vacunación antirrábica (Dra. Marrone · vet)
  {
    date: "2022-04-12",
    eventType: "vaccination_administered",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      vaccine_name: "Antirrábica",
      brand: "Rabisin",
      batch: "AR-2214",
      administered_by: VET_CLINIC,
      next_due_at: "2023-04-12",
    },
  },
  // 2023-02 — Castración (Dra. Marrone · vet)
  {
    date: "2023-02-18",
    eventType: "sterilization_performed",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      procedure: "spay",
      performed_by: VET_CLINIC,
      clinic: VET_CLINIC,
    },
  },
  // 2024-03 — Reportada perdida (Martín · dueño)
  {
    date: "2024-03-09",
    eventType: "status_changed",
    authorRole: "owner",
    authorVerified: false,
    payload: {
      from_status: "active",
      to_status: "lost",
      location_description: "Barrancas de Belgrano, CABA",
      reason: null,
      disclosure_prefs_snapshot: {
        first_name: true,
        phone: true,
        email: false,
        last_location: true,
        finder_form: true,
      },
      lost_description: {
        accessories_when_lost: "Collar celeste con chapita",
        behavior_notes: null,
        last_seen_context: "Se soltó en la plaza durante un paseo",
      },
    },
  },
  // 2024-03 — Credencial escaneada (anónimo · vía QR). The seed writes it; the
  // landing's libreta does NOT show it — scanner-role scans are purged after
  // 90 days (lib/infra/scan-retention.ts), so a libreta row would promise a
  // permanence the product does not keep.
  {
    date: "2024-03-10",
    eventType: "credential_scanned",
    authorRole: "scanner",
    authorVerified: false,
    payload: { is_self_scan: false, viewer_authenticated: false },
  },
  // 2024-03 — Ingresó a un refugio (refugio · org)
  {
    date: "2024-03-11",
    eventType: "shelter_intake_recorded",
    authorRole: "shelter",
    authorVerified: false,
    payload: {
      intake_reason: "stray_found",
      intake_condition: "Sana, con chip verificado",
      rescue_jurisdiction: "CABA",
    },
  },
  // 2024-03 — Volvió a casa (Martín · dueño — the owner, not the shelter)
  {
    date: "2024-03-13",
    eventType: "status_changed",
    authorRole: "owner",
    authorVerified: false,
    payload: {
      from_status: "lost",
      to_status: "active",
      reason: "returned_to_owner",
    },
  },
  // 2024-08 — Diagnóstico registrado (Dra. Marrone · vet)
  {
    date: "2024-08-20",
    eventType: "clinical_info_logged",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      sub_kind: "other",
      title: "Dermatitis atópica",
      details: "Plan de tratamiento y control estacional",
      performed_by: VET_CLINIC,
    },
  },
  // 2026-06 — Antirrábica at the Comuna 13 campaign, signed by Dra. Marrone —
  // the LATEST dose, which drives "verificada" + al día. The rabies vaccine
  // had lapsed from 2023-04-12 until this dose.
  {
    date: "2026-06-15",
    eventType: "vaccination_administered",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      vaccine_name: "Antirrábica",
      brand: "Nobivac Rabies",
      batch: "CAMP-C13-2026",
      administered_by: "Campaña antirrábica · Comuna 13",
      next_due_at: "2027-06-15",
    },
  },
];

/**
 * The events the seed inserts, plus who each author role is recorded as.
 * The shelter entry is recorded under the owner's account: the public
 * credential needs no org row, so the seed creates none.
 */
export function buildPampaLibreta(
  ownerId: string,
  vetId: string,
): {
  events: PampaSeedEvent[];
  recordedBy: Record<PampaAuthorRole, string | null>;
} {
  return {
    events: PAMPA_EVENTS.map((e) => ({ ...e })),
    recordedBy: {
      owner: ownerId,
      vet: vetId,
      shelter: ownerId,
      scanner: null,
    },
  };
}
