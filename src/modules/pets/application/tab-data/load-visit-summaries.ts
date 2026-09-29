// The visits a set of libreta records was written in, by id
// (vet-visit-record, 2026-09-29). One round-trip, only the two columns a
// renderer titles an atención block with — no vet, no organization, no
// appointment. No auth here: the caller already decided the reader may see
// these records, and a visit adds nothing about the pet the records do not.

import { inArray } from "drizzle-orm";

import { db, visits } from "@/db";

import type { LibretaVisitSummary } from "./types";

export async function loadVisitSummaries(
  rows: ReadonlyArray<{ visitId?: string | null }>,
): Promise<Record<string, LibretaVisitSummary>> {
  const ids = [...new Set(rows.map((r) => r.visitId).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return {};
  const found = await db
    .select({ id: visits.id, modality: visits.modality, openedAt: visits.openedAt })
    .from(visits)
    .where(inArray(visits.id, ids));
  return Object.fromEntries(
    found.map((v) => [v.id, { modality: v.modality, openedAt: v.openedAt }]),
  );
}
