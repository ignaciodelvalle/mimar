// Pure domain rules for bite incidents and govt jurisdiction scoping.
//
// Legal framework:
//   - Decreto 4669/1973 (PBA) — biting animal reporting obligations.
//   - Ley 22.953 (rabies control) — govt jurisdiction authority.
//
// Zero runtime imports — pure domain logic.

// ---------------------------------------------------------------------------
// Bite enums
// ---------------------------------------------------------------------------

export const VICTIM_KINDS = ["human", "animal", "unknown"] as const;
export type VictimKind = (typeof VICTIM_KINDS)[number];

export const BITE_SEVERITIES = ["minor", "moderate", "severe"] as const;
export type BiteSeverity = (typeof BITE_SEVERITIES)[number];

// ---------------------------------------------------------------------------
// Reporter role mapping
// ---------------------------------------------------------------------------

export type ReporterRole = "vet" | "shelter" | "govt" | "witness";

/**
 * Maps an organization's org_type to the reporter_role enum value used inside
 * incident_reported.payload.reporter_role.
 * Defaults to "witness" for org types that don't fit one of the medical /
 * animal-welfare buckets.
 *
 * Mirrors the orgTypeToReporterRole function in app/actions/bite.ts exactly.
 */
export function orgTypeToReporterRole(orgType: string): ReporterRole {
  switch (orgType) {
    case "clinic":
      return "vet";
    case "shelter":
    case "rescue_network":
      return "shelter";
    case "sanitary_authority":
      return "govt";
    default:
      return "witness";
  }
}

// ---------------------------------------------------------------------------
// Govt jurisdiction scope predicate
// ---------------------------------------------------------------------------

export type CaseJurisdiction = {
  province: string | null;
  locality: string | null;
};

export type GovtJurisdiction = {
  province: string;
  locality: string;
};

// isInScope was DELETED here on 2026-08-18. The live scope guard for bite and
// outbreak cases is outbreak-investigation.ts::isInScope, which is
// subsumption-aware (a whole-province assignment covers every barrio in it).
// This one was a same-named copy with plain exact-pair equality: it answered
// FALSE for a whole-CABA operator asked about a case in Palermo. Zero
// production importers, so never exploitable — but a domain helper with THE
// name and shape of the bite scope predicate is a trap, and its tests still
// claimed parity with guards that had been fixed without it. See the note in
// bite.test.ts.
