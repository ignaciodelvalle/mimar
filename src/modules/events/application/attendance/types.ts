// Shared types for the attendance application layer.
// Moved verbatim from app/actions/attendance.ts (strangler 12/61).

// ============================================================================
// Result types
// ============================================================================

export type AttendanceResult = { ok: true } | { error: string };

// ============================================================================
// Per-service-kind attendance payload types
// These map to the Zod schemas in lib/event-schemas.ts.
// The form components provide these payloads; the writer validates them.
// ============================================================================

export type VaccinationPayload = {
  vaccine_name: string;
  brand: string | null;
  batch: string | null;
  administered_by: string | null;
  next_due_at: string | null;
};

export type DewormingPayload = {
  product: string;
  type: "internal" | "external" | "both";
  next_due_at: string | null;
};

export type SterilizationPayload = {
  procedure: "castration" | "spay";
  performed_by: string | null;
  clinic: string | null;
};

export type VetVisitPayload = {
  reason: string;
  diagnosis: string | null;
  vet_name: string | null;
  clinic: string | null;
};

export type MicrochipPayload = {
  chip_number: string;
  country_code: string | null;
  implanted_by: string | null;
  location_on_body: string | null;
};

export type AttendancePayload =
  | ({ kind: "vaccination" } & VaccinationPayload)
  | ({ kind: "deworming" } & DewormingPayload)
  | ({ kind: "sterilization" } & SterilizationPayload)
  | ({ kind: "microchip" } & MicrochipPayload)
  | ({ kind: "vet_visit" } & VetVisitPayload);

// ============================================================================
// Authorship descriptor
// ============================================================================

export type AuthorDescriptor = {
  actorUserId: string;
  authorRole: "vet" | "shelter";
  authorOrganizationId: string | null;
  authorVerified: boolean;
};
