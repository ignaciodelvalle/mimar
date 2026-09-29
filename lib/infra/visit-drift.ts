// Visits drift — the fifth section of scripts/detect-pet-cache-drift.ts
// (vet-visit-record, 2026-09-29).
//
// A visit is operational metadata (invariant 3): the grouping of what one vet
// wrote for one pet at one organization in one sitting. The facts stay in the
// spine; the visit declares itself as a cache of "where and with whom", and
// this is what checks it against the spine.
//
// WHAT CANNOT DRIFT, and is therefore not checked: a record's pet against its
// visit's pet — the composite FK (visit_id, pet_id) → visits(id, pet_id) makes
// the mismatch unrepresentable.
//
// WHAT IS CHECKED:
//   · modality — a condition_at_intake_recorded snapshots the visit's modality
//     in its payload; the visit row must still say the same (the modality
//     freezes once the visit carries a record, trigger visits_mutation_rules).
//   · organization — a stamped record authored for another organization than
//     its visit's. Trigger pet_events_visit_org_match refuses it at insert;
//     this is the belt under that brace, for rows written before the trigger
//     or by a path that disabled it.
//   · empty expired visits — opened, never used, closed by the stale sweep.
//     INFORMATION, not drift: a vet who pressed "Iniciar atención" and then
//     did not record anything. Reported so the rate is visible.
//
// Set-based on purpose (three queries over the table, not one per pet): the
// checks are joins, and a per-pet loop would pay the round-trip per pet for
// nothing. Read-only.

import { sql } from "drizzle-orm";

import type { db } from "@/db";
import { amendedPayloadText } from "@/lib/infra/amendment-sql";

type Executor = Pick<typeof db, "execute">;

export type VisitModalityDrift = {
  visitId: string;
  petId: string;
  eventId: string;
  visitModality: string;
  recordedModality: string;
};

export type VisitOrganizationDrift = {
  visitId: string;
  petId: string;
  eventId: string;
  visitOrganizationId: string;
  eventOrganizationId: string | null;
};

export type EmptyExpiredVisit = { visitId: string; petId: string };

export type VisitDriftReport = {
  modality: VisitModalityDrift[];
  organization: VisitOrganizationDrift[];
  /** Information only — never counted as drift. */
  emptyExpired: EmptyExpiredVisit[];
};

export async function findVisitDrift(
  executor: Executor,
  opts: { petId?: string } = {},
): Promise<VisitDriftReport> {
  const petFilter = opts.petId ? sql`AND v.pet_id = ${opts.petId}::uuid` : sql``;
  // The intake is amendable: a corrected modality is the one that counts, so
  // the payload is read through the SQL twin of overlayAmendments.
  const recordedModality = amendedPayloadText("modality", {
    id: sql`e.id`,
    payload: sql`e.payload`,
    petId: sql`e.pet_id`,
  });

  const modality = await executor.execute(sql`
    SELECT v.id AS "visitId", v.pet_id AS "petId", e.id AS "eventId",
           v.modality AS "visitModality", ${recordedModality} AS "recordedModality"
      FROM public.visits v
      JOIN public.pet_events e ON e.visit_id = v.id
     WHERE e.event_type = 'condition_at_intake_recorded'
       AND ${recordedModality} IS DISTINCT FROM v.modality
       ${petFilter}
     ORDER BY v.id
  `);

  const organization = await executor.execute(sql`
    SELECT v.id AS "visitId", v.pet_id AS "petId", e.id AS "eventId",
           v.organization_id AS "visitOrganizationId",
           e.author_organization_id AS "eventOrganizationId"
      FROM public.visits v
      JOIN public.pet_events e ON e.visit_id = v.id
     WHERE e.author_organization_id IS DISTINCT FROM v.organization_id
       ${petFilter}
     ORDER BY v.id
  `);

  const emptyExpired = await executor.execute(sql`
    SELECT v.id AS "visitId", v.pet_id AS "petId"
      FROM public.visits v
     WHERE v.close_reason = 'expired'
       AND NOT EXISTS (SELECT 1 FROM public.pet_events e WHERE e.visit_id = v.id)
       ${petFilter}
     ORDER BY v.id
  `);

  return {
    modality: [...modality] as unknown as VisitModalityDrift[],
    organization: [...organization] as unknown as VisitOrganizationDrift[],
    emptyExpired: [...emptyExpired] as unknown as EmptyExpiredVisit[],
  };
}

/** Drift for the exit code: modality and organization. Empty expired visits are not. */
export function visitDriftCount(report: VisitDriftReport): number {
  return report.modality.length + report.organization.length;
}
