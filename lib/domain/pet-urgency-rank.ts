// pet-urgency-rank.ts — the single owner-facing pet urgency ordering.
//
// One pet-status → sort-rank mapping, shared by every owner surface that
// orders a set of the owner's pets most-urgent-first:
//   - /inicio credential carousel (credRank)
//   - /mis-mascotas list (misMascotasRank)
//   - (owner-ia-redesign P4) the profile carousel order
//
// Ordering (PO 2026-07-12 #2, handoff 2b.2): perdido → en tratamiento →
// preñada → por vencer → al día → registrada. "sick" ("en tratamiento") is not
// produced by lnPetStatusFromCompliance today, so it never occurs in practice;
// it is kept in the switch so the ordering contract stays explicit and stable
// if it starts being produced. "registered" means the pet has pending
// obligations (ok < total) — the "por vencer" bucket. Lower number = more
// urgent = sorts first.

import type { LnPetStatus } from "@/components/ui/Chip";

export function petUrgencyRank(status: LnPetStatus): number {
  switch (status) {
    case "lost":
      return 0;
    case "sick":
      return 1;
    case "pregnant":
      return 2;
    case "registered":
      return 3;
    case "ok":
      return 4;
    default:
      return 5;
  }
}
