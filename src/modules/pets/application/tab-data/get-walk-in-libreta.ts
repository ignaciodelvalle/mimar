// getWalkInLibreta — the pet's health record as a walk-in clinic reads it in
// Atender, BEFORE recording anything (vet-visit-record, 2026-09-29).
//
// WHY NOT getLibretaFaceData. Its queries require the viewer to HOLD the pet
// (viewerHoldsPetClause) — the point of a libreta read by an owner or by the
// org that has the animal in custody. A walk-in clinic holds nothing: the
// owner walked in with the credential. That clause returns zero rows here, so
// reusing it would render an empty history that reads as "no history".
//
// NO AUTH HERE, and this is the one place that matters: the caller MUST have
// resolved resolveAtenderPet for this pet first (event.write on the
// organization + the DIM code) — the same boundary that lets the clinic write
// on the animal lets it read what it is about to write next to. The page
// withholds both together when that fails.
//
// WHAT IT SHOWS — the ORG audience, never more:
//   · only libreta-sanitaria types (libretaSanitariaClause) — the health
//     record, not custody, transfers or the owner's private notes;
//   · no self-scans, no authority-only signals, nothing a holder reported;
//   · corrections applied (overlayAmendments), the corrections themselves not
//     listed;
//   · no attachment URLs — a walk-in reader sees that a file exists, never the
//     file (a signed URL is the file).
// Bounded like the libreta face: the newest WALK_IN_WINDOW records.

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import { attachments, db, organizations, petEvents } from "@/db";
import { excludeAuthorityOnlyClause, excludeSelfScansClause } from "@/lib/events/events";
import { overlayAmendments } from "@/lib/infra/amendment";
import { notReportedClause } from "@/lib/infra/content-reports";
import { libretaSanitariaClause } from "@/lib/infra/libreta-sanitaria";

import { loadVisitSummaries } from "./load-visit-summaries";
import type { HistorialEventRow, LibretaVisitSummary } from "./types";

const WALK_IN_WINDOW = 100;

export type WalkInLibreta = {
  past: HistorialEventRow[];
  /** True when older records exist beyond the window. */
  truncated: boolean;
  visits: Record<string, LibretaVisitSummary>;
};

export async function getWalkInLibreta(petId: string): Promise<WalkInLibreta> {
  const raw = await db
    .select()
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        // The corrections ride along so they can be applied; they are not
        // libreta types themselves and are dropped after the overlay.
        or(libretaSanitariaClause(), sql`event_type = 'event_amended'`),
        excludeSelfScansClause(),
        excludeAuthorityOnlyClause(),
        notReportedClause(),
      ),
    )
    .orderBy(desc(petEvents.occurredAt))
    .limit(WALK_IN_WINDOW + 1);

  const truncated = raw.length > WALK_IN_WINDOW;
  const windowed = truncated ? raw.slice(0, WALK_IN_WINDOW) : raw;
  const projected = overlayAmendments(windowed).filter((e) => e.eventType !== "event_amended");

  const eventIds = projected.map((e) => e.id);
  const orgIds = [
    ...new Set(
      projected.map((e) => e.authorOrganizationId).filter((id): id is string => Boolean(id)),
    ),
  ];
  const [attachmentRows, orgRows, visits] = await Promise.all([
    eventIds.length > 0
      ? db
          .select({ eventId: attachments.eventId })
          .from(attachments)
          .where(inArray(attachments.eventId, eventIds))
      : Promise.resolve([]),
    orgIds.length > 0
      ? db
          .select({ id: organizations.id, displayName: organizations.displayName })
          .from(organizations)
          .where(inArray(organizations.id, orgIds))
      : Promise.resolve([]),
    loadVisitSummaries(projected),
  ]);
  const withFile = new Set(attachmentRows.map((a) => a.eventId));
  const orgName = new Map(orgRows.map((o) => [o.id, o.displayName]));

  const past: HistorialEventRow[] = projected.map((e) => ({
    ...e,
    authorOrgName: e.authorOrganizationId ? (orgName.get(e.authorOrganizationId) ?? null) : null,
    attachmentUrl: null,
    hasAttachment: withFile.has(e.id),
    amendedAt:
      e.amendedAt instanceof Date ? e.amendedAt : e.amendedAt ? new Date(e.amendedAt) : null,
  }));

  return { past, truncated, visits };
}
