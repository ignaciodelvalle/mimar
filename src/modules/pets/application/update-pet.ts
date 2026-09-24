// Use-case: update a pet profile.
//
// Receives pre-resolved inputs (canonical jurisdiction, normalized chip,
// ppp flag, upload result) from the thin action layer.
// Orchestrates:
//   1. Compute diff (pure, no DB)
//   2. No-op short-circuit — skip transaction if nothing changed
//   3. Atomic transaction (via repo.updatePetProfile)
//   4. Collect post-tx best-effort notifications
//   5. Return UseCaseResult<void> + notifications[]
//
// NOT handled here (stays in the action):
//   - requirePetAccess — auth guard (SECURITY BOUNDARY STAYS IN ACTION)
//   - parsePetForm — form parsing
//   - jurisdiction canonicalization (pre-tx I/O)
//   - uploadAttachmentIfPresent — storage upload
//   - isPotentiallyDangerousBreedForJurisdiction — PPP eval
//   - chip cross-check redirect/warning (request-edge, stays in action)
//   - Storage cleanup on error (action holds the supabase client)
//   - Flushing pendingNotifications (post-tx, best-effort)
//   - redirect(`/mis-mascotas/${publicToken}`)

import { type ExistingCanonicalIds, type ExistingPetSnapshot, diffPet } from "../domain/pet-diff";
import { isBecamePPP, isChipNewlyAdded, isNoOp } from "../domain/pet-rules";
import type { NewNotification, UpdatePetInput, UseCaseResult } from "../domain/types";
import type { PetsRepository } from "../infrastructure/pets-repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AuthorRole = "owner" | "scanner" | "finder" | "vet" | "shelter" | "govt" | "system";

type EventAuthorship = {
  authorRole: AuthorRole;
  authorOrganizationId: string | null;
  authorVerified: boolean;
};

type Actor = {
  user: { id: string };
  accessPath: "owner" | "org";
  eventAuthorship: EventAuthorship;
  existingPet: ExistingPetSnapshot;
  /** Canonical chip presence — sourced from pet_identifications by caller (ARCH-S). */
  existingCanonicalIds: ExistingCanonicalIds;
};

type Deps = {
  repo: typeof PetsRepository;
  actor: Actor;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function updatePet(input: UpdatePetInput, deps: Deps): Promise<UseCaseResult<void>> {
  const { repo, actor, transaction } = deps;
  const { user, accessPath, eventAuthorship, existingPet, existingCanonicalIds } = actor;
  const { petId, parsed, potentiallyDangerousBreed, uploadedPath, uploadMimeType, uploadSize } =
    input;

  const now = new Date();

  // 1. Compute content diff (pure, no DB).
  const changes = diffPet(existingPet, parsed, potentiallyDangerousBreed);

  // 2. Derived flags.
  const hasContentChanges = changes.length > 0 || uploadedPath !== null;
  const flagChanged = parsed.emergencyInfoVisible !== existingPet.emergencyInfoVisible;
  // ARCH-S: existingChipId now comes from canonical pet_identifications, not
  // the dropped pets.microchipId column.
  const chipNewlyAdded = isChipNewlyAdded({
    existingChipId: existingCanonicalIds.hasMicrochip ? "canonical" : null,
    parsedChipId: parsed.microchipId,
  });
  const becamePPP = isBecamePPP({
    existingPPP: existingPet.potentiallyDangerousBreed,
    newPPP: potentiallyDangerousBreed,
  });

  // 3. No-op short-circuit — skip transaction entirely.
  if (isNoOp({ hasContentChanges, hasPhoto: uploadedPath !== null, flagChanged, chipNewlyAdded })) {
    return { ok: true, notifications: [] };
  }

  const pendingNotifications: NewNotification[] = [];

  // 4. Atomic transaction.
  try {
    await transaction(async (tx) => {
      await repo.updatePetProfile(
        {
          petId,
          parsed,
          potentiallyDangerousBreed,
          changes,
          hasContentChanges,
          flagChanged,
          chipNewlyAdded,
          uploadedPath,
          uploadMimeType,
          uploadSize,
          userId: user.id,
          eventAuthorship,
          now,
        },
        tx as Parameters<typeof repo.updatePetProfile>[1],
      );
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo actualizar: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  // 5. Post-tx: collect notifications (not flushed here — action does it).
  // PPP reminder only for owner access path. Org-side updates suppress it —
  // the legal obligation belongs to the owner, not the org member editing.
  if (hasContentChanges && becamePPP && accessPath === "owner") {
    pendingNotifications.push({
      userId: user.id,
      notificationType: "ppp_registration_reminder",
      title: `${parsed.name}: registrá tu PPP en el provincial`,
      body: `Tu mascota fue marcada como raza potencialmente peligrosa por ${parsed.breed ?? "su raza"}. La Ley CABA 4078 / Ley Provincial 14.107 requiere que la inscribas en el registro provincial correspondiente.`,
      severity: "warning",
      ctaLabel: "Más info sobre PPP",
      ctaUrl: "https://www.argentina.gob.ar/justicia/derechofacil/leysimple/maltrato-animales",
      relatedPetId: petId,
    });
  }

  return { ok: true, notifications: pendingNotifications };
}
