// get-libreta-face-data.ts — use-case for Face 2 (Libreta) of the two-face
// pet profile (ADR-4, design.md). Merges the former getLibretaTabData /
// getVacunasTabData / getHistorialTabData fetchers into a single deferred
// query batch. This function does NO auth itself — every caller must resolve
// access first:
//   - app/actions/pet-tab-data.ts's getLibretaFaceData shim runs
//     requirePetAccess before calling this (kept for any remaining/future
//     client-side callers).
//   - app/(app)/mis-mascotas/[publicToken]/page.tsx (PF3 perf fix,
//     2026-07-19) calls this DIRECTLY, passing the access it already
//     resolved once for the whole request — avoids a redundant second
//     requirePetAccess round-trip on every profile load.
// Both allow owner and org-path callers — this use-case itself never returns
// activeShares for org-path callers, so SharesManager stays owner-gated
// regardless of the widened read guard.
//
// Amendment projection (D2, projection-cron audit 2026-07-03 A): the fetched
// stream already contains the event_amended rows, so overlayAmendments
// (lib/infra/amendment.ts — a lib import, NOT an events-module dependency;
// check-dependency-direction stays satisfied) projects corrected payloads +
// amendedAt in one pure pass. Both the timeline rows AND the vaccination
// summary read the PROJECTED stream, so a corrected dose date/name flows
// into every derived view, not just a badge.

import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { mergeFutureLedger } from "@/components/pet-profile/libreta-future.helpers";
import {
  type Organization,
  type Pet,
  appointments,
  attachments,
  db,
  libretaShareTokens,
  organizations,
  ownerships,
  petEvents,
  reminders,
  serviceOfferings,
  timeSlots,
} from "@/db";
import { fetchActiveRemindersForPet, fetchPetWeightHistory } from "@/lib/analytics/owner-dashboard";
import { computeVaccinationSummary } from "@/lib/domain/libreta-health-status";
import { excludeAuthorityOnlyClause, excludeSelfScansClause } from "@/lib/events/events";
import { overlayAmendments } from "@/lib/infra/amendment";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { notReportedClause } from "@/lib/infra/content-reports";
import { withholdUnreadableDecomisoEvidence } from "@/lib/infra/decomiso-evidence-access";
import { viewerHoldsPetClause } from "@/lib/infra/pet-holder-clause";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { eventAttachmentSignedUrl } from "@/lib/infra/storage";
import { notHiddenFromSubjectClause } from "@/lib/infra/subject-hidden-events";
import type { HistorialEventRow, LibretaFaceData } from "./types";

// The owner-path guard against the welfare_denuncia bridge-event leak lives
// in lib/infra/subject-hidden-events.ts (notHiddenFromSubjectClause), shared
// with every other owner read of pet_events.

// ---------------------------------------------------------------------------
// Bounded reads (perf/scale review 2026-07-04, P0 "Unbounded libreta event
// loads" — get-libreta-face-data.ts:86-102 had no LIMIT at all).
// ---------------------------------------------------------------------------

// Rendered-timeline window. A 10+ year pet can carry thousands of pet_events
// rows; loading all of them (with full JSONB payloads) on every profile view
// risks the 60s serverless budget at province scale. LIMIT+1 lets us detect
// truncation without a second COUNT query (same probe pattern as
// app/admin/govts/page.tsx's `LIMIT 50+1`).
const PAST_EVENTS_WINDOW = 250;

// Whitelist for vaccination-summary correctness. computeVaccinationSummary
// needs the pet's COMPLETE vaccination history — a dose from years ago still
// determines "already has core vaccine X, next due <date>" — so this second
// query is intentionally UNCAPPED. It stays cheap at scale because it's
// bounded by event TYPE, not a row limit (mirrors the whitelist pattern in
// fetchPetEventsForProfileV2, lib/analytics/owner-dashboard.ts:1500-1520).
// `event_amended` rows are included so overlayAmendments can correct a
// vaccination event's name/date even when the original dose falls outside
// the PAST_EVENTS_WINDOW above.
const VACCINATION_SUMMARY_EVENT_TYPES = ["vaccination_administered", "event_amended"] as const;

/**
 * Per-caller knobs. Everything here defaults to what the web page does, so an
 * existing call site keeps its behaviour byte for byte.
 */
export type LibretaFaceOptions = {
  /**
   * Whether to mint signed URLs for the rendered window's attachments.
   *
   * `true` (default) is the web page: it renders thumbnails inline, so it needs
   * a URL per event. `false` is for a caller that reports only the PRESENCE of a
   * file (`HistorialEventRow.hasAttachment`) and serves the file itself
   * elsewhere — the native libreta endpoint does exactly that, because a signed
   * URL is equivalent to handing out the file and a timeline would hand out up
   * to `PAST_EVENTS_WINDOW` of them into a payload a device holds.
   *
   * It is not only a privacy knob. Signing is one Storage round-trip PER
   * attachment (perf/scale review 2026-07-04, P1 "Signed URL fan-out"), so a
   * caller that discards the URLs is paying that fan-out for nothing.
   */
  signAttachments?: boolean;
};

export async function getLibretaFaceData(
  context: {
    user: { id: string };
    pet: Pet;
    accessPath: "owner" | "org";
    organization: Organization | null;
  },
  options: LibretaFaceOptions = {},
): Promise<{ ok: true; data: LibretaFaceData } | { ok: false; error: string }> {
  const { user, pet, accessPath } = context;
  const signAttachments = options.signAttachments ?? true;

  const [
    rawWindowEvents,
    vaccinationSummaryEvents,
    activeReminders,
    pendingMedicationReminders,
    upcomingAppointments,
    weightSamples,
    identifications,
    activeShares,
    dueSoonWindowRule,
    currentOwnerRows,
  ] = await Promise.all([
    // Rendered timeline — bounded window (PAST_EVENTS_WINDOW + 1 probe row).
    db
      .select()
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, pet.id),
          // The viewer must hold the pet IN the query, not only at the caller's
          // requirePetAccess (A01-5 follow-up, fresh-context security review).
          // Constant pet.id, not the correlated petEvents.petId column — the
          // WHERE already pins this query to one pet (eq() above), so passing
          // the column re-proves an identical EXISTS once per matched row
          // instead of once (fresh performance review, same day).
          viewerHoldsPetClause(user.id, sql`${pet.id}`),
          excludeSelfScansClause(),
          // Authority-only surveillance signals never reach owner OR org
          // libreta views (§6) — clickthrough audit 2026-07-03 caught an
          // outbreak_signal row rendered in the owner timeline.
          excludeAuthorityOnlyClause(),
          // Owner-path only — org/vet viewers are never the investigation
          // subject, so the hidden-case filter doesn't apply to them.
          accessPath === "owner" ? notHiddenFromSubjectClause() : undefined,
          // A lost-feed message the holder reported. `note_added` IS a libreta
          // type, so an abusive sighting was rendering here as
          // "Avistaje · {finderName}" with its full text — in the record a vet
          // reads. Unlike the hidden-case clause above this applies on EVERY
          // access path: the message is no less abusive to an org viewer.
          notReportedClause(),
        ),
      )
      .orderBy(desc(petEvents.occurredAt))
      .limit(PAST_EVENTS_WINDOW + 1),
    // Vaccination-summary source — UNCAPPED but type-narrow (see
    // VACCINATION_SUMMARY_EVENT_TYPES docblock above). Same privacy filters as
    // the timeline query so a hidden-case or authority-only event can never
    // leak into the vaccination summary either.
    db
      .select()
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, pet.id),
          // Constant pet.id — see the timeline query above for why.
          viewerHoldsPetClause(user.id, sql`${pet.id}`),
          inArray(petEvents.eventType, [...VACCINATION_SUMMARY_EVENT_TYPES]),
          excludeSelfScansClause(),
          excludeAuthorityOnlyClause(),
          accessPath === "owner" ? notHiddenFromSubjectClause() : undefined,
        ),
      )
      .orderBy(asc(petEvents.occurredAt)),
    accessPath === "owner" ? fetchActiveRemindersForPet(user.id, pet.id) : Promise.resolve([]),
    db
      .select()
      .from(reminders)
      .where(
        and(
          eq(reminders.petId, pet.id),
          eq(reminders.reminderType, "medication"),
          isNull(reminders.completedAt),
        ),
      )
      .orderBy(asc(reminders.dueAt)),
    db
      .select({
        publicToken: appointments.publicToken,
        offeringDisplayName: serviceOfferings.displayName,
        slotStartsAt: timeSlots.startsAt,
      })
      .from(appointments)
      .innerJoin(timeSlots, eq(timeSlots.id, appointments.slotId))
      .innerJoin(serviceOfferings, eq(serviceOfferings.id, appointments.serviceOfferingId))
      .where(
        and(
          eq(appointments.petId, pet.id),
          eq(appointments.status, "confirmed"),
          gt(timeSlots.startsAt, new Date()),
        ),
      )
      .orderBy(asc(timeSlots.startsAt))
      .limit(10),
    fetchPetWeightHistory(user.id, pet.id),
    fetchActiveIdentifications(pet.id),
    accessPath === "owner"
      ? db
          .select()
          .from(libretaShareTokens)
          .where(and(eq(libretaShareTokens.petId, pet.id), isNull(libretaShareTokens.revokedAt)))
      : Promise.resolve([]),
    // due_soon_window (admin-rules-console, design ADR-4 item 2) — resolved
    // via the pet's own jurisdiction, pet-scoped resolution.
    resolveBusinessRule("due_soon_window", {
      country: "AR",
      province: pet.jurisdictionProvince,
      locality: pet.jurisdictionLocality,
    }),
    // The pet's CURRENT titular — one row at most
    // (`ownerships_one_active_owner_per_pet`), served by ownerships_pet_id_idx.
    // Feeds the provenance stamp so an owner-declared asiento written by
    // SOMEONE ELSE reads "Cargado por el titular anterior" instead of silently
    // reattributing itself to whoever is holding the pet today.
    db
      .select({ ownerUserId: ownerships.ownerUserId })
      .from(ownerships)
      .where(
        and(eq(ownerships.petId, pet.id), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
      )
      .limit(1),
  ]);

  // PAST_EVENTS_WINDOW + 1 probe: strip the probe row and flag truncation.
  const pastTruncated = rawWindowEvents.length > PAST_EVENTS_WINDOW;
  const pastEvents = pastTruncated ? rawWindowEvents.slice(0, PAST_EVENTS_WINDOW) : rawWindowEvents;

  // Signed attachment URLs — one batched Storage round-trip. Only the
  // rendered window needs signing (vaccinationSummaryEvents never render).
  // Org display names resolve in the same round-trip: the asiento "Aplicó"
  // attribution needs the signing org's name so a vet/org-signed record never
  // falls back to "Declarado por el titular" (staging validation 2026-07-04).
  const eventIds = pastEvents.map((e) => e.id);
  const authorOrgIds = [
    ...new Set(
      pastEvents
        .map((e) => e.authorOrganizationId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const [allAttachmentRows, authorOrgRows] = await Promise.all([
    eventIds.length > 0
      ? db.select().from(attachments).where(inArray(attachments.eventId, eventIds))
      : Promise.resolve([]),
    authorOrgIds.length > 0
      ? db
          .select({ id: organizations.id, displayName: organizations.displayName })
          .from(organizations)
          .where(inArray(organizations.id, authorOrgIds))
      : Promise.resolve([]),
  ]);
  const orgNameById = new Map(authorOrgRows.map((o) => [o.id, o.displayName]));
  // Decomiso evidence keeps its metadata (PO decision D7): withheld unless the
  // viewer reads the decomiso itself — before the "has a file" set too, so the
  // withheld file is not announced either.
  const attachmentRows = await withholdUnreadableDecomisoEvidence(allAttachmentRows, user.id);
  // WHICH events carry a file — derived from the rows, never from the URLs, so
  // a caller that opts out of signing still reports the attachment honestly
  // instead of reporting "no file" for every asiento.
  const eventsWithAttachment = new Set(
    attachmentRows.map((a) => a.eventId).filter((id): id is string => typeof id === "string"),
  );
  const urlByEventId = new Map<string, string>();
  if (signAttachments) {
    await Promise.all(
      attachmentRows.map(async (a) => {
        if (!a.eventId) return;
        const url = await eventAttachmentSignedUrl(a.storagePath);
        if (url) urlByEventId.set(a.eventId, url);
      }),
    );
  }

  // Project amendments over the rendered window (module docblock) — timeline
  // payloads and the Corregido badge (amendedAt) read corrected values.
  // Correct across the page boundary WITHOUT re-fetching the full history:
  // an event_amended row's occurredAt is always "now" (the moment the
  // correction was made), so it is always among the most-recent rows and
  // therefore always inside this DESC-ordered window — a correction can
  // never be silently dropped by the LIMIT. The only thing that can fall
  // outside the window is the ORIGINAL event being corrected; when that
  // happens the original isn't rendered anyway, so there's no stale/
  // half-corrected row on screen — nothing to project it onto.
  const projectedEvents = overlayAmendments(pastEvents);

  const past: HistorialEventRow[] = projectedEvents.map((e) => ({
    ...e,
    authorOrgName: e.authorOrganizationId
      ? (orgNameById.get(e.authorOrganizationId) ?? null)
      : null,
    attachmentUrl: urlByEventId.get(e.id) ?? null,
    hasAttachment: eventsWithAttachment.has(e.id),
    amendedAt:
      e.amendedAt instanceof Date ? e.amendedAt : e.amendedAt ? new Date(e.amendedAt) : null,
  }));

  // Vaccination summary is computed from the SEPARATE uncapped/type-narrow
  // query (VACCINATION_SUMMARY_EVENT_TYPES docblock) — NOT from the bounded
  // `past` window above — so "already has core vaccine X" stays correct even
  // when the pet's timeline is longer than PAST_EVENTS_WINDOW.
  const summary = computeVaccinationSummary(
    overlayAmendments(vaccinationSummaryEvents),
    pet.species,
    new Date(),
    dueSoonWindowRule.payload.days,
  );

  const future = mergeFutureLedger(
    activeReminders.map((r) => ({
      reminderId: r.reminderId,
      title: r.title,
      dueAt: r.dueAt,
      variant: r.variant,
    })),
    upcomingAppointments,
    pendingMedicationReminders.map((r) => ({
      reminderId: r.id,
      drugName: r.title,
      dueAt: r.dueAt,
    })),
  );

  return {
    ok: true,
    data: {
      identity: {
        name: pet.name,
        species: pet.species,
        breed: pet.breed,
        sex: pet.sex,
        microchipId: identifications.microchip?.code ?? null,
        tattooCode: identifications.tattoo?.code ?? null,
        tattooLocation: identifications.tattoo?.tattooLocation ?? null,
        publicToken: pet.publicToken,
      },
      future,
      past,
      pastTruncated,
      summary,
      weightSamples,
      activeShares,
      accessPath,
      viewer: {
        userId: user.id,
        currentOwnerUserId: currentOwnerRows[0]?.ownerUserId ?? null,
      },
    },
  };
}
