// The owner-path guard against the welfare_denuncia bridge-event leak — ONE
// definition for every read of an owner's pet_events.
//
// A denuncia writes bridge events on the denounced animal
// (maltreatment_reported / abandonment_reported / symptom_observed, see
// create-welfare-report.ts) carrying the denuncia's case_id, the reporter as
// recordedByUserId, the relato and the exact point. The owner is the subject
// of that investigation: none of it is theirs to read (art. 17 reporter
// reserve). RLS hides those rows (0115); the application reads with a
// service connection, so every owner-facing read carries this clause, and
// the subject-rights export applies the same hide in SQL (0262).
//
// Filtered by case_id, NOT by event_type: an owner's own symptom_observed has
// a NULL case_id and always passes (the correlated NOT EXISTS never matches a
// NULL), and a future bridge event type is covered without an edit.
//
// Which reads carry it is fenced by __tests__/subject-hidden-event-read-coverage.test.ts.

import { and, eq, exists, inArray, not, sql } from "drizzle-orm";

import { cases, db, petEvents } from "@/db";
import { HIDDEN_FROM_SUBJECT_CASE_KINDS } from "@/lib/infra/case-access";

export function notHiddenFromSubjectClause() {
  return not(
    exists(
      db
        .select({ one: sql`1` })
        .from(cases)
        .where(
          and(
            eq(cases.id, petEvents.caseId),
            inArray(cases.caseKind, [...HIDDEN_FROM_SUBJECT_CASE_KINDS]),
          ),
        ),
    ),
  );
}
