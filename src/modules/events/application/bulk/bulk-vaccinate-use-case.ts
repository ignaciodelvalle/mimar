// Use-case: bulkVaccinate
//
// Orchestrates vaccination_administered events for a batch of shelter-owned pets.
// Reuses createVaccination per pet — no vaccination logic is duplicated here.
//
// Caller (thin action) is responsible for:
//   - isValidBulkActionId guard (fast fail before DB)
//   - requireCapability("event.write", orgId)
//   - revalidatePath post-success
//
// Parity contract (zero behavior change vs original bulk-pet-events.ts):
//   - Same batch size cap (BULK_BATCH_MAX = 500)
//   - Same input validation order (vaccineName, occurredAt, nextDueAt)
//   - Same batch ownership query (ne(status, "deceased"), shelter_custody, active)
//   - Same per-pet transaction boundary (best-effort, one tx per pet)
//   - Same deterministic idempotency key derivation via deriveBulkIdempotencyKey
//   - Same wasNoop semantics: noop = already written, count as succeeded, skip reminder
//   - Same reminder description: "Próxima dosis programada para ${petName}."
//   - BulkResult shape: { bulkActionId, succeeded[], failed[{id, reason}] }

import { deriveBulkIdempotencyKey } from "@/lib/events/event-idempotency";
import { parseDateInput } from "@/lib/utils/format";

import type { BulkResult } from "@/app/actions/bulk-actions";
import type { BulkVaccinateInput } from "@/app/actions/bulk-vaccinate-types";

import type { EventsRepository } from "../../infrastructure/events-repository";
import { createVaccination } from "../medical/vaccination-use-case";

const BULK_BATCH_MAX = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BulkVaccinateContext = {
  userId: string;
  organization: { id: string; publicToken: string; verified: boolean };
  // Whether the signer holds a validated matrícula. Binds clinical provenance
  // to the professional, not the org's verified flag (keystone #43).
  signerMatriculaVerified: boolean;
};

type Deps = {
  repo: EventsRepository;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function bulkVaccinate(
  input: BulkVaccinateInput,
  ctx: BulkVaccinateContext,
  deps: Deps,
): Promise<BulkResult> {
  const { bulkActionId, petPublicTokens } = input;
  const { userId, organization: org, signerMatriculaVerified } = ctx;
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

  // --- Validate shared inputs ---
  const vaccineName = input.vaccineName?.trim() ?? "";
  if (!vaccineName) {
    return {
      bulkActionId,
      succeeded: [],
      failed: petPublicTokens.map((id) => ({ id, reason: "Falta el nombre de la vacuna." })),
    };
  }

  const occurredAt = parseDateInput(input.occurredAt);
  if (!occurredAt) {
    return {
      bulkActionId,
      succeeded: [],
      failed: petPublicTokens.map((id) => ({ id, reason: "Fecha de aplicación inválida." })),
    };
  }

  const nextDueAt = input.nextDueAt ? parseDateInput(input.nextDueAt) : null;
  if (input.nextDueAt && !nextDueAt) {
    return {
      bulkActionId,
      succeeded: [],
      failed: petPublicTokens.map((id) => ({ id, reason: "Fecha de próxima dosis inválida." })),
    };
  }

  // --- Batch ownership query ---
  const ownedPets =
    petPublicTokens.length === 0 ? [] : await repo.findBatchShelterPets(petPublicTokens, org.id);

  const tokenToPet = new Map<string, { petId: string; petName: string }>();
  for (const row of ownedPets) {
    tokenToPet.set(row.publicToken, { petId: row.petId, petName: row.petName });
  }

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

    const { petId, petName } = petEntry;
    const clientIdempotencyKey = deriveBulkIdempotencyKey(bulkActionId, petId);

    try {
      const result = await createVaccination(
        {
          pet: { id: petId },
          user: { id: userId },
          // Provenance keystone (#43): bind the tier to the SIGNER's validated
          // matrícula (mirrors the per-pet boundary in lib/infra/pet-access.ts).
          // Matriculado → vet + verified → professional_verified. Otherwise
          // → shelter + false → org_registered, which does NOT clear the
          // "verificado" compliance gate.
          eventAuthorship: {
            authorRole: signerMatriculaVerified ? "vet" : "shelter",
            authorOrganizationId: org.id,
            authorVerified: signerMatriculaVerified,
          },
          vaccineName,
          occurredAt,
          brand: input.brand?.trim() || null,
          batch: input.batch?.trim() || null,
          administeredBy: input.administeredBy?.trim() || null,
          nextDueAt,
          notes: null,
          sourceReminderId: null,
          uploadedPath: null,
          uploadedMimeType: null,
          uploadedSize: null,
          clientIdempotencyKey,
          // Bulk path: include pet name in the reminder description (parity with
          // the original fat action which wrote "Próxima dosis programada para ${petName}.").
          reminderDescription: nextDueAt ? `Próxima dosis programada para ${petName}.` : null,
        },
        { repo, transaction },
      );

      if (!result.ok) {
        failed.push({ id: token, reason: result.error });
      } else {
        succeeded.push(token);
      }
    } catch (err) {
      failed.push({
        id: token,
        reason: err instanceof Error ? err.message : "Error desconocido.",
      });
    }
  }

  return { bulkActionId, succeeded, failed };
}
