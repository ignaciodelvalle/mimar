// closeVisit — the vet ends the sitting ("Terminar atención").
//
// Auth: none here. The action edge has already authorized the caller at this
// organization. The use-case scopes the close to the organization (a visit id
// from another org resolves to not_found) and closes AT MOST ONCE: closed_at
// is taken from the database clock, and closing an already-closed visit is a
// no-op that reports the original close. No event is written — the close is a
// timestamp on operational metadata, not a fact about the pet, and the events
// grouped under the visit are never touched (append-only).

import type { Visit } from "../domain/types";
import type { VisitsRepositoryPort } from "./ports";

export type CloseVisitDeps = {
  repo: VisitsRepositoryPort;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type CloseVisitInput = {
  visitId: string;
  organizationId: string;
  actorUserId: string;
};

export type CloseVisitResult =
  | { ok: true; visit: Visit; alreadyClosed: boolean }
  | { ok: false; reason: "not_found" };

export async function closeVisit(
  deps: CloseVisitDeps,
  input: CloseVisitInput,
): Promise<CloseVisitResult> {
  return deps.transaction(async (tx) => {
    const result = await deps.repo.closeVisit(
      {
        id: input.visitId,
        organizationId: input.organizationId,
        closedByUserId: input.actorUserId,
      },
      tx,
    );
    if (!result) return { ok: false, reason: "not_found" };
    return { ok: true, visit: result.visit, alreadyClosed: !result.closedNow };
  });
}
