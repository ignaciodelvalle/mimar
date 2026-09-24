// Lost-pet listing DB query — split from `lib/lost-listing.ts` so the
// shared module (types, codecs, label helpers) stays free of `db` imports
// and can be consumed by client components without dragging the postgres
// driver into the client bundle.
//
// Server callers (page.tsx, sitemap.ts) import from here; everything else
// imports from `@/lib/lost-listing`.

import { and, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";

import { attachments, db, petEvents, pets } from "@/db";
import { notReportedClause } from "@/lib/infra/content-reports";

import type {
  LostListingCursor,
  LostListingFilters,
  LostListingItem,
} from "@/lib/infra/lost-listing";

const DEFAULT_PAGE_SIZE = 24;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

export async function queryLostListing(
  filters: LostListingFilters,
  cursor: LostListingCursor | null,
  pageSize: number = DEFAULT_PAGE_SIZE,
  // Overrides the superset cap computed below. Two callers, for two reasons:
  //
  //   · TESTS. The superset-ordering defect below only exists ABOVE the cap,
  //     and the real value is 500 — a fixture large enough to cross it needs
  //     500+ pets AND 500+ spine events, and pet_events cannot be torn down
  //     without the audited mutation-override hatch. Shrinking the cap
  //     reproduces the SAME mechanism at six rows: the bug is about ordering,
  //     and ordering does not care what the number is.
  //   · BULK CALLERS THAT FILTER NOTHING (app/sitemap.ts, since audit
  //     A03-G3/G8). The ×5 superset exists so /perdidas can drop rows by time
  //     bucket and still fill a page; a caller with no such filter gets nothing
  //     from it but a five-times-larger scan. This comment used to say "never
  //     passed in production", and the sitemap was the caller paying for that:
  //     5,000 became 25,000.
  fetchCapOverride?: number,
): Promise<{ items: LostListingItem[]; nextCursor: LostListingCursor | null }> {
  // Stage 1 — pull the pet rows in status='lost' that match the structural
  // filters. We overshoot by pageSize+1 to detect "more pages", same
  // pagination trick as queryAdoptionListing.
  //
  // Filters that depend on the latest status_changed event (visto bucket,
  // criticality, cursor) are applied AFTER we resolve the event lookup,
  // in JS, because the latest event has to be picked per pet first.
  // THE SOFT-DELETE FILTER IS NOT OPTIONAL HERE (PO-4). Erasure (Ley 25.326
  // art. 16) sets `pets.deleted_at` and leaves the row so the append-only spine
  // survives; the credential at /p/{token} then 404s. Without this predicate
  // /perdidas kept rendering the card — name, breed, colour, sex, photo,
  // "Localidad, Provincia", "hace N días" — and `app/sitemap.ts`, which builds
  // its `/p/{token}` entries from THIS function's results, kept handing that
  // dead URL to search engines daily at priority 0,85. A card that links to a
  // 404 makes "erased" distinguishable from "never existed", which is precisely
  // what the erasure decision says must not be observable. Pets are never
  // anonymised, so everything on the card survives the erasure intact.
  //
  // Seeded (synthetic) pets are excluded too, here and in both counts below: a
  // real sighting on one would be a real act the govt queues then hide
  // (lib/domain/synthetic-pet.ts). The sitemap inherits this.
  const baseConditions = [eq(pets.status, "lost"), isNull(pets.deletedAt), isNull(pets.seedTag)];

  if (filters.species) baseConditions.push(eq(pets.species, filters.species));
  if (filters.province) baseConditions.push(eq(pets.jurisdictionProvince, filters.province));
  if (filters.locality) baseConditions.push(eq(pets.jurisdictionLocality, filters.locality));
  if (filters.color) baseConditions.push(ilike(pets.color, `%${filters.color}%`));
  // hasMicrochip filter: EXISTS against canonical pet_identifications
  // (same ARCH-M idiom used by queryAdoptionListing).
  if (filters.hasMicrochip === true) {
    baseConditions.push(
      sql`EXISTS (
        SELECT 1 FROM pet_identifications pi
        WHERE pi.pet_id = ${pets.id}
          AND pi.kind = 'microchip_iso'
          AND pi.status = 'active'
      )`,
    );
  }

  // Sterilized: derive via EXISTS subquery on pet_events. Same pattern as
  // queryAdoptionListing's isSterilized SELECT-side computation, but here
  // we filter rather than select-only.
  if (filters.isSterilized === true) {
    baseConditions.push(
      sql`EXISTS (
        SELECT 1 FROM pet_events e
        WHERE e.pet_id = ${pets.id}
          AND e.event_type = 'sterilization_performed'
      )`,
    );
  }

  // We don't yet know which pets pass the time-bucket filter; fetch a
  // generous superset and trim after joining the latest event.
  // 500 is the same cap fetchLostPets uses in govt-dashboards.
  const fetchCap = fetchCapOverride ?? Math.max(500, pageSize * 5);

  // ORDER BY on the superset, not just on the 24 we keep.
  //
  // This LIMIT used to run unordered. Below ~500 lost pets that is invisible —
  // the cap takes everything, and the JS sort at the bottom of this function
  // produces the right answer. Past it, Postgres hands back an ARBITRARY 500
  // rows (whatever the scan yields), the JS sort orders that accidental window,
  // and the page confidently presents it as "the most recent". Staging crossed
  // the threshold on 2026-08-01 with 4011 lost pets and the three genuinely
  // newest — including the only lost pet in the database that has a photo —
  // were nowhere on page 1. Verified against the live page, not inferred.
  //
  // The sort key lives only in the event spine (there is no pets.lost_at
  // column), so ordering costs a correlated subquery. It selects occurred_at
  // and nothing else: the Item-27 split below still decides who gets the
  // location PAYLOAD, and this changes none of that. The timestamp itself is
  // already shown for every pet, disclosing or not.
  const markedLostAtSql = sql<Date>`(
    SELECT max(e.occurred_at) FROM pet_events e
    WHERE e.pet_id = ${pets.id}
      AND e.event_type = 'status_changed'
      AND e.payload->>'to_status' = 'lost'
  )`;

  const baseRows = await db
    .select({
      petId: pets.id,
      petPublicToken: pets.publicToken,
      name: pets.name,
      species: pets.species,
      breed: pets.breed,
      sex: pets.sex,
      color: pets.color,
      primaryPhotoId: pets.primaryPhotoId,
      primaryPhotoStoragePath: attachments.storagePath,
      jurisdictionProvince: pets.jurisdictionProvince,
      jurisdictionLocality: pets.jurisdictionLocality,
      // hasMicrochip: EXISTS, never the code. The card renders a "Con chip"
      // badge — a boolean — and /perdidas is unauthenticated. Selecting the
      // 15-digit canonical value for every lost pet in the country put it one
      // `"use client"` away from the public RSC payload. Same standard as the
      // Item-27 location split below: don't fetch PII you only need to test for
      // presence, rather than fetch it and redact in JS.
      hasMicrochip: sql<boolean>`EXISTS (
        SELECT 1 FROM pet_identifications pi
        WHERE pi.pet_id = ${pets.id}
          AND pi.kind = 'microchip_iso'
          AND pi.status = 'active'
      )`,
      discloseLastLocationWhenLost: pets.discloseLastLocationWhenLost,
      isSterilized: sql<boolean>`EXISTS (
        SELECT 1 FROM pet_events e
        WHERE e.pet_id = ${pets.id}
          AND e.event_type = 'sterilization_performed'
      )`,
    })
    .from(pets)
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    .where(and(...baseConditions))
    // NULLS LAST: a pet whose status is 'lost' with no status_changed event to
    // match is dropped further down anyway (allItems skips rows with no
    // timestamp). Sorting it to the front would spend the 500-row budget on
    // rows guaranteed to be discarded.
    .orderBy(sql`${markedLostAtSql} DESC NULLS LAST`)
    .limit(fetchCap);

  if (baseRows.length === 0) return { items: [], nextCursor: null };

  // Stage 2 — for every candidate pet, pull the latest status_changed event
  // where to_status='lost'. That row carries markedLostAt + (for pets that
  // consent to location disclosure) the location snapshot from the payload.
  //
  // PII fix (Item 27): we split the query into two sets:
  //   - disclosing pets  → fetch timestamp + location payload (owner opted in)
  //   - non-disclosing pets → fetch timestamp ONLY, no payload columns
  // This ensures pets with discloseLastLocationWhenLost=false never have their
  // location data retrieved from Postgres at all, not merely redacted in JS.
  //
  // Prefer the canonical `location_description` key; fall back to the legacy
  // `last_known_location` for events written before the key rename (same
  // pattern as the public credential page at app/p/[publicToken]/page.tsx).
  const petIds = baseRows.map((r) => r.petId);
  const disclosingIds = baseRows.filter((r) => r.discloseLastLocationWhenLost).map((r) => r.petId);
  // A Set, not `disclosingIds.includes`: the includes form is O(n·d), invisible
  // at /perdidas' 500 rows and hundreds of millions of comparisons on the event
  // loop at the sitemap's old 25,000 (audit A03-G5/G8). Same result, O(n).
  const disclosingIdSet = new Set(disclosingIds);
  const nonDisclosingIds = petIds.filter((id) => !disclosingIdSet.has(id));

  // Fetch location-carrying events only for disclosing pets. hasPin is a
  // presence BOOLEAN (the listing never shows coords, so the values stay out
  // of memory — same standard as hasMicrochip above); it feeds the
  // "Punto marcado en el mapa" fallback when the record has a pin but no
  // address.
  const disclosingEventRows =
    disclosingIds.length > 0
      ? await db
          .select({
            petId: petEvents.petId,
            occurredAt: petEvents.occurredAt,
            // Project the two keys this reader ever consumes instead of the
            // whole payload column (audit A03-G10): the origin event's jsonb
            // also carries `reason` (owner free text),
            // `disclosure_prefs_snapshot` and `lost_description` — none of
            // which this reader reads — so pulling the whole column landed
            // them in server memory for up to 25,000 pets on the sitemap path
            // (A03-G8) for nothing. Same idiom as
            // load-public-credential.ts:279.
            //
            // nullif(trim(...), '') on BOTH keys (fresh-context review,
            // pre-push): a plain `->>'location_description'` reads a
            // whitespace-only string (" ") as truthy, so a bare `coalesce`
            // picked it over a real `last_known_location` and the listing
            // rendered a blank line instead of falling back.
            locationText: sql<
              string | null
            >`coalesce(nullif(trim(${petEvents.payload}->>'location_description'), ''), nullif(trim(${petEvents.payload}->>'last_known_location'), ''))`,
            hasPin: sql<boolean>`${petEvents.locationLat} IS NOT NULL`,
          })
          .from(petEvents)
          .where(
            and(
              inArray(petEvents.petId, disclosingIds),
              eq(petEvents.eventType, "status_changed"),
              sql`(${petEvents.payload}->>'to_status') = 'lost'`,
            ),
          )
          .orderBy(desc(petEvents.occurredAt))
      : [];

  // Fetch timestamp-only events for non-disclosing pets (no payload column).
  const nonDisclosingEventRows =
    nonDisclosingIds.length > 0
      ? await db
          .select({
            petId: petEvents.petId,
            occurredAt: petEvents.occurredAt,
          })
          .from(petEvents)
          .where(
            and(
              inArray(petEvents.petId, nonDisclosingIds),
              eq(petEvents.eventType, "status_changed"),
              sql`(${petEvents.payload}->>'to_status') = 'lost'`,
            ),
          )
          .orderBy(desc(petEvents.occurredAt))
      : [];

  // Owner last-seen updates (fresh-review F5, QA 2026-08-03): "actualizar
  // última ubicación" appends an owner-authored note_added(kind='sighting')
  // event, so the CURRENT description may live there, not on the
  // status_changed origin — the owner profile, poster and public credential
  // already read it that way. Disclosing pets only (Item-27: non-disclosing
  // pets never have location fetched), and only the description text + the
  // hasPin presence boolean — never the coordinate values.
  const ownerUpdateRows =
    disclosingIds.length > 0
      ? await db
          .select({
            petId: petEvents.petId,
            occurredAt: petEvents.occurredAt,
            locationDescription: sql<
              string | null
            >`nullif(trim(${petEvents.payload}->>'location_description'), '')`,
            hasPin: sql<boolean>`${petEvents.locationLat} IS NOT NULL`,
          })
          .from(petEvents)
          .where(
            and(
              inArray(petEvents.petId, disclosingIds),
              eq(petEvents.eventType, "note_added"),
              eq(petEvents.authorRole, "owner"),
              sql`${petEvents.payload}->>'kind' = 'sighting'`,
              sql`(${petEvents.payload}->>'location_description' IS NOT NULL OR ${petEvents.locationLat} IS NOT NULL)`,
              // BLOQUEANTE, found by a fresh-context review. Without this the
              // canonical scenario this whole mechanism was written for breaks
              // in half: an owner who mistyped their HOME ADDRESS into
              // "actualizar dónde la vieron" takes it down from the credential
              // and it stays on the public `/perdidas` card — and the two
              // public surfaces then DISAGREE, because the credential falls
              // back to the previous update while this one still shows the
              // reported text. It comes down everywhere at once or it has not
              // come down.
              notReportedClause(),
            ),
          )
          .orderBy(desc(petEvents.occurredAt))
      : [];

  // Latest owner update per pet (rows are already occurredAt desc).
  const ownerUpdateByPet = new Map<
    string,
    { occurredAt: Date; locationDescription: string | null; hasPin: boolean }
  >();
  for (const e of ownerUpdateRows) {
    if (!ownerUpdateByPet.has(e.petId)) {
      ownerUpdateByPet.set(e.petId, {
        occurredAt: e.occurredAt instanceof Date ? e.occurredAt : new Date(e.occurredAt as string),
        locationDescription: e.locationDescription,
        hasPin: e.hasPin,
      });
    }
  }

  // Merge into a unified map: disclosing pets get their projected location
  // text (A03-G10 — already coalesced in SQL, never the whole payload),
  // non-disclosing pets get null so location is never present.
  const latestLostByPet = new Map<
    string,
    { occurredAt: Date; locationText: string | null; hasPin: boolean }
  >();
  for (const e of disclosingEventRows) {
    if (!latestLostByPet.has(e.petId)) {
      latestLostByPet.set(e.petId, {
        occurredAt: e.occurredAt,
        locationText: e.locationText,
        hasPin: e.hasPin,
      });
    }
  }
  for (const e of nonDisclosingEventRows) {
    if (!latestLostByPet.has(e.petId)) {
      // locationText is intentionally null — location was never fetched
      // (Item 27), and pin presence is not disclosed either.
      latestLostByPet.set(e.petId, { occurredAt: e.occurredAt, locationText: null, hasPin: false });
    }
  }

  // Stage 3 — build items, apply time/criticality filters, apply privacy
  // gate, sort by markedLostAt desc, then paginate.
  const now = Date.now();
  const sinceMs = (() => {
    if (filters.criticality === "critical") return now - ONE_DAY_MS;
    if (filters.visto === "today") return now - ONE_DAY_MS;
    if (filters.visto === "week") return now - SEVEN_DAYS_MS;
    if (filters.visto === "month") return now - THIRTY_DAYS_MS;
    return null;
  })();

  let allItems: LostListingItem[] = [];
  for (const row of baseRows) {
    const meta = latestLostByPet.get(row.petId);
    if (!meta) continue; // pet flagged lost but no status_changed event — skip

    const occurredAt =
      meta.occurredAt instanceof Date ? meta.occurredAt : new Date(meta.occurredAt as string);
    if (sinceMs !== null && occurredAt.getTime() < sinceMs) continue;

    // location_description is the canonical key; last_known_location is
    // the legacy fallback — coalesced in SQL now (A03-G10), not here. For
    // non-disclosing pets meta.locationText is null (never fetched).
    const rawDescription = meta.locationText?.trim() ? meta.locationText.trim() : null;
    // Overlay: an owner update that belongs to the CURRENT episode
    // (occurredAt >= the latest mark-lost event — updates of a previous
    // episode necessarily predate it) replaces the origin description
    // atomically: its own description wins even when null (the owner's
    // newest record was a pin-only update; relabeling it with a superseded
    // address would lie — same semantics as fetchLostEpisodeForPet).
    const ownerUpdate = ownerUpdateByPet.get(row.petId);
    const updateWins = ownerUpdate && ownerUpdate.occurredAt.getTime() >= occurredAt.getTime();
    const currentDescription = updateWins ? ownerUpdate.locationDescription : rawDescription;
    // Pin presence travels with the SAME winning record (atomic — a pin-only
    // update's pin must not be paired with the origin's address or vice
    // versa). Feeds the "Punto marcado en el mapa" fallback on the card.
    const currentHasPin = updateWins ? ownerUpdate.hasPin : meta.hasPin;
    // lastSeenDescription is null for non-disclosing pets because their
    // payload was never fetched — rawDescription is already null and the
    // overlay query excluded them.
    const lastSeenDescription = row.discloseLastLocationWhenLost ? currentDescription : null;
    const lastSeenHasPin = row.discloseLastLocationWhenLost ? currentHasPin : false;

    allItems.push({
      petId: row.petId,
      petPublicToken: row.petPublicToken,
      name: row.name,
      species: row.species,
      breed: row.breed,
      sex: row.sex,
      color: row.color,
      primaryPhotoId: row.primaryPhotoId,
      primaryPhotoStoragePath: row.primaryPhotoStoragePath,
      jurisdictionProvince: row.jurisdictionProvince,
      jurisdictionLocality: row.jurisdictionLocality,
      hasMicrochip: row.hasMicrochip,
      markedLostAt: occurredAt,
      lastSeenDescription,
      lastSeenHasPin,
      isSterilized: row.isSterilized,
      discloseLastLocationWhenLost: row.discloseLastLocationWhenLost,
    });
  }

  // Sort newest first, deterministic tie-break by petId.
  allItems.sort((a, b) => {
    const diff = b.markedLostAt.getTime() - a.markedLostAt.getTime();
    if (diff !== 0) return diff;
    return a.petId < b.petId ? 1 : a.petId > b.petId ? -1 : 0;
  });

  // Cursor — apply post-sort by skipping any rows newer than the cursor.
  // Tie-break: when timestamps match exactly, only rows with petId < cursor.id
  // come AFTER the cursor row, since the secondary sort is petId desc.
  if (cursor) {
    const cursorMs = new Date(cursor.markedLostAt).getTime();
    allItems = allItems.filter((it) => {
      const t = it.markedLostAt.getTime();
      if (t < cursorMs) return true;
      if (t === cursorMs) return it.petId < cursor.id;
      return false;
    });
  }

  const hasMore = allItems.length > pageSize;
  const items = hasMore ? allItems.slice(0, pageSize) : allItems;
  const last = items.at(-1);
  const nextCursor: LostListingCursor | null =
    hasMore && last ? { markedLostAt: last.markedLostAt.toISOString(), id: last.petId } : null;

  return { items, nextCursor };
}

// Lightweight count helpers for the KPI strip on the page header. Each
// returns just the integer — the DOM strip requests these in parallel
// along with the listing query.
export async function countLostInWindow(sinceMs: number): Promise<number> {
  const since = new Date(Date.now() - sinceMs);
  // status='lost' AND latest status_changed→lost event >= since.
  // Use a subquery so we don't double-count repeat episodes.
  const rows = await db
    .select({
      count: sql<number>`COUNT(DISTINCT ${pets.id})::int`,
    })
    .from(pets)
    .innerJoin(petEvents, eq(petEvents.petId, pets.id))
    .where(
      and(
        eq(pets.status, "lost"),
        // Same PO-4 filter as the listing above: the KPI strip sits on the same
        // page, and a count that includes erased pets contradicts the list
        // underneath it — "12 perdidas esta semana" over eleven cards.
        isNull(pets.deletedAt),
        isNull(pets.seedTag),
        eq(petEvents.eventType, "status_changed"),
        sql`(${petEvents.payload}->>'to_status') = 'lost'`,
        sql`${petEvents.occurredAt} >= ${since.toISOString()}::timestamptz`,
      ),
    );
  return rows[0]?.count ?? 0;
}

export async function countAllLost(): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(pets)
    // PO-4, third of the three predicates on this page. See queryLostListing.
    .where(and(eq(pets.status, "lost"), isNull(pets.deletedAt), isNull(pets.seedTag)));
  return rows[0]?.count ?? 0;
}
