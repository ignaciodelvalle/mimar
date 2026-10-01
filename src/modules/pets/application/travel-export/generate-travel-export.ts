// Travel doc bundle use-case (movilidad-jurisdiccional Fase 1, Capability 5;
// rebuilt on loadTravelView in viajes-fase-2, Phase 7).
// Clones the generate-ppp-export.ts flow: titular check → DTO → pdf-lib →
// upload to private bucket → signed URL (24h) → audit log with schemaVersion.
//
// ONE READING, THREE SURFACES. The PDF is drawn from `loadTravelView` — the
// loader /viaje and `GET /api/v1/pets/{token}/travel` render from — so the
// semáforo, the obligations, their sources and their freshness on paper are
// the ones on the screen for the same trip. Fase 1 re-derived the semáforo
// here from every active trip at once (deriveTravelContext), which could print
// Chile's rules on a Uruguay trip and a green the screen did not show.
//
// TWO DOORS, ONE CORE. `exportTravelPdfForViewer` is the core; the web's Server
// Action reaches it through `generateTravelExport` (cookie session + the
// ownership join below), and the native app through
// `POST /api/v1/pets/{token}/travel/export` (bearer + resolvePetHolderAccess).
// Both hand it the viewer they resolved, and the loader applies
// canAccessTravel before it reads anything.
//
// Role gate: titular-only (R4.2/R5 — same strict ownership stance as PPP:
// the pet must belong to the authenticated user via ownerships, no org path —
// and, since viajes-fase-2 D8, TRAVEL_TITULAR_ROLES only).
//
// Storage bucket `travel-exports` is OWNER OPS — created in Supabase Studio
// before deploy, never from code (R5.2). If the bucket is missing, the upload
// fails and the caller receives "storage_upload_failed".

import { and, eq, inArray, isNull } from "drizzle-orm";

import { auditLog, db, ownerships, pets, profiles } from "@/db";
import {
  TRAVEL_EXPORT_SCHEMA_VERSION,
  type TravelExportDto,
  buildTravelExportPath,
  createSignedTravelExportUrl,
  generateTravelExportPdf,
  uploadTravelExportToStorage,
} from "@/lib/analytics/travel-exports";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { TRAVEL_TITULAR_ROLES } from "@/lib/infra/travel-private-events";
import { MODALITY_LABELS } from "@/lib/projections/travel-libreta-checks";
import { formatDateTimeLegal } from "@/lib/utils/format";
import {
  type TravelView,
  type TravelViewPet,
  type TravelViewer,
  loadTravelView,
  travelTripSummary,
} from "@/src/modules/pets/application/travel/load-travel-view";

import type { GenerateTravelExportResult } from "./types";

// 24h TTL for the export PDF signed URL (same as PPP).
const EXPORT_URL_TTL_SECONDS = 24 * 60 * 60;

/** The pet as the export needs it: the view's columns plus its names. */
export type TravelExportPet = TravelViewPet & {
  publicToken: string;
  name: string;
};

/**
 * The PDF's data, from ONE travel view. Pure: the semáforo, the obligations
 * and the corridor disclosures are the view's own, untouched — nothing here
 * re-derives or re-words a verdict. Null when the view has no trip to read.
 */
export function buildTravelExportDto(params: {
  pet: TravelExportPet;
  view: TravelView;
  ownerDisplayName: string;
  generatedAt: Date;
}): TravelExportDto | null {
  const { pet, view } = params;
  const trip = view.selectedTrip;
  const compliance = view.compliance;
  if (!trip || !compliance) return null;

  return {
    petName: pet.name,
    petPublicToken: pet.publicToken,
    petSpecies: pet.species,
    ownerDisplayName: params.ownerDisplayName,
    // AR-pinned legal timestamp with explicit TZ label (bug 4 — same ambient-
    // zone pattern as the MPF/PPP exports, fixed together).
    exportGeneratedAt: formatDateTimeLegal(params.generatedAt),
    tripSummary: travelTripSummary(trip),
    semaforo: compliance.semaforo,
    corridors: compliance.corridorsShown,
    airline: view.airline
      ? {
          name: view.airline.name,
          modality: trip.intendedModality ? MODALITY_LABELS[trip.intendedModality] : null,
          sourceUrl: view.airline.sourceUrl,
          lastVerifiedAt: view.airline.lastVerifiedAt,
        }
      : null,
    obligations: compliance.obligations,
  };
}

/**
 * The core both doors call: read the titular's travel view for one trip,
 * render it, store it, sign it, audit it.
 *
 * `not_found` for a viewer canAccessTravel refuses — the SAME answer as a pet
 * that does not exist, so the door cannot be used to learn which animals a
 * caller holds without being their titular.
 */
export async function exportTravelPdfForViewer(params: {
  userId: string;
  pet: TravelExportPet;
  viewer: TravelViewer;
  /** The trip to export; the next one (the screen's default) when null. */
  tripId: string | null;
  now?: Date;
}): Promise<GenerateTravelExportResult> {
  const { pet } = params;
  const now = params.now ?? new Date();

  const loaded = await loadTravelView({
    pet,
    viewer: params.viewer,
    tripId: params.tripId,
    now,
  });
  if (!loaded.ok) return { ok: false, error: "not_found" };
  const { view } = loaded;

  const [ownerProfile] = await db
    .select({ displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.id, params.userId))
    .limit(1);

  const dto = buildTravelExportDto({
    pet,
    view,
    ownerDisplayName: ownerProfile?.displayName ?? "Propietario",
    generatedAt: now,
  });
  if (!dto || !view.corridor) return { ok: false, error: "no_movement_context" };

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await generateTravelExportPdf(dto);
  } catch (err) {
    console.error("[travel-export] PDF render failed:", err);
    return { ok: false, error: "pdf_render_failed" };
  }

  const storagePath = buildTravelExportPath(pet.publicToken, [view.corridor.id], now.getTime());

  // Storage runs as service role (migration 0172) — the titular check inside
  // loadTravelView is the authorization; the bucket has no authenticated policy.
  const uploadResult = await uploadTravelExportToStorage(storagePath, pdfBytes);
  if ("error" in uploadResult) {
    console.error("[travel-export] Storage upload failed:", uploadResult.error);
    return { ok: false, error: "storage_upload_failed" };
  }

  const signedUrl = await createSignedTravelExportUrl(storagePath, EXPORT_URL_TTL_SECONDS);
  if (!signedUrl) return { ok: false, error: "signed_url_failed" };

  // Audit log (R5.3): petId, petPublicToken, corridor ids, semáforo,
  // schemaVersion. Deliberately NO airline_id and NO travel_date (design D7):
  // admin readers of the audit log are not titulars, and those two say when a
  // household is away and how.
  await db.insert(auditLog).values({
    actorUserId: params.userId,
    action: "travel_export_generated",
    payload: {
      petId: pet.id,
      petPublicToken: pet.publicToken,
      corridorIds: [view.corridor.id],
      semaforo: dto.semaforo,
      schemaVersion: TRAVEL_EXPORT_SCHEMA_VERSION,
    },
  });

  return {
    ok: true,
    signedUrl,
    expiresAt: new Date(now.getTime() + EXPORT_URL_TTL_SECONDS * 1000),
  };
}

/** The web door: the cookie session, then the titular ownership join. */
export async function generateTravelExport(
  petPublicToken: string,
  tripId: string | null = null,
): Promise<GenerateTravelExportResult> {
  const { user } = await requireUserOrRedirect();

  // Ownership check: the pet must exist and the user must hold it as a TITULAR
  // on the person path — TRAVEL_TITULAR_ROLES (owner, co-owner, foster), never
  // a caretaker or a user-held shelter_custody row. The PDF carries the trip
  // and the CVI, which only a titular may read (viajes-fase-2, D8 — the same
  // allow-list as canAccessTravel and holdsPetAsTravelTitular). Anyone else
  // gets the same not_found as a pet that does not exist.
  const [ownerRow] = await db
    .select({
      pet: {
        id: pets.id,
        publicToken: pets.publicToken,
        name: pets.name,
        species: pets.species,
        breed: pets.breed,
        dateOfBirth: pets.dateOfBirth,
        birthDateIsEstimated: pets.birthDateIsEstimated,
        jurisdictionCountry: pets.jurisdictionCountry,
        jurisdictionProvince: pets.jurisdictionProvince,
        jurisdictionLocality: pets.jurisdictionLocality,
      },
      role: ownerships.role,
    })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, petPublicToken),
        eq(ownerships.ownerUserId, user.id),
        isNull(ownerships.endedAt),
        inArray(ownerships.role, [...TRAVEL_TITULAR_ROLES]),
      ),
    )
    .limit(1);

  if (!ownerRow) return { ok: false, error: "not_found" };

  return exportTravelPdfForViewer({
    userId: user.id,
    pet: ownerRow.pet,
    viewer: { accessPath: "owner", holderRole: ownerRow.role },
    tripId,
  });
}
