// Use-case: withdraw a foster volunteer from the pool.
//
// Migrated from app/actions/foster-volunteers.ts::withdrawFosterVolunteerAction.
// Auth (session user) is handled by the caller (thin action).
//
// Orchestrates:
//   1. Check volunteer is enrolled
//   2. Atomic tx: repo.withdrawVolunteer (status→withdrawn, slots→0, cascade cancel)
//   3. Return UseCaseResult with ok + revalidatePath
//
// PARITY QUIRK: withdraw cascade emits foster_proposal_resolved WITHOUT caseId
// and does NOT close proposal cases — preserved in repo.withdrawVolunteer.

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

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function withdrawFosterVolunteer(
  deps: Deps,
): Promise<UseCaseResult<{ ok: true; revalidatePath: string }>> {
  const { repo, actor, transaction } = deps;
  const { user } = actor;

  // 1. Check enrolled.
  const existing = await repo.findVolunteerByUserId(user.id);
  if (!existing) {
    return { ok: false, error: "No estás inscripto en el pool de voluntarios." };
  }

  const now = new Date();

  // 2. Atomic transaction.
  try {
    await transaction(async (tx) => {
      await repo.withdrawVolunteer(
        { userId: user.id, now },
        tx as Parameters<typeof repo.withdrawVolunteer>[1],
      );
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo retirar del pool: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  return {
    ok: true,
    value: { ok: true, revalidatePath: "/cuenta/ofrecerme-como-transito" },
    notifications: [],
  };
}
