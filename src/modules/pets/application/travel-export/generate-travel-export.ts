// Travel doc bundle use-case (movilidad-jurisdiccional Fase 1, Capability 5).
// Clones the generate-ppp-export.ts flow: ownership check → DTO → pdf-lib →
// upload to private bucket → signed URL (24h) → audit log with schemaVersion.
//
// Role gate: owner-only (R4.2/R5 — same strict ownership stance as PPP:
// the pet must belong to the authenticated user via ownerships, no org path).
//
// Storage bucket `travel-exports` is OWNER OPS — created in Supabase Studio
// before deploy, never from code (R5.2). If the bucket is missing, the upload
// fails and the caller receives "storage_upload_failed".

import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { auditLog, db, ownerships, petEvents, pets, profiles } from "@/db";
import {
  TRAVEL_EXPORT_SCHEMA_VERSION,
  buildTravelExportPath,
  createSignedTravelExportUrl,
  generateTravelExportPdf,
  uploadTravelExportToStorage,
} from "@/lib/analytics/travel-exports";
import { overlayAmendments } from "@/lib/infra/amendment";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { deriveTravelCompliance, deriveTravelContext } from "@/lib/projections/travel-compliance";
import { type CorridorId, getCorridor } from "@/lib/reference/cross-border-corridors";
import { formatDateTimeLegal } from "@/lib/utils/format";

import type { GenerateTravelExportResult } from "./types";

// 24h TTL for the export PDF signed URL (same as PPP).
const EXPORT_URL_TTL_SECONDS = 24 * 60 * 60;

export async function generateTravelExport(
  petPublicToken: string,
): Promise<GenerateTravelExportResult> {
  const { user } = await requireUserOrRedirect();

  // Ownership check: pet must exist and belong to this user (strict owner-path).
  const [ownerRow] = await db
    .select({
      petId: pets.id,
      petName: pets.name,
      petSpecies: pets.species,
      petJurisdictionCountry: pets.jurisdictionCountry,
      petJurisdictionProvince: pets.jurisdictionProvince,
      petJurisdictionLocality: pets.jurisdictionLocality,
    })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, petPublicToken),
        eq(ownerships.ownerUserId, user.id),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);

  if (!ownerRow) return { ok: false, error: "not_found" };

  // Same event window the /viaje RSC reads — projection parity (invariant #3).
  const rawEvents = await db
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, ownerRow.petId),
        inArray(petEvents.eventType, [
          "movement_recorded",
          "vaccination_administered",
          "event_amended",
        ]),
      ),
    )
    .orderBy(asc(petEvents.occurredAt));

  const events = overlayAmendments(rawEvents);
  const movementPayloads = events
    .filter((e) => e.eventType === "movement_recorded")
    .map((e) => (e.payload ?? {}) as Record<string, unknown>);

  if (movementPayloads.length === 0) return { ok: false, error: "no_movement_context" };

  const now = new Date();
  const context = deriveTravelContext(movementPayloads, now);
  const corridors = context.corridorIds.map((id) => getCorridor(id as CorridorId));

  const state = deriveTravelCompliance({
    now,
    origin: {
      country: ownerRow.petJurisdictionCountry ?? "AR",
      province: ownerRow.petJurisdictionProvince,
      locality: ownerRow.petJurisdictionLocality,
    },
    destinations: context.destinations,
    corridors,
    travelDate: context.travelDate,
    events: events
      .filter((e) => e.eventType === "vaccination_administered")
      .map((e) => ({ eventType: e.eventType, payload: e.payload, occurredAt: e.occurredAt })),
  });

  const [ownerProfile] = await db
    .select({ displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);

  const exportGeneratedAt = new Date();
  const dto = {
    petName: ownerRow.petName,
    petPublicToken,
    petSpecies: ownerRow.petSpecies,
    ownerDisplayName: ownerProfile?.displayName ?? "Propietario",
    // AR-pinned legal timestamp with explicit TZ label (bug 4 — same ambient-
    // zone pattern as the MPF/PPP exports, fixed together).
    exportGeneratedAt: formatDateTimeLegal(exportGeneratedAt),
    semaforo: state.semaforo,
    corridors: state.corridorsShown,
    obligations: state.obligations,
  };

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await generateTravelExportPdf(dto);
  } catch (err) {
    console.error("[travel-export] PDF render failed:", err);
    return { ok: false, error: "pdf_render_failed" };
  }

  const storagePath = buildTravelExportPath(
    petPublicToken,
    context.corridorIds,
    exportGeneratedAt.getTime(),
  );

  // Storage runs as service role (migration 0172) — the strict ownership check
  // above is the authorization; the bucket has no authenticated policy.
  const uploadResult = await uploadTravelExportToStorage(storagePath, pdfBytes);
  if ("error" in uploadResult) {
    console.error("[travel-export] Storage upload failed:", uploadResult.error);
    return { ok: false, error: "storage_upload_failed" };
  }

  const signedUrl = await createSignedTravelExportUrl(storagePath, EXPORT_URL_TTL_SECONDS);
  if (!signedUrl) return { ok: false, error: "signed_url_failed" };

  // Audit log (R5.3): petId, petPublicToken, corridor ids, schemaVersion.
  await db.insert(auditLog).values({
    actorUserId: user.id,
    action: "travel_export_generated",
    payload: {
      petId: ownerRow.petId,
      petPublicToken,
      corridorIds: context.corridorIds,
      semaforo: state.semaforo,
      schemaVersion: TRAVEL_EXPORT_SCHEMA_VERSION,
    },
  });

  return {
    ok: true,
    signedUrl,
    expiresAt: new Date(Date.now() + EXPORT_URL_TTL_SECONDS * 1000),
  };
}
