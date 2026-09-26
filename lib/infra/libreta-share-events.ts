// The events a shared libreta link shows (/libreta/compartir/[shareToken]).
//
// Extracted from the page so the clauses can be tested as data. The share is
// the document a vet opens, and it leaves the owner's control the moment it is
// sent, so it carries every subtraction the owner's own libreta carries:
//   - no self-scans (excludeSelfScansClause);
//   - libreta types only, plus event_amended so overlayAmendments can project
//     corrections (groupLibretaEvents never renders the amendment rows);
//   - no reported lost-feed message (notReportedClause);
//   - no denuncia bridge event (notHiddenFromSubjectClause, privacy audit W3):
//     the reporter's relato is not the vet's to read either.

import { and, desc, eq, or } from "drizzle-orm";

import { db, petEvents } from "@/db";
import { excludeSelfScansClause } from "@/lib/events/events";
import { notReportedClause } from "@/lib/infra/content-reports";
import { libretaSanitariaClause } from "@/lib/infra/libreta-sanitaria";
import { notHiddenFromSubjectClause } from "@/lib/infra/subject-hidden-events";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function loadSharedLibretaEvents(petId: string, exec: typeof db | Tx = db) {
  return (
    exec
      // full row deliberate: payload is rendered by LibretaSanitariaView per event type
      .select()
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          excludeSelfScansClause(),
          or(libretaSanitariaClause(), eq(petEvents.eventType, "event_amended")),
          notReportedClause(),
          notHiddenFromSubjectClause(),
        ),
      )
      .orderBy(desc(petEvents.occurredAt))
  );
}
