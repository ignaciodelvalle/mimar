// Inline chip for a case — used in pet profile lists and case index pages.
// Compact: kind icon + public code + status pill.
//
// Links to /casos/[publicCode]. Caller-supplied size prop allows a smaller
// inline version (for lists) vs a hero version (case detail header).

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { CASE_STATUS_CONFIG } from "@/components/ui/dashboard/CaseStatusBadge";
import { TONE_CLASSES } from "@/components/ui/dashboard/OpStatusPill";
import type { CaseStatus } from "@/db";
import { type CaseKind, caseKindLabel } from "@/src/modules/cases/domain/case-kinds";

const KIND_ICON: Record<CaseKind, string> = {
  bite_incident: "mordedura",
  lost_pet_episode: "perdida",
  welfare_denuncia: "denuncia",
  adoption_listing: "casa",
  adoption_application: "solicitud",
  custody_dispute: "disputa",
  foster_placement: "trato",
  custody_episode: "custodia",
  custody_transfer_handshake: "transferencia",
  foster_proposal: "propuesta",
  outbreak_investigation: "brote",
  microchip_remediation: "reparacion",
  // rehome-by-titular: a request for a new home reads as the adoption glyph.
  rehome_request: "casa",
};

// Status label + tone are delegated to the canonical CASE_STATUS_CONFIG (the
// single source of truth for the case color grammar) and OpStatusPill's
// TONE_CLASSES — no local re-implementation. Both resolve via the
// --color-st-* indirection layer so tones auto-remap per skin (operator
// surfaces under .op-surface → ln-op-*; citizen → ln-*). This chip keeps its
// citizen rounded-full geometry; only the mapping is shared.

interface Props {
  publicCode: string;
  caseKind: CaseKind;
  status: CaseStatus;
  size?: "sm" | "md";
}

export function CaseBadge({ publicCode, caseKind, status, size = "md" }: Props) {
  const sizeClasses = size === "sm" ? "px-2 py-1 text-xs gap-1.5" : "px-3 py-1.5 text-sm gap-2";
  const { label: statusLabel, tone } = CASE_STATUS_CONFIG[status];
  return (
    <Link
      href={`/casos/${publicCode}`}
      // prefetch=false: this badge is always-mounted alert-strip content on
      // the pet profile (Face 1, eager) — see PetActionRow.tsx and
      // EventTimeline.tsx for the full incident writeup on how concurrent
      // eager Link prefetching combines with a known Next.js 15.5.x
      // App Router production-mode defect (RSC fetch resolves 200 with a
      // valid flight payload, but the client router silently drops it —
      // no history commit, no re-render) to make real navigations
      // intermittently no-op. Reduces one more source of concurrent
      // background fetch pressure at the moment a user is likely clicking
      // something else on the same page.
      prefetch={false}
      className={`inline-flex items-center rounded-full bg-ln-card ring-1 ring-ln-line transition hover:bg-ln-stripe    ${sizeClasses}`}
    >
      <Icon name={KIND_ICON[caseKind]} size="sm" decorative />
      <span className="font-ln-mono font-semibold text-ln-ink ">{publicCode}</span>
      <span className="text-ln-mute ">·</span>
      <span className="text-ln-ink ">{caseKindLabel(caseKind)}</span>
      <span
        className={`ml-1 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}
      >
        {statusLabel}
      </span>
    </Link>
  );
}
