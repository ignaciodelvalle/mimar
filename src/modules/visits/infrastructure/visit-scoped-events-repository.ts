// VisitScopedEventsRepository — an EventsRepository that stamps visit_id.
//
// WHY A REPOSITORY AND NOT A USE-CASE INPUT. pet_events is append-only, so the
// visit link has to be written AT INSERT, by whichever code performs the
// insert. Threading a visitId through the nine Atender use-case inputs would
// touch nine signatures and every one of their tests; instead the Atender
// action resolves the visit (ensureOpenVisit) and hands those use-cases this
// repository in place of the plain one. The use-cases stay untouched.
//
// WHAT GETS STAMPED — and what deliberately does not. Only a row authored for
// the visit's organization BY the visit's vet
// (authorOrganizationId === visit.organizationId && recordedByUserId ===
// visit.vetUserId). A use-case may write rows that are not the vet's act in
// this sitting — a system `outbreak_signal` raised as a side effect, a row
// attributed to nobody — and those stay unstamped: a visit groups what the vet
// did, not everything that happened to be written during the request. The
// database backs the org half of this rule (trigger pet_events_visit_org_match
// refuses a stamped row authored for another organization).
//
// A row that already carries a visitId is left alone — the caller said so
// explicitly.

import "server-only";

import type { NewPetEvent, PetEvent } from "@/db/schema";
import { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";

import type { Visit } from "../domain/types";

type InsertExecutor = Parameters<EventsRepository["insertEvent"]>[1];

export type VisitStampScope = Pick<Visit, "id" | "organizationId" | "vetUserId">;

/** Pure: the values to insert, stamped when they are this visit's vet's act. */
export function stampVisit(values: NewPetEvent, visit: VisitStampScope): NewPetEvent {
  if (values.visitId) return values;
  if (visit.vetUserId === null) return values;
  const isVisitAct =
    values.authorOrganizationId === visit.organizationId &&
    values.recordedByUserId === visit.vetUserId;
  return isVisitAct ? { ...values, visitId: visit.id } : values;
}

export class VisitScopedEventsRepository extends EventsRepository {
  private readonly visit: VisitStampScope;

  constructor(visit: VisitStampScope) {
    super();
    this.visit = visit;
  }

  override async insertEvent(values: NewPetEvent, executor?: InsertExecutor): Promise<PetEvent> {
    return super.insertEvent(stampVisit(values, this.visit), executor);
  }

  override async insertEventIdempotent(
    values: NewPetEvent,
    executor?: InsertExecutor,
  ): Promise<{ event: PetEvent; wasNoop: boolean }> {
    return super.insertEventIdempotent(stampVisit(values, this.visit), executor);
  }
}
