// Plain DTOs and value-shapes for the foster domain layer.
// Zero external imports — this file must not pull in Drizzle, Next.js, or @/db.

// ---------------------------------------------------------------------------
// Assign / End foster
// ---------------------------------------------------------------------------

export const END_FOSTER_UI_REASONS = [
  "returned",
  "early_return_by_foster",
  "lost_unrecovered",
  "other",
] as const;
export type EndFosterUIReason = (typeof END_FOSTER_UI_REASONS)[number];

// Maps an end-foster UI reason to the case closed_reason.
// early_return_by_foster → cancelled; everything else → resolved.
export const END_REASON_TO_CLOSED_REASON: Record<EndFosterUIReason, "resolved" | "cancelled"> = {
  returned: "resolved",
  early_return_by_foster: "cancelled",
  lost_unrecovered: "resolved",
  other: "resolved",
};

export type AssignFosterInput = {
  fosterUserId: string;
  expectedWeeksRaw: string;
  notes: string | null;
};

export type EndFosterInput = {
  reasonRaw: string;
  notes: string | null;
};

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export const REJECTION_REASONS = [
  "capacity",
  "health_mismatch",
  "timing",
  "distance",
  "household",
  "other",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const PROPOSAL_EXPIRY_DAYS = 7;

// ---------------------------------------------------------------------------
// Volunteer
// ---------------------------------------------------------------------------

export type UpsertFosterVolunteerInput = {
  mode: "enroll" | "update_preferences_only";
  status: "active" | "paused";
  jurisdictionProvince?: string | null;
  jurisdictionLocality?: string | null;
  acceptsDogs: boolean;
  acceptsCats: boolean;
  acceptsOtherSpecies: boolean;
  acceptsSizeSmall: boolean;
  acceptsSizeMedium: boolean;
  acceptsSizeLarge: boolean;
  acceptsPuppies: boolean;
  acceptsSeniors: boolean;
  acceptsChronicConditions: boolean;
  acceptsDangerousBreeds: boolean;
  maxDurationWeeks?: number | null;
  householdOtherPets?: boolean | null;
  householdKids?: boolean | null;
  notes?: string | null;
};

// Minimal volunteer snapshot (no DB types) needed by domain rules.
export type VolunteerSnapshot = {
  status: string;
  availableSlots: number;
};

// D13 pre-condition profile shape (no DB types).
// accountType and role may be null for newly-created or incomplete profiles.
export type ProfileSnapshot = {
  accountType: string | null;
  role: string | null;
  dniVerified: boolean | null;
  displayName: string | null;
  phone: string | null;
};

// ---------------------------------------------------------------------------
// Shared domain result
// ---------------------------------------------------------------------------

export type DomainResult<T = void> = { ok: true; value: T } | { ok: false; error: string };
