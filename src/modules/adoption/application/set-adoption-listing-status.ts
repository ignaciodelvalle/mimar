// Use-case: set the adoption listing status of a pet (publish/pause/unpause/unpublish).
//
// Receives a trusted actor context (auth already resolved by the action layer).
// Orchestrates: input validation (domain rules) → pet lookup → DB write.
// Returns UseCaseResult<void> — no notifications emitted for status changes.
//
// The caller (thin action) is responsible for:
//   - requireCapability("adoption.listing.manage")
//   - Parsing the raw action parameter
//   - Calling revalidatePath after success

import {
  validatePause,
  validatePublish,
  validateUnpause,
  validateUnpublish,
} from "../domain/listing-rules";
import type { ListingStatusAction } from "../domain/types";
import type { AdoptionRepository } from "../infrastructure/adoption-repository";
import type { UseCaseResult } from "./set-adoption-eligibility";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
  organization: { id: string; publicToken: string; verified: boolean };
};

type Deps = {
  repo: typeof AdoptionRepository;
  actor: Actor;
  /** db.transaction — injected so unit tests can swap it for a fake. */
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type SetListingStatusInput = {
  petPublicToken: string;
  action: ListingStatusAction;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function setAdoptionListingStatus(
  input: SetListingStatusInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, actor } = deps;
  const { organization } = actor;

  // 1. Load pet.
  const petRow = await repo.findShelterPet(input.petPublicToken, organization.id);
  if (!petRow) {
    return {
      ok: false,
      error: "Mascota no encontrada o no está bajo custodia de tu organización.",
    };
  }

  // 2. Domain rule validation.
  const petSnapshot = {
    status: petRow.status,
    adoptionEligible: petRow.adoptionEligible,
    inCustodyDispute: petRow.inCustodyDispute,
    rabiesObservationStatus: petRow.rabiesObservationStatus,
    adoptionListedAt: petRow.adoptionListedAt,
    adoptionListingPausedAt: petRow.adoptionListingPausedAt,
  };

  let ruleResult:
    | ReturnType<typeof validatePublish>
    | ReturnType<typeof validatePause>
    | ReturnType<typeof validateUnpause>
    | ReturnType<typeof validateUnpublish>;

  if (input.action === "publish") {
    ruleResult = validatePublish(petSnapshot);
  } else if (input.action === "pause") {
    ruleResult = validatePause(petSnapshot);
  } else if (input.action === "unpause") {
    ruleResult = validateUnpause(petSnapshot);
  } else {
    ruleResult = validateUnpublish(petSnapshot);
  }

  if (!ruleResult.ok) return { ok: false, error: ruleResult.error };

  // 3. Persist the status change (no transaction needed — single update).
  const now = new Date();
  await repo.setListingStatus(
    {
      petId: petRow.id,
      action: input.action,
      currentListedAt: petRow.adoptionListedAt,
      now,
    },
    undefined, // no transaction — this is a single-table write
  );

  return { ok: true, notifications: [] };
}
