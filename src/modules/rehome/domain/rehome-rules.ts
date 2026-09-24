// Pure rules of the rehome-by-titular flow — no DB, no framework.
//
// Four moments, four rule sets:
//   - REQUEST (spec REQ-1, REQ-16): whom a titular may ask, and when.
//   - ACCEPT (design ADR-1 steps 1-4, plus 1b from the WU3 review): what must
//     still be true, under the case lock, before the org is granted a custody
//     row alongside the titular's owner row — including that the ACCEPTING org
//     still qualifies to sponsor. The use-case runs these INSIDE the
//     transaction on freshly re-read rows; a pre-transaction read is stale by
//     construction.
//   - WITHDRAW (spec REQ-8, REQ-10, REQ-15): the titular ends a running
//     sponsorship. Unconditional on the org's side — the only questions are
//     "is this the titular" and "is there something to withdraw".
//   - CANCEL (spec REQ-3): the titular closes a request the org has not
//     answered yet. Nothing about the animal is involved.
//
// Every rule returns the es-AR refusal the user reads. The ORDER inside
// validateAcceptPreconditions is the design's order and is pinned by a test:
// the earliest failing step is the one reported, because "this request was
// already answered" is more actionable than "the pet is in observation".

import {
  type CoverageArea,
  type PetZone,
  coverageAreaCoversZone,
  orgCoversZone,
} from "@/lib/domain/org-coverage";
import { formatDate } from "@/lib/utils/format";

export type RuleResult = { ok: true } | { ok: false; error: string };

/**
 * The refusal every titular-only rehome action shows a non-titular. One
 * sentence for request, cancel and withdraw: the action edge says it after
 * `requireTitularAccess`, and the use-cases say it again when the live
 * `owner` row is not the caller's (REQ-1, REQ-14).
 */
export const NOT_TITULAR_ERROR =
  "Solo el titular de la mascota puede pedir, cancelar o dar de baja un acompañamiento de adopción.";

/** Org types allowed to sponsor a listing. Mirrors the adoption catalog's filter. */
export const REHOME_ELIGIBLE_ORG_TYPES: readonly string[] = ["shelter", "rescue_network"];

export type SponsorTargetSnapshot = { orgType: string; verified: boolean };

/**
 * The three refusals about the ORG the titular named, NAMED (2026-09-10) for
 * the reason the animal-state pair below was: a second door now maps each
 * refusal to a wire code, and a door that recognised a sentence by its text
 * would break the day the sentence was edited. Same strings as before; the
 * only change is that they have a name a caller can compare against.
 */
export const ORG_NOT_FOUND_ERROR = "Organización no encontrada.";
export const ORG_NOT_ELIGIBLE_ERROR =
  "La organización no puede acompañar adopciones: tiene que ser un refugio o una red de rescate.";
export const ORG_NOT_VERIFIED_ERROR = "La organización no está verificada.";

export function validateSponsorTarget(org: SponsorTargetSnapshot | null): RuleResult {
  if (!org) return { ok: false, error: ORG_NOT_FOUND_ERROR };
  if (!REHOME_ELIGIBLE_ORG_TYPES.includes(org.orgType)) {
    return { ok: false, error: ORG_NOT_ELIGIBLE_ERROR };
  }
  if (!org.verified) return { ok: false, error: ORG_NOT_VERIFIED_ERROR };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// COVERAGE — the org has to work where the animal lives (W-4)
// ---------------------------------------------------------------------------
//
// This is the picker's filter. The picker
// (app/(app)/mis-mascotas/[publicToken]/buscar-hogar/page.tsx) only ever
// offered orgs whose `organization_coverage` reaches the pet's zone, but the
// request is a server action: any titular session can POST any orgId. A
// filter that lives only in the page is a view, not a rule — a crafted
// request landed a `rehome_request` in the inbox of an org three provinces
// away. The page now derives its list from `coverageAreaCoversZone`, and the
// use-case refuses on the same predicate.
//
// THE PREDICATE'S ONE HOME IS lib/domain/org-coverage.ts (2026-08-22): the
// foster flow's `sendRehomeRequest` had the identical hole and `foster ->
// rehome` is not an allowed module edge, so the pure rule moved outside the
// module graph. Re-exported here so this module's callers and tests are
// unchanged.

export { type CoverageArea, type PetZone, coverageAreaCoversZone, orgCoversZone };

export type SponsorCoverageSnapshot = {
  orgDisplayName: string;
  petName: string;
  zone: PetZone;
  coverage: readonly CoverageArea[];
};

/** REQ-1's zone half: the org the titular names has to work where the pet is. */
export function validateSponsorCoverage(s: SponsorCoverageSnapshot): RuleResult {
  if (!s.zone.province) {
    return {
      ok: false,
      error: `${s.petName} no tiene provincia registrada. Editá el perfil de ${s.petName} para poder elegir una organización.`,
    };
  }
  if (!orgCoversZone(s.coverage, s.zone)) {
    return {
      ok: false,
      error: `${s.orgDisplayName} no cubre la zona de ${s.petName}. Elegí una organización que trabaje en ${s.zone.locality ?? s.zone.province}.`,
    };
  }
  return { ok: true };
}

export type RequestOpenSnapshot = {
  petStatus: string;
  /** An open `rehome_request` case already exists for the pet. */
  hasOpenRequest: boolean;
  /** An accepted sponsorship is still running (unmatched `rehome_sponsorship_started`). */
  hasOpenSponsorship: boolean;
};

/**
 * REQ-16's refusal. Named because it is shown twice: by the pre-read here and
 * by the use-case when `cases_open_per_pet_kind_idx` catches the double-submit
 * the pre-read could not see. One sentence, whichever layer says it.
 */
export const OPEN_REQUEST_PENDING_ERROR =
  "Ya hay una solicitud de nuevo hogar pendiente para esta mascota. Esperá la respuesta o cancelala antes de enviar otra.";

/**
 * The two animal-state refusals, NAMED — because they are said at more than one
 * door and the copies must not drift.
 *
 * They were inline literals in three and six places respectively until
 * 2026-08-25, and the commit that added the `lost` arm claimed the copies were
 * held together by tests asserting "exact text". They were not: each test
 * asserted its own hardcoded literal, which is two independent assertions, not
 * a coupling. Changing the sentence and its own test would have let the other
 * copies drift with a green suite. Now the sentence has one home and the tests
 * import it.
 *
 * The foster flow's `sendRehomeRequest` still holds a COPY rather than an
 * import: `foster -> rehome` is not an allowed module edge (the same
 * constraint that moved the coverage predicate to lib/domain). Its unit test
 * imports these constants directly — a test file is not part of the runtime
 * module graph — so the copy is pinned to the original by an assertion that
 * actually references it.
 *
 * Deliberately WITHOUT the trailing instruction the siblings carry
 * (`validatePublish`: "Marcala recuperada antes de publicar";
 * `validatePetStatusForTransfer`: "Resolvé el episodio primero"). Each door
 * tells you what to do about ITS action; only the fact is shared.
 */
export const PET_LOST_ERROR = "Esta mascota está reportada como perdida.";
export const PET_DECEASED_ERROR = "Esta mascota está registrada como fallecida.";

/**
 * REQ-16: one open request OR one running sponsorship per pet, never both,
 * never two — plus the animal-state bar the ACCEPT already applied.
 *
 * The `lost` arm was missing until 2026-08-25. `validateAcceptPreconditions`
 * a hundred lines below refuses a lost pet with this exact sentence, and both
 * sibling entry points do too (adoption's `validatePublish`, transfers'
 * `validatePetStatusForTransfer`), so no custody was ever granted on a lost
 * animal — but the REQUEST wrote anyway: a spurious org inbox item, a
 * notification whose body reads "El animal sigue viviendo con su familia
 * mientras dure el acompañamiento" (false for an animal nobody can find), a
 * misleading owner-facing pending state, REQ-16's open-request lock, and a pet
 * carrying an open `lost_pet` case and an open `rehome_request` case at once.
 *
 * ON ORDER — corrected 2026-08-25, after a reviewer took the first version of
 * this paragraph apart. It claimed the lost/deceased order mattered so that
 * "a pet in both states hears the same first sentence at every door". NO SUCH
 * PET CAN EXIST: `pets.status` is a single `pet_status` enum column, so `lost`
 * and `deceased` are mutually exclusive and their relative order here is
 * behaviourally unobservable. The claim was wrong about the siblings too —
 * `validatePetStatusForTransfer` checks deceased FIRST, and its sentence
 * carries a different instruction ("Resolvé el episodio primero") from
 * `validatePublish`'s ("Marcala recuperada antes de publicar"). Three doors,
 * three orderings, three wordings; only the FACT is shared.
 *
 * The ordering that IS observable is the one that first version did not argue
 * for: animal state now precedes both REQ-16 arms, so a lost pet with a
 * running sponsorship hears "reportada como perdida" rather than "ya tiene una
 * organización acompañando". That is the right way round — a state of the
 * ANIMAL outranks a state of the paperwork — and it deliberately does NOT
 * match the accept, which puts CUSTODY_PRESENT_ERROR ahead of `lost` because
 * under its lock a live custody row is the more actionable fact.
 */
/** REQ-16's other arm: a sponsorship is already running. Named for the same reason as its sibling. */
export const OPEN_SPONSORSHIP_RUNNING_ERROR =
  "Esta mascota ya tiene una organización acompañando su adopción. Dá de baja ese acompañamiento antes de pedir otro.";

export function validateRequestOpen(s: RequestOpenSnapshot): RuleResult {
  if (s.petStatus === "lost") {
    return { ok: false, error: PET_LOST_ERROR };
  }
  if (s.petStatus === "deceased") {
    return { ok: false, error: PET_DECEASED_ERROR };
  }
  if (s.hasOpenSponsorship) {
    return { ok: false, error: OPEN_SPONSORSHIP_RUNNING_ERROR };
  }
  if (s.hasOpenRequest) {
    return { ok: false, error: OPEN_REQUEST_PENDING_ERROR };
  }
  return { ok: true };
}

export type RequestAnswerSnapshot = {
  caseKind: string;
  caseStatus: string;
  caseReceiverOrganizationId: string | null;
  actingOrganizationId: string;
};

/** ADR-1 step 1: an OPEN rehome_request addressed to the acting org. */
export function validateDeclinePreconditions(s: RequestAnswerSnapshot): RuleResult {
  if (s.caseKind !== "rehome_request") {
    return { ok: false, error: "Este caso no es una solicitud de nuevo hogar." };
  }
  if (s.caseStatus !== "open") return { ok: false, error: "Esta solicitud ya fue respondida." };
  if (s.caseReceiverOrganizationId !== s.actingOrganizationId) {
    return { ok: false, error: "Esta solicitud está dirigida a otra organización." };
  }
  return { ok: true };
}

export type AcceptPetSnapshot = {
  status: string;
  inCustodyDispute: boolean | null;
  rabiesObservationStatus: string | null;
  /**
   * A time-boxed "not eligible until" left by whichever org last held the
   * animal (WU3 review, L-3). The accept's setEligibility(true) would null it;
   * while the date is in force the accept refuses instead. An OPEN-ENDED
   * ineligibility (no date) does not block: its author no longer holds custody
   * (step 3) and nobody could lift it.
   */
  adoptionIneligibleUntil: Date | null;
};

export type AcceptSnapshot = RequestAnswerSnapshot & {
  /**
   * Step 1b: the ACCEPTING org, re-read under the lock — not the session's
   * snapshot. The catalog (adoption-listing-read.ts) lists a pet only when its
   * custodian org is verified and a shelter / rescue network; an org that no
   * longer qualifies would be granted custody, publish, and tell the titular
   * "ya figura en la búsqueda" for a pet the catalog never shows. Null when the
   * row could not be re-read.
   */
  actingOrg: SponsorTargetSnapshot | null;
  /** Step 2: the consenting titular still holds a live `owner` row. */
  titularOwnerRowLive: boolean;
  /** Step 3: live `shelter_custody` rows on the pet, any holder. Must be 0. */
  liveShelterCustodyCount: number;
  /** Step 4: the catalog's own preconditions, failed here with a reason. */
  pet: AcceptPetSnapshot;
  /** The transaction's clock, against which the time-box is judged. */
  now: Date;
};

/**
 * Step 3's refusal. Named because it is shown twice: by the rule on the
 * pre-read, and by the use-case when the per-pet org custody index (0195)
 * catches a custody row that committed between the pre-read and the insert.
 */
export const CUSTODY_PRESENT_ERROR = "Esta mascota ya está bajo custodia de una organización.";

export function validateAcceptPreconditions(s: AcceptSnapshot): RuleResult {
  const step1 = validateDeclinePreconditions(s);
  if (!step1.ok) return step1;

  // Step 1b: the same bar the titular's request applied to the org, applied
  // again to the org that is about to act — a verification can be withdrawn
  // between the request and the answer.
  const step1b = validateSponsorTarget(s.actingOrg);
  if (!step1b.ok) return step1b;

  // Consent expires with title: a request accepted after a transfer would
  // grant custody on the word of an ex-owner.
  if (!s.titularOwnerRowLive) {
    return {
      ok: false,
      error: "La persona que pidió el acompañamiento ya no es titular de la mascota.",
    };
  }

  // One org at a time. Also excludes a pet already under decomiso or intake.
  if (s.liveShelterCustodyCount > 0) {
    return { ok: false, error: CUSTODY_PRESENT_ERROR };
  }

  if (s.pet.status === "lost") {
    return { ok: false, error: PET_LOST_ERROR };
  }
  if (s.pet.status === "deceased") {
    return { ok: false, error: PET_DECEASED_ERROR };
  }
  if (s.pet.inCustodyDispute === true) {
    return { ok: false, error: "Esta mascota está en disputa de custodia." };
  }
  if (s.pet.rabiesObservationStatus === "in_progress") {
    return { ok: false, error: "Esta mascota está en período de observación sanitaria." };
  }
  if (s.pet.adoptionIneligibleUntil && s.pet.adoptionIneligibleUntil.getTime() > s.now.getTime()) {
    return {
      ok: false,
      error: `Esta mascota fue marcada como no apta para adopción hasta el ${formatDate(
        s.pet.adoptionIneligibleUntil,
      )}. Ese plazo tiene que vencer antes de aceptar el acompañamiento.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// WITHDRAW — the titular ends an active sponsorship (REQ-8, REQ-10, REQ-15)
// ---------------------------------------------------------------------------

export const NO_ACTIVE_SPONSORSHIP_ERROR =
  "Esta mascota no tiene un acompañamiento de adopción activo.";

export type WithdrawSponsorshipSnapshot = {
  /** The caller holds the live `owner` row, read FOR UPDATE inside the transaction. */
  titularOwnerRowLive: boolean;
  /** The unmatched `rehome_sponsorship_started`, keyed on the spine. */
  openSponsorship: { ownershipId: string } | null;
};

/**
 * Deliberately NOTHING about the org here — not its verification, not its
 * reachability, not whether it paused the listing or is mid-review of an
 * applicant. REQ-10: the titular's route back never depends on the org.
 */
export function validateWithdrawSponsorship(s: WithdrawSponsorshipSnapshot): RuleResult {
  if (!s.titularOwnerRowLive) return { ok: false, error: NOT_TITULAR_ERROR };
  if (!s.openSponsorship) return { ok: false, error: NO_ACTIVE_SPONSORSHIP_ERROR };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CANCEL — the titular withdraws a request before it is answered (REQ-3)
// ---------------------------------------------------------------------------

export const NO_PENDING_REQUEST_ERROR =
  "No hay una solicitud de nuevo hogar pendiente para esta mascota.";

export type WithdrawRequestSnapshot = {
  caseKind: string;
  caseStatus: string;
  /** `cases.opened_by_user_id` — the titular who sent it. */
  caseOpenedByUserId: string | null;
  actingUserId: string;
};

/**
 * The request is the opener's to cancel. A later titular (after a transfer)
 * holds the owner row but did not send this request; they open their own.
 */
/** The cancel's three refusals, named so a second door can map them (2026-09-10). */
export const NOT_A_REQUEST_ERROR = "Este caso no es una solicitud de nuevo hogar.";
export const REQUEST_ALREADY_ANSWERED_ERROR = "Esta solicitud ya fue respondida o cancelada.";
export const REQUEST_NOT_SENDER_ERROR = "Solo quien envió la solicitud puede cancelarla.";

export function validateWithdrawRequest(s: WithdrawRequestSnapshot): RuleResult {
  if (s.caseKind !== "rehome_request") {
    return { ok: false, error: NOT_A_REQUEST_ERROR };
  }
  if (s.caseStatus !== "open") {
    return { ok: false, error: REQUEST_ALREADY_ANSWERED_ERROR };
  }
  if (s.caseOpenedByUserId !== s.actingUserId) {
    return { ok: false, error: REQUEST_NOT_SENDER_ERROR };
  }
  return { ok: true };
}
