// The repository PORT the visit use-cases talk to.
//
// Declared in the application layer, implemented by
// infrastructure/visits-repository.ts (`satisfies VisitsRepositoryPort`), so
// every use-case test can run with a plain object literal. Method names equal
// their implementation's names on purpose (the fences that follow call edges
// match by name — see src/modules/caretakers/infrastructure/caretakers-repository.ts).
//
// Every method takes the caller's transaction: opening a visit is a
// read-decide-write sequence that is only correct under the advisory lock
// taken by lockVisitKey, and that lock lives exactly as long as the
// transaction.

import type { Visit, VisitKey, VisitModality } from "../domain/types";

export type OpenVisit = Visit & {
  /** Computed by the DATABASE clock: opened_at < now() - stale window. */
  stale: boolean;
};

export type InsertVisitArgs = VisitKey & {
  /** Caller-supplied id (offline clients). Absent → the database mints one. */
  id?: string;
  modality: VisitModality;
  appointmentId: string | null;
};

export interface VisitsRepositoryPort {
  /** Serializes every open/reuse decision for one (pet, org, vet). Transaction-scoped. */
  lockVisitKey(key: VisitKey, tx: unknown): Promise<void>;

  /**
   * Insert a visit. With an `id`, idempotent: ON CONFLICT (id) DO NOTHING, and
   * the row that owns the id is returned either way — the caller must check it
   * belongs to the key it asked for.
   */
  insertVisitIfAbsent(
    args: InsertVisitArgs,
    tx: unknown,
  ): Promise<{ visit: Visit; inserted: boolean }>;

  findVisitById(id: string, tx: unknown): Promise<Visit | null>;

  /** Open visits for the key, newest first, each flagged stale or not. */
  findOpenVisits(key: VisitKey, staleHours: number, tx: unknown): Promise<OpenVisit[]>;

  /**
   * Close as `expired`. closed_at = the last event recorded under the visit,
   * or its opening time when it recorded none — never "now", which would
   * claim the sitting lasted until whoever noticed.
   */
  expireVisit(id: string, tx: unknown): Promise<void>;

  /** Close as `superseded`, at the database's now(). */
  supersedeVisit(id: string, tx: unknown): Promise<void>;

  /** Change modality only while no event references the visit. True when it changed. */
  setModalityIfEmpty(id: string, modality: VisitModality, tx: unknown): Promise<boolean>;

  /**
   * The appointment's modality, when the appointment is for this pet at this
   * organization; null when it is not (a foreign appointment id).
   */
  findAppointmentModality(
    appointmentId: string,
    key: Pick<VisitKey, "petId" | "organizationId">,
    tx: unknown,
  ): Promise<VisitModality | null>;

  /**
   * Close as `vet` at the database's now(), once: a visit already closed is
   * left untouched and returned as it is. Null when no visit of this
   * organization has this id.
   */
  closeVisit(
    args: { id: string; organizationId: string; closedByUserId: string },
    tx: unknown,
  ): Promise<{ visit: Visit; closedNow: boolean } | null>;
}
