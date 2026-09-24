// Use-case: bulkSetEligibility
//
// Orchestrates adoption_eligibility_set events + pets column updates for a
// batch of shelter-owned pets. Uses insertEventIdempotent so re-submitting
// the same bulkActionId is a safe no-op per pet.
//
// Caller (thin action) is responsible for:
//   - isValidBulkActionId guard (fast fail before DB)
//   - requireCapability("intake.create", orgId)
//   - revalidatePath post-success
//
// Parity contract (zero behavior change vs original bulk-pet-events.ts):
//   - Same batch size cap (BULK_BATCH_MAX = 500)
//   - Same eligibility validation order via validateEligibilityInput
//   - Same batch ownership query (ne(status, "deceased"), shelter_custody, active)
//   - Same per-pet transaction boundary (best-effort, one tx per pet)
//   - Same deterministic idempotency key derivation via deriveBulkIdempotencyKey
//   - Same wasNoop semantics: noop path still counts as succeeded
//   - Same previous_state: null (bulk path, no pre-load for performance)
//   - BulkResult shape: { bulkActionId, succeeded[], failed[{id, reason}] }

import { deriveBulkIdempotencyKey } from "@/lib/events/event-idempotency";

import type { BulkResult } from "@/app/actions/bulk-actions";
import type { BulkSetEligibilityInput } from "@/app/actions/bulk-vaccinate-types";

import { validateEligibilityInput } from "../domain/eligibility-rules";
import type { AdoptionRepository } from "../infrastructure/adoption-repository";

const BULK_BATCH_MAX = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BulkSetEligibilityContext = {
  userId: string;
  organization: { id: string; publicToken: string; verified: boolean };
};

type Deps = {
  repo: typeof AdoptionRepository;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function bulkSetEligibility(
  input: BulkSetEligibilityInput,
  ctx: BulkSetEligibilityContext,
  deps: Deps,
): Promise<BulkResult> {
  const { bulkActionId, petPublicTokens } = input;
  const { userId, organization: org } = ctx;
  const { repo, transaction } = deps;

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

  // --- Validate eligibility inputs (domain rules — pure) ---
  const validation = validateEligibilityInput({
    eligible: input.eligible,
    ineligibleReason: input.ineligibleReason ?? null,
    ineligibleReasonNotes: input.ineligibleReasonNotes ?? null,
    ineligibleUntilIso: input.ineligibleUntilIso ?? null,
  });
  if (!validation.ok) {
    return {
      bulkActionId,
      succeeded: [],
      failed: petPublicTokens.map((id) => ({ id, reason: validation.error })),
    };
  }

  // Parse ineligibleUntil once (validated above — safe to construct Date).
  const ineligibleUntil = input.ineligibleUntilIso ? new Date(input.ineligibleUntilIso) : null;

  // --- Batch ownership query ---
  const ownedPets =
    petPublicTokens.length === 0
      ? []
      : await repo.findBatchShelterPetsForEligibility(petPublicTokens, org.id);

  const tokenToPetId = new Map<string, string>();
  for (const row of ownedPets) {
    tokenToPetId.set(row.publicToken, row.petId);
  }

  const succeeded: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const token of petPublicTokens) {
    const petId = tokenToPetId.get(token);
    if (!petId) {
      failed.push({
        id: token,
        reason: "No está bajo custodia activa de tu organización (o no está vivo).",
      });
      continue;
    }

    const clientIdempotencyKey = deriveBulkIdempotencyKey(bulkActionId, petId);

    try {
      await transaction(async (tx) => {
        const now = new Date();
        const { wasNoop } = await repo.setBulkEligibilityIdempotent(
          {
            petId,
            eligible: input.eligible,
            ineligibleReason: input.eligible ? null : (input.ineligibleReason ?? null),
            ineligibleReasonNotes: input.eligible
              ? null
              : input.ineligibleReasonNotes?.trim() || null,
            ineligibleUntil: input.eligible ? null : ineligibleUntil,
            now,
            userId,
            orgId: org.id,
            orgVerified: org.verified,
            clientIdempotencyKey,
          },
          tx as Parameters<typeof repo.setBulkEligibilityIdempotent>[1],
        );

        // wasNoop = idempotent retry; pets UPDATE already applied (idempotent),
        // event already exists — nothing more to do.
        if (wasNoop) return;
      });

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
