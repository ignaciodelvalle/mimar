// Use-case: upsert (enroll or update preferences) a foster volunteer.
//
// Migrated from app/actions/foster-volunteers.ts::upsertFosterVolunteerAction.
// Auth (session user) is handled by the caller (thin action).
//
// Orchestrates:
//   1. Load profile (D13 pre-conditions)
//   2. Validate D13 pre-conditions (domain rules)
//   3. Validate species + maxDuration (domain rules)
//   4. Load existing volunteer row (for slot math)
//   5. Compute newSlots (domain rules)
//   6. Atomic tx: repo.upsertVolunteer (INSERT or UPDATE)
//   7. Return UseCaseResult with volunteerId + availableSlots + revalidatePath
//
// Province: canonicalized once here and stored by BOTH the INSERT and the
//   UPDATE branch of repo.upsertVolunteer (A10-6 closed the old parity quirk
//   where UPDATE wrote the raw input into a CHECK-constrained column).

import { CoordError, normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import type { UpsertFosterVolunteerInput } from "../domain/types";
import {
  computeNewSlots,
  validateD13PreConditions,
  validateUpsertVolunteerInput,
} from "../domain/volunteer-rules";
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

export async function upsertFosterVolunteer(
  input: UpsertFosterVolunteerInput,
  deps: Deps,
): Promise<UseCaseResult<{ volunteerId: string; availableSlots: number; revalidatePath: string }>> {
  const { repo, actor, transaction } = deps;
  const { user } = actor;

  // 1. Load profile (D13 pre-conditions check).
  const profile = await repo.findProfileById(user.id);
  if (!profile) {
    return { ok: false, error: "Perfil no encontrado." };
  }

  // 2. D13 pre-conditions.
  const d13 = validateD13PreConditions(profile);
  if (!d13.ok) return { ok: false, error: d13.error };

  // 3. Validate species + maxDuration.
  const inputValidation = validateUpsertVolunteerInput(input);
  if (!inputValidation.ok) return { ok: false, error: inputValidation.error };

  // 4. Load existing volunteer row (for slot math).
  const existing = await repo.findVolunteerByUserId(user.id);

  // 5. Compute new slots.
  const newSlots = computeNewSlots({ existing, mode: input.mode });

  // 6. Compute canonical province (INSERT and UPDATE) via the gate.
  // locality:"none" — province-only canonicalization (foster behavior unchanged).
  let canonicalProvince: string | null;
  try {
    ({ province: canonicalProvince } = await normalizeLocationForWrite(
      {
        province: input.jurisdictionProvince ?? null,
        provinceCode: null,
        locality: null,
        localityIndecId: null,
        lat: null,
        lng: null,
        address: null,
      },
      { locality: "none" },
    ));
  } catch (err) {
    if (err instanceof CoordError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

  const now = new Date();
  let row: { id: string; availableSlots: number } | null = null;

  // 7. Atomic transaction.
  try {
    await transaction(async (tx) => {
      row = await repo.upsertVolunteer(
        {
          userId: user.id,
          input,
          newSlots,
          now,
          canonicalProvince,
        },
        tx as Parameters<typeof repo.upsertVolunteer>[1],
      );
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo guardar la inscripción: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  if (!row) return { ok: false, error: "Error inesperado al guardar." };

  return {
    ok: true,
    value: {
      volunteerId: (row as { id: string }).id,
      availableSlots: (row as { availableSlots: number }).availableSlots,
      revalidatePath: "/cuenta/ofrecerme-como-transito",
    },
    notifications: [],
  };
}
