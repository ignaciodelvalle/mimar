// Case-lifecycle registry. One entry per V1 case_kind.
//
// Adding a new V1 kind: create `src/modules/cases/domain/lifecycles/<kind>.ts`
// exporting a CaseLifecycle, import here, register in `LIFECYCLES`. The
// coverage test in `__tests__/case-lifecycles.test.ts` enforces that every
// V1_CASE_KIND is registered.

import type { CaseKind } from "../case-kinds";
import { adoptionApplicationLifecycle } from "./adoption-application";
import { adoptionListingLifecycle } from "./adoption-listing";
import { biteIncidentLifecycle } from "./bite-incident";
import { custodyDisputeLifecycle } from "./custody-dispute";
import { custodyEpisodeLifecycle } from "./custody-episode";
import { custodyTransferHandshakeLifecycle } from "./custody-transfer-handshake";
import { fosterPlacementLifecycle } from "./foster-placement";
import { fosterProposalLifecycle } from "./foster-proposal";
import { lostPetEpisodeLifecycle } from "./lost-pet-episode";
import { microchipRemediationLifecycle } from "./microchip-remediation";
import { outbreakInvestigationLifecycle } from "./outbreak-investigation";
import { rehomeRequestLifecycle } from "./rehome-request";
import type { CaseLifecycle } from "./types";
import { welfareDenunciaLifecycle } from "./welfare-denuncia";

export type { CaseLifecycle, CaseStatus, OpenTrigger } from "./types";

const LIFECYCLES: Partial<Record<CaseKind, CaseLifecycle>> = {
  bite_incident: biteIncidentLifecycle,
  lost_pet_episode: lostPetEpisodeLifecycle,
  welfare_denuncia: welfareDenunciaLifecycle,
  adoption_listing: adoptionListingLifecycle,
  adoption_application: adoptionApplicationLifecycle,
  custody_dispute: custodyDisputeLifecycle,
  foster_placement: fosterPlacementLifecycle,
  custody_transfer_handshake: custodyTransferHandshakeLifecycle,
  microchip_remediation: microchipRemediationLifecycle,
  // Previously deferred — now activated:
  foster_proposal: fosterProposalLifecycle,
  custody_episode: custodyEpisodeLifecycle,
  outbreak_investigation: outbreakInvestigationLifecycle,
  // rehome-by-titular: the titular's consent request to a sponsoring org.
  rehome_request: rehomeRequestLifecycle,
};

/**
 * Resolve the lifecycle for a kind. Returns null only for kinds not yet
 * registered (currently none — all CASE_KINDS have a lifecycle entry).
 */
export function getLifecycle(kind: CaseKind): CaseLifecycle | null {
  return LIFECYCLES[kind] ?? null;
}

/** All V1 lifecycles as an array. Useful for cron config + coverage tests. */
export function allLifecycles(): CaseLifecycle[] {
  return Object.values(LIFECYCLES).filter((l): l is CaseLifecycle => l !== undefined);
}
