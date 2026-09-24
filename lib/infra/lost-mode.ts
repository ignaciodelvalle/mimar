// Query helpers for the lost-mode cockpit (pet.status === 'lost').
//
// Two pure server queries, each shaped to match the exact prop contracts
// of the cockpit components in components/pet-profile/.

import type { ScanFeedItem } from "@/components/pet-profile/LostScanFeed";
import { cases, db, petEvents } from "@/db";
import { notReportedClause } from "@/lib/infra/content-reports";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LostEpisode = {
  /** DB primary key. */
  id: string;
  /** Human-readable case code, e.g. "LOS-00042". */
  publicCode: string;
  /** When the case was opened — used as lostSince. */
  openedAt: Date;
  /** Municipality / locality label for display. */
  jurisdictionLocality: string | null;
  /**
   * Best-effort place name: the status_changed event's location_description,
   * OVERLAID by the latest owner-authored "actualizar última ubicación"
   * update when one carries an address (QA 2026-08-03: before the overlay,
   * an owner who set the address via "editar" never saw it reflected — the
   * update writes a new note_added event, and this read only looked at the
   * originating status_changed).
   */
  placeName: string | null;
  /** Owner note from the status_changed event (reason field). */
  ownerNote: string | null;
  /** Number of sightings logged after the original open (approximation). */
  sightingsCount: number;
  /**
   * When the displayed location was reported: the latest owner update's
   * occurredAt when the overlay applies, else openedAt.
   */
  lastSeenAt: Date;
  /**
   * Precise latitude (numeric string from Drizzle — parse with Number()).
   * From the CURRENT last-seen record: the latest owner update carrying
   * location data when one exists (applied atomically with placeName and
   * lastSeenAt — never mixed across events), else the originating
   * status_changed row. Null when that record has no pin.
   */
  lastSeenLat: string | null;
  /**
   * Precise longitude — same sourcing/overlay as lastSeenLat.
   */
  lastSeenLng: string | null;
};

// ---------------------------------------------------------------------------
// publicSightingMapCenter — ciclo-perdido tester fix #5
// ---------------------------------------------------------------------------

/**
 * Initial map center for the PUBLIC sighting form (/p/[token]/sighting):
 * the pet's last-known lost location instead of the microcentro default.
 *
 * PRIVACY GATE: the public form may only use location data the owner chose to
 * publish. When `discloseLastLocationWhenLost` is false — or there simply is
 * no recorded point — this returns null and the map keeps its neutral
 * default. Pure and exported for unit tests (both branches).
 */
export function publicSightingMapCenter(input: {
  discloseLastLocationWhenLost: boolean;
  lastSeenLat: string | null | undefined;
  lastSeenLng: string | null | undefined;
}): { lat: number; lng: number } | null {
  if (!input.discloseLastLocationWhenLost) return null;
  if (input.lastSeenLat == null || input.lastSeenLng == null) return null;
  const lat = Number(input.lastSeenLat);
  const lng = Number(input.lastSeenLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// ---------------------------------------------------------------------------
// fetchLostEpisodeForPet
// ---------------------------------------------------------------------------

/**
 * Returns the single OPEN lost_pet_episode case for a pet, or null.
 *
 * Also fetches the originating status_changed event to extract:
 *   - location_description → placeName for LostLastSeenCard
 *   - reason → ownerNote for LostLastSeenCard
 * then overlays the latest owner-authored "actualizar última ubicación"
 * update (note_added kind='sighting' with location data) onto
 * placeName / coords / lastSeenAt — see LostEpisode field docs.
 *
 * sightingsCount is derived from note_added events where
 * payload->>'kind' = 'sighting' since the episode opened.
 */
export async function fetchLostEpisodeForPet(petId: string): Promise<LostEpisode | null> {
  const [caseRow] = await db
    .select({
      id: cases.id,
      publicCode: cases.publicCode,
      openedAt: cases.openedAt,
      jurisdictionLocality: cases.jurisdictionLocality,
    })
    .from(cases)
    .where(
      and(
        eq(cases.primaryPetId, petId),
        eq(cases.caseKind, "lost_pet_episode"),
        eq(cases.status, "open"),
      ),
    )
    .limit(1);

  if (!caseRow) return null;

  const openedAt =
    caseRow.openedAt instanceof Date ? caseRow.openedAt : new Date(caseRow.openedAt as string);

  // Fetch the originating status_changed event for location + note.
  const [originEvent] = await db
    .select({
      payload: petEvents.payload,
      locationLat: petEvents.locationLat,
      locationLng: petEvents.locationLng,
    })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "status_changed"),
        eq(petEvents.caseId, caseRow.id),
      ),
    )
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);

  const payload = (originEvent?.payload ?? {}) as Record<string, unknown>;
  let placeName =
    typeof payload.location_description === "string" && payload.location_description.trim()
      ? payload.location_description.trim()
      : null;
  const ownerNote =
    typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : null;

  // Coords from the event row — set when the owner dropped a pin in
  // LocationFields at mark-lost time. Drizzle returns numeric columns as
  // strings; callers parse with Number() before passing to map components.
  let lastSeenLat =
    originEvent?.locationLat !== null && originEvent?.locationLat !== undefined
      ? String(originEvent.locationLat)
      : null;
  let lastSeenLng =
    originEvent?.locationLng !== null && originEvent?.locationLng !== undefined
      ? String(originEvent.locationLng)
      : null;

  // Overlay: the latest owner-authored location update for this episode.
  // "Actualizar última ubicación" (updateLostLastSeen) appends a
  // note_added(kind='sighting') event instead of mutating the origin
  // status_changed (append-only invariant), so the CURRENT location must be
  // derived from the newest owner update that actually carries location data
  // (an address in payload.location_description and/or a dropped pin).
  // authorRole='owner' excludes anonymous finder sightings ('scanner') —
  // finder-supplied text is unvetted and must never become the headline.
  const [ownerUpdate] = await db
    .select({
      payload: petEvents.payload,
      locationLat: petEvents.locationLat,
      locationLng: petEvents.locationLng,
      occurredAt: petEvents.occurredAt,
    })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "note_added"),
        eq(petEvents.caseId, caseRow.id),
        eq(petEvents.authorRole, "owner"),
        sql`${petEvents.payload}->>'kind' = 'sighting'`,
        sql`(${petEvents.payload}->>'location_description' IS NOT NULL OR ${petEvents.locationLat} IS NOT NULL)`,
        // A reported update is not the headline either — including one the
        // OWNER wrote and then took down. See notReportedClause.
        notReportedClause(),
      ),
    )
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);

  let lastSeenAt = openedAt;
  if (ownerUpdate) {
    // ATOMIC replacement: the chosen update becomes the current last-seen
    // record as a unit — place, coords and timestamp all come from the same
    // event (or become null together). Mixing fields across events produced
    // contradictions (fresh-review F4): a text-only update would relabel the
    // ORIGIN pin with an address it isn't at, and a pin-only update would
    // resurrect an address the owner had already superseded.
    const updatePayload = (ownerUpdate.payload ?? {}) as Record<string, unknown>;
    placeName =
      typeof updatePayload.location_description === "string" &&
      updatePayload.location_description.trim()
        ? updatePayload.location_description.trim()
        : null;
    const hasUpdateCoords = ownerUpdate.locationLat != null && ownerUpdate.locationLng != null;
    lastSeenLat = hasUpdateCoords ? String(ownerUpdate.locationLat) : null;
    lastSeenLng = hasUpdateCoords ? String(ownerUpdate.locationLng) : null;
    lastSeenAt =
      ownerUpdate.occurredAt instanceof Date
        ? ownerUpdate.occurredAt
        : new Date(ownerUpdate.occurredAt as string);
  }

  // Real sightings count: note_added events scoped to this case via caseId.
  // Belt-and-suspenders: also require occurredAt >= openedAt in case any legacy
  // rows predate the caseId column being populated.
  const [sightingsResult] = await db
    .select({ total: count() })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "note_added"),
        eq(petEvents.caseId, caseRow.id),
        gte(petEvents.occurredAt, openedAt),
        sql`${petEvents.payload}->>'kind' = 'sighting'`,
        // A reported sighting is not shown, so it is not counted either. See
        // notReportedClause.
        notReportedClause(),
      ),
    );

  return {
    id: caseRow.id,
    publicCode: caseRow.publicCode,
    openedAt,
    jurisdictionLocality: caseRow.jurisdictionLocality,
    placeName,
    ownerNote,
    sightingsCount: sightingsResult?.total ?? 0,
    lastSeenAt,
    lastSeenLat,
    lastSeenLng,
  };
}

// ---------------------------------------------------------------------------
// fetchLatestLostDescription
// ---------------------------------------------------------------------------

export type LatestLostDescription = {
  accessoriesWhenLost: string | null;
  behaviorNotes: string | null;
  lastSeenContext: string | null;
};

/**
 * The `lost_description` snapshot (accessories/behavior/last-seen context)
 * from the pet's MOST RECENT prior `pet_marked_lost` episode, or null when
 * there is none.
 *
 * Prefills a SECOND "Marcar como perdida" wizard (medianos-sesión-2 finding
 * #3): `pet.color`/`pet.distinguishingFeatures` already carry forward
 * correctly (`setPetLostWriter` persists them onto the pet row every episode
 * — see updatePetLostProjection), but `accessories_when_lost`,
 * `behavior_notes` and `last_seen_context` live ONLY in the `status_changed`
 * event's payload, never on the pet row — so a diligent owner who typed
 * "collar rojo, se asusta de los autos" on episode 1 saw those fields blank
 * on episode 2, despite events being the source of truth (invariant #2).
 *
 * Events are append-only: this reads the LATEST status_changed(to_status=
 * 'lost') event carrying a `lost_description`, not a cached/mutable column.
 */
export async function fetchLatestLostDescription(
  petId: string,
): Promise<LatestLostDescription | null> {
  const [row] = await db
    .select({ payload: petEvents.payload })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "status_changed"),
        sql`${petEvents.payload}->>'to_status' = 'lost'`,
      ),
    )
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);

  if (!row) return null;

  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const lostDescription = (payload.lost_description ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null =>
    typeof lostDescription[key] === "string" && lostDescription[key].trim()
      ? (lostDescription[key] as string).trim()
      : null;

  return {
    accessoriesWhenLost: str("accessories_when_lost"),
    behaviorNotes: str("behavior_notes"),
    lastSeenContext: str("last_seen_context"),
  };
}

// ---------------------------------------------------------------------------
// fetchLostScanEvents
// ---------------------------------------------------------------------------

// Maximum number of items returned by fetchLostScanEvents. Exported so
// LostScanFeed can detect the cap and render an honest truncation notice.
export const LOST_SCAN_FEED_CAP = 200;

/**
 * Returns up to LOST_SCAN_FEED_CAP items in the unified lost-mode feed for a
 * pet since the episode opened. Items are a merge of:
 *   - credential_scanned events (non-self)
 *   - note_added events with payload->>'kind' = 'sighting', scoped to caseId
 *     when provided to prevent cross-episode pollution.
 *   - note_added events with payload->>'kind' = 'finder_in_possession' — the
 *     handoff crux: a finder reporting they physically HAVE the pet. Mapped to
 *     the prominent "finder" feed item so the owner can act immediately.
 *
 * Sorted by occurredAt DESC. Shaped to ScanFeedItem[] for LostScanFeed.
 * When items.length === LOST_SCAN_FEED_CAP the list may have been truncated;
 * callers should surface a note to the user.
 */
export async function fetchLostScanEvents(
  petId: string,
  since?: Date,
  caseId?: string,
): Promise<ScanFeedItem[]> {
  const scanRows = await db
    .select({
      id: petEvents.id,
      occurredAt: petEvents.occurredAt,
      locationLat: petEvents.locationLat,
      locationLng: petEvents.locationLng,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "credential_scanned")))
    .orderBy(desc(petEvents.occurredAt))
    .limit(LOST_SCAN_FEED_CAP);

  // note_added rows for BOTH structured kinds (sighting + finder_in_possession).
  // A single query keeps round-trips low; we route by payload->>'kind' in JS.
  const noteRows = await db
    .select({
      id: petEvents.id,
      occurredAt: petEvents.occurredAt,
      locationLat: petEvents.locationLat,
      locationLng: petEvents.locationLng,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "note_added"),
        // Scope by caseId when available to prevent counting notes from a
        // prior lost episode (lost→found→lost scenario).
        caseId ? eq(petEvents.caseId, caseId) : undefined,
        sql`${petEvents.payload}->>'kind' IN ('sighting', 'finder_in_possession')`,
        // Items the holder reported. Excluded HERE and not after the fetch so
        // the cap below is spent on rows somebody will actually see.
        notReportedClause(),
      ),
    )
    .orderBy(desc(petEvents.occurredAt))
    .limit(LOST_SCAN_FEED_CAP);

  const passesSince = (occurredAt: Date | string) => {
    if (!since) return true;
    const at = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
    return at >= since;
  };

  // Filter self-scans + apply `since` gate.
  const filteredScans = scanRows.filter((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    if (p.is_self_scan === true) return false;
    return passesSince(r.occurredAt);
  });

  const filteredNotes = noteRows.filter((r) => passesSince(r.occurredAt));

  const scanItems: ScanFeedItem[] = filteredScans.map((r) => ({
    kind: "scan",
    id: r.id,
    at: r.occurredAt instanceof Date ? r.occurredAt : new Date(r.occurredAt as string),
    count: 1,
    localityLabel: null,
  }));

  const noteItems: ScanFeedItem[] = filteredNotes.map((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const at = r.occurredAt instanceof Date ? r.occurredAt : new Date(r.occurredAt as string);
    const photoStoragePath =
      typeof p.photoStoragePath === "string" && p.photoStoragePath ? p.photoStoragePath : null;
    const finderContact =
      typeof p.finderContact === "string" && p.finderContact ? p.finderContact : null;

    if (p.kind === "finder_in_possession") {
      // The finder claims physical custody — the most actionable feed item.
      // Carry contact, condition, location, message and availability so the
      // cockpit can surface everything the owner needs to arrange pickup.
      const finderName =
        typeof p.finderName === "string" && p.finderName.trim() ? p.finderName.trim() : "Alguien";
      const petCondition = typeof p.petCondition === "string" ? p.petCondition : null;
      const loc = (p.location ?? {}) as Record<string, unknown>;
      const localityName = typeof loc.localityName === "string" ? loc.localityName : null;
      const provinceName = typeof loc.provinceName === "string" ? loc.provinceName : null;
      const localityLabel = localityName
        ? provinceName
          ? `${localityName}, ${provinceName}`
          : localityName
        : null;
      const rawMessage = typeof p.message === "string" ? p.message : null;
      const message = rawMessage ? rawMessage.slice(0, 160) : null;
      const availabilityLabel =
        p.canKeepIndefinite === true
          ? "indefinido"
          : typeof p.canKeepUntil === "string" && p.canKeepUntil
            ? p.canKeepUntil
            : null;
      return {
        kind: "finder",
        id: r.id,
        at,
        finderName,
        finderContact,
        petCondition,
        localityLabel,
        message,
        availabilityLabel,
        photoStoragePath,
      };
    }

    // Default: sighting.
    const rawText = typeof p.text === "string" ? p.text : null;
    const description = rawText ? rawText.slice(0, 80) : null;
    const lat =
      r.locationLat !== null && r.locationLat !== undefined ? String(r.locationLat) : null;
    const lng =
      r.locationLng !== null && r.locationLng !== undefined ? String(r.locationLng) : null;
    return {
      kind: "sighting",
      id: r.id,
      at,
      description,
      localityLabel: null,
      lat: lat && lat !== "null" ? lat : null,
      lng: lng && lng !== "null" ? lng : null,
      photoStoragePath,
      finderContact,
    };
  });

  // Merge and sort. Finder-in-possession items always sort to the TOP regardless
  // of recency — the person HAS the pet, so it outranks scans/sightings. Within
  // each group, newest first.
  const merged = [...scanItems, ...noteItems].sort((a, b) => {
    const aFinder = a.kind === "finder" ? 1 : 0;
    const bFinder = b.kind === "finder" ? 1 : 0;
    if (aFinder !== bFinder) return bFinder - aFinder;
    return b.at.getTime() - a.at.getTime();
  });
  return merged.slice(0, LOST_SCAN_FEED_CAP);
}
