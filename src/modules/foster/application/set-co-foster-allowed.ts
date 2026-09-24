// Use-case: toggle co-foster allowed flag on an active foster ownership.
//
// Migrated from app/actions/foster-volunteers.ts::setCoFosterAllowedAction.
// Auth (session user = ownership.ownerUserId) is handled by the caller.
//
// Orchestrates:
//   1. Load active foster ownership (must belong to actor)
//   2. Atomic tx: repo.insertSetCoFosterAllowed (update + emit event + attach to foster_placement case)
//   3. Return UseCaseResult with ok + revalidatePath
//
// NOTE: v1 does NOT notify orgs of the co-foster toggle (spec R10).

import type { FosterRepository } from "../infrastructure/foster-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
};

type Deps = {
  repo: typeof FosterRepository;
  actor: Actor;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type SetCoFosterAllowedInput = {
  fosterOwnershipId: string;
  allowCoFoster: boolean;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function setCoFosterAllowed(
  input: SetCoFosterAllowedInput,
  deps: Deps,
): Promise<UseCaseResult<{ ok: true; revalidatePath: string }>> {
  const { repo, actor, transaction } = deps;
  const { user } = actor;

  // 1. Load active foster ownership (must be owned by the actor).
  const ownership = await repo.findActiveFosterOwnershipById(input.fosterOwnershipId, user.id);
  if (!ownership) {
    return { ok: false, error: "Tránsito no encontrado o no es tuyo." };
  }

  // 2. Atomic transaction.
  try {
    await transaction(async (tx) => {
      await repo.insertSetCoFosterAllowed(
        {
          ownershipId: ownership.id,
          petId: ownership.petId,
          allowCoFoster: input.allowCoFoster,
          actorUserId: user.id,
          now: new Date(),
        },
        tx as Parameters<typeof repo.insertSetCoFosterAllowed>[1],
      );
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo actualizar el co-foster: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  return {
    ok: true,
    value: { ok: true, revalidatePath: "/mis-mascotas" },
    notifications: [],
  };
}
