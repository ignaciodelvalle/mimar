// Where a CASE-keyed ENO row is bound for — the authority that must be told.
//
// PO rule: a bite counts WHERE IT HAPPENED. The bite_incident case already
// carries that jurisdiction (report-bite.ts / report-bite-from-org.ts open it
// with the incident's place taken WHOLE — a province with no locality is a
// province-level case, and a pin no province could be read from is an
// unresolved case with no jurisdiction — never field by field; the pet's home
// pair is used only when the report carried no place and no pin at all,
// localidades-por-id A2). The ENO row follows the case, never the
// pet's CURRENT registration: a CABA bite by a Córdoba pet notifies CABA.
//
// Resolution, for an event of animal P:
//   1. rabies_observation_ended → the bite case it closes: the event's own
//      case_id, else the case_id of its rabies_observation_started.
//   2. any other case-family event (a diagnosis, the signal it derives) → the
//      bite case of P's most relevant observation: an OPEN bite_incident case
//      first, else the most recently opened one. A diagnosis is written with no
//      case id, and this is what lets it meet the close of the same case.
//   3. no bite case at all → the fallback the caller passes (the pet's home):
//      there is no incident to route by.
//
// Only rows a rule keys to a case family are resolved here; every other ENO
// row keeps routing by the pet, as before.

import { and, desc, eq, sql } from "drizzle-orm";

import { cases, petEvents } from "@/db/schema";

import type { EnoTarget } from "./event-outbox-rules";

type Reader = Pick<typeof import("@/db").db, "select">;

async function caseJurisdiction(tx: Reader, caseId: string): Promise<EnoTarget | null> {
  const [row] = await tx
    .select({
      jurisdictionProvince: cases.jurisdictionProvince,
      jurisdictionLocality: cases.jurisdictionLocality,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);
  return row ?? null;
}

async function eventCaseId(tx: Reader, eventId: string): Promise<string | null> {
  const [row] = await tx
    .select({ caseId: petEvents.caseId })
    .from(petEvents)
    .where(eq(petEvents.id, eventId))
    .limit(1);
  return row?.caseId ?? null;
}

export async function resolveEnoTargetJurisdiction(
  tx: Reader,
  event: { id: string; petId: string; eventType: string; payload: Record<string, unknown> },
  fallback: EnoTarget,
): Promise<EnoTarget> {
  if (event.eventType === "rabies_observation_ended") {
    let caseId = await eventCaseId(tx, event.id);
    const startedId = event.payload.observation_started_event_id;
    if (!caseId && typeof startedId === "string") caseId = await eventCaseId(tx, startedId);
    const target = caseId ? await caseJurisdiction(tx, caseId) : null;
    return target ?? fallback;
  }

  const [bite] = await tx
    .select({
      jurisdictionProvince: cases.jurisdictionProvince,
      jurisdictionLocality: cases.jurisdictionLocality,
    })
    .from(cases)
    .where(and(eq(cases.primaryPetId, event.petId), eq(cases.caseKind, "bite_incident")))
    .orderBy(sql`(${cases.status} = 'open') desc`, desc(cases.openedAt))
    .limit(1);
  return bite ?? fallback;
}
