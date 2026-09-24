// Use-case: bulkPublishListing
//
// Orchestrates adoption listing publish / unpublish for a batch of shelter-owned
// pets. Reuses validatePublish from the adoption domain for the cross-spec guards.
// No events are written — listing is shelter-curated curation, not a pet fact
// (matches the single-pet setAdoptionListingStatusAction which also writes no events).
//
// Caller (thin action) is responsible for:
//   - isValidBulkActionId guard (fast fail before DB)
//   - requireCapability("adoption.listing.manage", orgId)
//   - revalidatePath post-success (both /org/.../mascotas and /adoptar)
//
// Parity contract (zero behavior change vs original bulk-pet-events.ts):
//   - Same batch size cap (BULK_BATCH_MAX = 500)
//   - Same batch ownership query with extra guard fields
//   - Same publish guards (D18 lost, D19 deceased, D19 eligible, D20 dispute, D21 rabies)
//     via validatePublish — error messages match exactly
//   - Same unpublish path: clears adoptionListedAt + adoptionListingPausedAt, no guards
//   - Same publish idempotency: adoptionListedAt ?? now (preserves original listed date)
//   - BulkResult shape: { bulkActionId, succeeded[], failed[{id, reason}] }

import type { BulkResult } from "@/app/actions/bulk-actions";
import type { BulkPublishListingInput } from "@/app/actions/bulk-vaccinate-types";

import { validatePublish } from "../domain/listing-rules";
import type { AdoptionRepository } from "../infrastructure/adoption-repository";

const BULK_BATCH_MAX = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BulkPublishListingContext = {
  organization: { id: string; publicToken: string; verified: boolean };
};

type Deps = {
  repo: typeof AdoptionRepository;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function bulkPublishListing(
  input: BulkPublishListingInput,
  ctx: BulkPublishListingContext,
  deps: Deps,
): Promise<BulkResult> {
  const { bulkActionId, petPublicTokens } = input;
  const { organization: org } = ctx;
  const { repo } = deps;

  // --- Guard: batch size ---
  if (petPublicTokens.length > BULK_BATCH_MAX) {
    return {
      bulkActionId,
      succeeded: [],
      failed: petPublicTokens.map((id) => ({
        id,
        reason: `Máximo ${BULK_BATCH_MAX} mascotas por lote masivo.`,
      })),
    };
  }

  // --- Batch ownership query (includes guard fields for publish path) ---
  const ownedPets =
    petPublicTokens.length === 0
      ? []
      : await repo.findBatchShelterPetsForListing(petPublicTokens, org.id);

  const tokenToPet = new Map(ownedPets.map((row) => [row.publicToken, row]));

  const succeeded: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const token of petPublicTokens) {
    const petEntry = tokenToPet.get(token);
    if (!petEntry) {
      failed.push({
        id: token,
        reason: "No está bajo custodia activa de tu organización (o no está vivo).",
      });
      continue;
    }

    try {
      const now = new Date();

      if (input.publish) {
        // Apply D18–D21 cross-spec guards via the adoption domain rule.
        // validatePublish error messages match the original fat action exactly.
        const guard = validatePublish({
          status: petEntry.status,
          adoptionEligible: petEntry.adoptionEligible,
          inCustodyDispute: petEntry.inCustodyDispute,
          rabiesObservationStatus: petEntry.rabiesObservationStatus,
          adoptionListedAt: petEntry.adoptionListedAt,
          adoptionListingPausedAt: null, // bulk path: not needed for guard logic
        });
        if (!guard.ok) {
          failed.push({ id: token, reason: guard.error });
          continue;
        }

        await repo.setListingStatus(
          {
            petId: petEntry.petId,
            action: "publish",
            currentListedAt: petEntry.adoptionListedAt,
            now,
          },
          undefined,
        );
      } else {
        // Unpublish — clears listing columns, no guards needed.
        await repo.setListingStatus(
          {
            petId: petEntry.petId,
            action: "unpublish",
            currentListedAt: petEntry.adoptionListedAt,
            now,
          },
          undefined,
        );
      }

      succeeded.push(token);
    } catch (err) {
      failed.push({
        id: token,
        reason: err instanceof Error ? err.message : "Error desconocido.",
      });
    }
  }

  return { bulkActionId, succeeded, failed };
}
