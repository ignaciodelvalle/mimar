// ensureOpenVisit — resolve the visit an Atender write belongs to.
//
// Auth: none here. The caller has already authorized the vet for this pet at
// this organization (resolveAtenderPet / the signer tier); this use-case only
// decides WHICH visit, never WHETHER.
//
// ONE TRANSACTION, UNDER ONE ADVISORY LOCK PER (pet, org, vet). Opening a visit
// is read-decide-write: two concurrent submits from the same vet would both
// see "no open visit" and both open one. The lock serializes them; the second
// one, once it gets the lock, reads the first one's committed row and reuses
// it. That is the whole concurrency story — there is deliberately no partial
// unique index (an offline client syncing a visit while a web visit is open is
// legitimate; the older one is superseded instead).
//
// RESOLUTION, in order:
//   1. A caller-supplied id (offline clients): insert it idempotently. If the
//      id already exists it is returned as it is — a replay — unless it
//      belongs to another (pet, org, vet), which is refused.
//   2. Otherwise: open visits for the key are swept first — stale ones
//      (older than VISIT_STALE_HOURS by the DATABASE clock) are closed as
//      `expired`, and every open one but the newest is closed as
//      `superseded`. The newest survivor is reused.
//   3. Nothing left open → a new visit, with the requested modality, else the
//      appointment's, else `clinic`. Care is never refused for want of a
//      visit: this runs implicitly in front of every Atender writer.

import {
  VISIT_STALE_HOURS,
  type Visit,
  type VisitKey,
  type VisitModality,
  visitMatchesKey,
} from "../domain/types";
import type { OpenVisit, VisitsRepositoryPort } from "./ports";

export type EnsureOpenVisitDeps = {
  repo: VisitsRepositoryPort;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  /** Override for tests only; production uses VISIT_STALE_HOURS. */
  staleHours?: number;
};

export type EnsureOpenVisitInput = VisitKey & {
  /** Caller-minted visit id (offline clients). */
  visitId?: string;
  /** Explicit choice from "Iniciar atención"; absent on the implicit path. */
  modality?: VisitModality;
  appointmentId?: string | null;
};

export type EnsureOpenVisitResult =
  | {
      ok: true;
      visit: Visit;
      /** True when this call opened the visit. */
      created: boolean;
    }
  | {
      ok: false;
      /**
       * foreign_visit       — the caller-supplied id names another pet, org or vet's visit.
       * foreign_appointment — the appointment is not this pet's at this organization.
       */
      reason: "foreign_visit" | "foreign_appointment";
    };

export async function ensureOpenVisit(
  deps: EnsureOpenVisitDeps,
  input: EnsureOpenVisitInput,
): Promise<EnsureOpenVisitResult> {
  const { repo } = deps;
  const staleHours = deps.staleHours ?? VISIT_STALE_HOURS;
  const key: VisitKey = {
    petId: input.petId,
    organizationId: input.organizationId,
    vetUserId: input.vetUserId,
  };

  return deps.transaction(async (tx) => {
    await repo.lockVisitKey(key, tx);

    const modality = await resolveModality(repo, input, key, tx);
    if (modality === "foreign_appointment") return { ok: false, reason: "foreign_appointment" };

    if (input.visitId) {
      const { visit, inserted } = await repo.insertVisitIfAbsent(
        { ...key, id: input.visitId, modality, appointmentId: input.appointmentId ?? null },
        tx,
      );
      if (!visitMatchesKey(visit, key)) return { ok: false, reason: "foreign_visit" };
      if (inserted) await sweepOpenVisits(repo, key, staleHours, visit.id, tx);
      return { ok: true, visit, created: inserted };
    }

    const survivor = await sweepOpenVisits(repo, key, staleHours, null, tx);
    if (survivor) {
      if (input.modality && input.modality !== survivor.modality) {
        const changed = await repo.setModalityIfEmpty(survivor.id, input.modality, tx);
        if (changed) {
          return {
            ok: true,
            visit: { ...stripStale(survivor), modality: input.modality },
            created: false,
          };
        }
      }
      return { ok: true, visit: stripStale(survivor), created: false };
    }

    const { visit } = await repo.insertVisitIfAbsent(
      { ...key, modality, appointmentId: input.appointmentId ?? null },
      tx,
    );
    return { ok: true, visit, created: true };
  });
}

/**
 * Close stale and superseded open visits for the key. Returns the one open
 * visit left standing, if any. `keepId` (a visit this call just inserted) is
 * never closed and is treated as the newest.
 */
async function sweepOpenVisits(
  repo: VisitsRepositoryPort,
  key: VisitKey,
  staleHours: number,
  keepId: string | null,
  tx: unknown,
): Promise<OpenVisit | null> {
  const open = await repo.findOpenVisits(key, staleHours, tx);
  let survivor: OpenVisit | null = keepId ? (open.find((v) => v.id === keepId) ?? null) : null;

  for (const visit of open) {
    if (visit.id === keepId) continue;
    if (visit.stale) {
      await repo.expireVisit(visit.id, tx);
      continue;
    }
    if (survivor === null) {
      survivor = visit; // newest first: the first fresh one wins
      continue;
    }
    await repo.supersedeVisit(visit.id, tx);
  }
  return survivor;
}

async function resolveModality(
  repo: VisitsRepositoryPort,
  input: EnsureOpenVisitInput,
  key: VisitKey,
  tx: unknown,
): Promise<VisitModality | "foreign_appointment"> {
  if (!input.appointmentId) return input.modality ?? "clinic";
  const fromAppointment = await repo.findAppointmentModality(input.appointmentId, key, tx);
  if (fromAppointment === null) return "foreign_appointment";
  return input.modality ?? fromAppointment;
}

function stripStale(visit: OpenVisit): Visit {
  const { stale: _stale, ...rest } = visit;
  return rest;
}
