// Plain DTOs and value-shapes for the pets domain layer.
// Zero external imports — this file must not pull in Drizzle, Next.js, or @/db.

import type { PermanentCondition } from "@/lib/reference/permanent-conditions";

// ---------------------------------------------------------------------------
// Acquisition method (also used in form parsing)
// ---------------------------------------------------------------------------

export type AcquisitionMethod =
  | "adopted"
  | "purchased"
  | "found_stray"
  | "gift"
  | "born_in_litter"
  | "other";

// ---------------------------------------------------------------------------
// Parsed form DTO (output of parsePetForm — pure)
// ---------------------------------------------------------------------------

export type ParsedPet = {
  name: string;
  species: string;
  sex: "male" | "female" | "unknown";
  breed: string | null;
  dateOfBirth: string | null;
  birthDateIsEstimated: boolean;
  color: string | null;
  microchipId: string | null;
  microchipCountryCode: string | null;
  microchipImplantedAt: string | null;
  microchipImplantedBy: string | null;
  microchipLocation: string | null;
  estimatedWeightKg: string | null;
  favouriteFoods: string[];
  knownAllergies: string[];
  trainingLevel: "none" | "basic" | "intermediate" | "advanced" | "professional" | null;
  insuranceCompany: string | null;
  insurancePolicyNumber: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  /** Structural locality-attribution FK (migration 0147): ar_localities uuid PK.
   * Resolved at the action edge by normalizeLocationForWrite; undefined until then.
   * Optional so parsePetForm (which has no DB access) need not set it. */
  localityId?: string | null;
  /**
   * INDEC's own id for the locality row the person PICKED, straight off the
   * form (`LocationFields` writes it into a hidden `localityNameIndecId`).
   *
   * It is here because `localityId` above cannot be resolved without it: two
   * localities of one province can share a name, and the name-only lookup
   * settles that with `.orderBy(departmentName).limit(1)`. Every other door onto
   * `pets.locality_id` — the bearer registration and the mudanza — already sends
   * the id; the web alta parsed it and dropped it, so the two doors disagreed
   * about which homonym a pet belongs to (L2-8).
   */
  localityIndecId?: string | null;
  acquisitionMethod: AcquisitionMethod | null;
  emergencyInfoVisible: boolean;
  permanentConditions: PermanentCondition[];
  permanentConditionsOther: string | null;
  discloseConditionsPublicly: boolean;
  custodyKind: "owner" | "foster_in_transit";
};

// ---------------------------------------------------------------------------
// Action form state (re-homed from app/actions/pets.ts)
// ---------------------------------------------------------------------------

/**
 * The return type for create/update pet server actions.
 * Re-homed here so consumers can import from domain instead of app/actions.
 * Kept as-is for backward compatibility — WU-4 will update consumers.
 */
export type NewPetFormState = {
  error: string | null;
  /** N3 post-action navigation — client performs full-page nav (see useActionRedirect). */
  redirectTo?: string | null;
  // Present when a chip cross-check found an active match (WARN state).
  // Only relevant for acquisitionMethod='found_stray'. The UI should show the
  // conflict and offer "continue anyway" backed by forceToken.
  warning?: "CHIP_MATCH_ACTIVE";
  matchedPetToken?: string;
  forceToken?: string;
  // Soft same-owner dedupe (data-quality gate P2). Non-blocking: set when the
  // caller already has an ACTIVE owned pet with the same normalized name +
  // species + sex. The form renders an inline "¿es la misma?" confirmation and
  // lets the owner either open the existing pet or resubmit with
  // duplicateOverride=1 to create anyway.
  duplicatePrompt?: {
    name: string;
    species: string;
    sex: "male" | "female" | "unknown";
    publicToken: string;
  };
};

// ---------------------------------------------------------------------------
// Repository input types (pre-resolved at action layer)
// ---------------------------------------------------------------------------

/**
 * Input to the RegisterPet use-case.
 * Contains already-resolved values (canonical jurisdiction, normalized chip,
 * ppp flag, upload result) so the use-case stays DB-focused.
 */
export type RegisterPetInput = {
  parsed: ParsedPet;
  potentiallyDangerousBreed: boolean;
  uploadedPath: string | null;
  uploadMimeType: string | null;
  uploadSize: number | null;
  /**
   * Double-submit idempotency guard (projection-writes audit §6). Stable UUID
   * per form session, posted as a hidden field by the alta wizard. When set,
   * a re-submit that finds an existing pet_registered event with this key does
   * NOT create a second pet — it resolves to the already-created one.
   */
  clientIdempotencyKey: string | null;
};

/**
 * Input to the UpdatePet use-case.
 */
export type UpdatePetInput = {
  petId: string;
  parsed: ParsedPet;
  potentiallyDangerousBreed: boolean;
  uploadedPath: string | null;
  uploadMimeType: string | null;
  uploadSize: number | null;
};

// ---------------------------------------------------------------------------
// Use-case result + notification shapes
// ---------------------------------------------------------------------------
//
// Mirrors the adoption module's UseCaseResult / NewNotification shapes (same
// convention as foster/transfers/welfare/surveillance/organizations/events —
// every module declares its own local copy instead of importing another
// module's application layer, keeping src/modules/** an acyclic graph; see
// scripts/check-dependency-direction.ts). 2026-07-18: register-pet.ts and
// update-pet.ts used to import these from adoption/application/
// set-adoption-eligibility, which was the last thing creating the
// pets→adoption edge.

export type UseCaseResult<T> =
  | { ok: true; value?: T; notifications: NewNotification[] }
  | { ok: false; error: string };

// Minimal notification shape (matches notifications.$inferInsert).
export type NewNotification = {
  userId: string;
  notificationType: string;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "error";
  // Tab filter category for /notificaciones — see adoption's copy of this type.
  category?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  relatedPetId?: string | null;
  relatedEventId?: string | null;
};
