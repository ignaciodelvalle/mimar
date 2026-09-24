// Plain DTOs and value-shapes for the adoption domain layer.
// Zero external imports — this file must not pull in Drizzle, Next.js, or @/db.

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export const INELIGIBLE_REASONS = [
  "medical_treatment",
  "behavioral_evaluation",
  "recovery",
  "quarantine",
  "legal_hold",
  "age",
  "pending_intake_eval",
  "other",
] as const;

export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type EligibilityInput = {
  eligible: boolean;
  ineligibleReason?: IneligibleReason | null;
  ineligibleReasonNotes?: string | null;
  ineligibleUntilIso?: string | null;
};

// ---------------------------------------------------------------------------
// Listing status
// ---------------------------------------------------------------------------

export type ListingStatusAction = "publish" | "pause" | "unpause" | "unpublish";

export type ListingStatusInput = {
  action: ListingStatusAction;
};

// Minimal pet shape needed by listing-rules (no DB-specific types).
export type PetListingSnapshot = {
  status: string;
  adoptionEligible: boolean | null;
  inCustodyDispute: boolean | null;
  rabiesObservationStatus: string | null;
  adoptionListedAt: Date | null;
  adoptionListingPausedAt: Date | null;
};

// ---------------------------------------------------------------------------
// Listing content
// ---------------------------------------------------------------------------

export const ADOPTION_AGE_BUCKETS = ["puppy", "junior", "young", "adult", "senior"] as const;
export type AgeBucket = (typeof ADOPTION_AGE_BUCKETS)[number];

export const ADOPTION_SIZE_ESTIMATES = ["small", "medium", "large", "xl"] as const;
export type SizeEstimate = (typeof ADOPTION_SIZE_ESTIMATES)[number];

export const ADOPTION_ENERGY_LEVELS = ["low", "medium", "high"] as const;
export type EnergyLevel = (typeof ADOPTION_ENERGY_LEVELS)[number];

export type ListingContentInput = {
  story?: string | null;
  requirements?: string | null;
  ageBucket?: AgeBucket | null;
  sizeEstimate?: SizeEstimate | null;
  energyLevel?: EnergyLevel | null;
  goodWithKids?: boolean | null;
  goodWithDogs?: boolean | null;
  goodWithCats?: boolean | null;
  needsYard?: boolean | null;
  feeArs?: number | null;
};

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export type PriorPets = "yes_currently" | "yes_before" | "no";

export type ApplicationInput = {
  housingType: "casa_con_patio" | "casa_sin_patio" | "departamento" | "otro";
  otherPets: string | null;
  dailyRoutine: string | null;
  notes: string | null;
  profileSharingConsent: boolean;
  motivation: string | null;
  priorPets: PriorPets | null;
};

// Minimal state needed for duplicate check (pure — repo provides this).
export type ExistingApplication = {
  id: string;
};

// Minimal adopter info for listability check.
export type ApplicantProfile = {
  accountType: "personal" | "institutional" | string;
};

// Minimal pet + org shape for listability (pure check, no DB types).
export type ListablePetSnapshot = {
  adoptionListedAt: Date | null;
  adoptionListingPausedAt: Date | null;
  status: string;
  adoptionEligible: boolean | null;
  inCustodyDispute: boolean | null;
  rabiesObservationStatus: string | null;
};

export type ListableOrgSnapshot = {
  verified: boolean;
  orgType: string;
};

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

export type FinalizationInput = {
  applicationEventId: string | null; // approved-application path (transfer to applicant account)
  adopterUserId: string | null; // foster-shortcut path
  adopterDni: string | null; // manual path (raw, not normalized)
  adopterDisplayName: string;
  adopterPhone: string | null;
  followupMonths: number | null;
  notes: string | null;
};

// Minimal foster row needed by finalize-rules.
export type FosterRow = {
  id: string;
  ownerUserId: string | null;
};

// Minimal foster profile for the shortcut path validation.
export type FosterProfile = {
  id: string;
  accountType: string;
  role: string;
  dniVerified: boolean | null;
};

// ---------------------------------------------------------------------------
// Review (approve / reject)
// ---------------------------------------------------------------------------

export type ReviewInput = {
  applicationEventId: string;
  notes?: string | null;
};

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

// PO-locked semantics (2026-07-21): reversing a finalized adoption returns
// custody to the ORG that finalized it and forces the pet UN-LISTED — the
// org must explicitly re-publish. Mirrors FinalizationInput's shape, in
// reverse: no adopter identity to resolve (the reversibility gate finds it),
// just an optional free-text reason for the audit trail.
export type ReversalInput = {
  reason: string | null;
};
