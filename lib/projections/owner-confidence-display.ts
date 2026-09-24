// ---------------------------------------------------------------------------
// Owner-facing confidence display (compliance-first slice, WS-3, 2026-07-01)
// Spec: dim-interno:docs/superpowers-private/specs/2026-07-01-owner-compliance-first-slice-handoff.md §4
//
// The event ledger stores 5 confidence tiers (lib/event-confidence.ts). For the
// owner's Historial, that granularity is collapsed to THREE plain-es-AR badges
// so provenance reads at a glance: is this an official/vet-verified fact, or
// something the owner logged themselves?
//
//   institutional_verified            -> "Verificado · oficial"  (success/green)
//   professional_verified             -> "Verificado por vet"    (info/celeste)
//   org_registered                    -> "Registrado por la organización" (neutral, #43)
//   corroborated | self_reported      -> "Registrado por vos"    (neutral)
//   unverified                        -> "Sin verificar"         (warning)
//
// `badge` values are exactly the LnBadge variant names, so the caller passes it
// straight through. Pure mapping — no new tokens, table-testable.
// ---------------------------------------------------------------------------

import type { ConfidenceTier } from "@/lib/events/event-confidence";

export type OwnerConfidenceBadge = "success" | "info" | "neutral" | "warning";

export type OwnerConfidenceDisplay = {
  label: string;
  badge: OwnerConfidenceBadge;
};

export function ownerConfidenceDisplay(tier: ConfidenceTier): OwnerConfidenceDisplay {
  switch (tier) {
    case "institutional_verified":
      return { label: "Verificado · oficial", badge: "success" };
    case "professional_verified":
      return { label: "Verificado por vet", badge: "info" };
    // org_registered (#43): a named org recorded it, but no matriculated
    // professional signed — an honest "record, not verified" for the owner's
    // Historial (never reads as vet/oficial verification).
    case "org_registered":
      return { label: "Registrado por la organización", badge: "neutral" };
    case "corroborated":
    case "self_reported":
      return { label: "Registrado por vos", badge: "neutral" };
    case "unverified":
      return { label: "Sin verificar", badge: "warning" };
  }
}
