// Every DB read the public credential needs after the pet row, in one place.
//
// WHY IT LEFT THE PAGE (Track 2, item 1)
// ---------------------------------------------------------------------------
// `app/(public)/p/[publicToken]/page.tsx` was 1,452 lines and this loader was
// 394 of them. More importantly, a page component cannot be called by anything
// else, so the reads a native client needs were reachable only by rendering
// React and scraping HTML. The route handler Track 2 adds calls THIS, and the
// page calls it too — one loader, two renderers, no self-fetch.
//
// It is a VERBATIM move. Same queries, same order, same budgets, same degraded
// behaviour. Nothing here is new logic, which is what makes it reviewable: a
// diff that both moves and changes code is a diff nobody can check.
//
// The move was mechanical for a reason worth recording: the loader had ZERO
// identifiers defined in the page. Every free name it used was already an
// import. That is what turned a 400-line extraction out of the repo's most
// carefully built page from a redesign into a relocation.
//
// It also needed two things moved out of the way first, neither of them
// obvious from the plan:
//   1. `credential-badges.ts` sat INSIDE the route folder and was imported
//      relatively, so this file could not have resolved it (now
//      lib/domain/credential-badges.ts).
//   2. `withDbBudgetOrThrow` lived in the panorama module, and `pets:panorama`
//      is not an allowed edge — check-dependency-direction refused the import
//      and was right to (now lib/infra/db-budget.ts).

import {
  type Pet,
  attachments,
  cases,
  db,
  organizations,
  ownerships,
  petEvents,
  petServiceDog,
  profiles,
} from "@/db";
import type { CredentialEvent } from "@/lib/domain/credential-badges";
import { deriveCredentialRegistryClaim } from "@/lib/domain/credential-claims";
import { readPoint } from "@/lib/domain/location";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { resolveCaretakerPublicContact } from "@/lib/infra/caretaker-public-contact";
import { notReportedClause } from "@/lib/infra/content-reports";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { reportError } from "@/lib/infra/report-error";
import { petPhotoUrl } from "@/lib/infra/storage";
import { createAdminClient } from "@/lib/supabase/admin";
import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";

// loadCredentialViewData — ALL post-pet-row DB reads in one budgeted unit.
// The DOOR (lookup-public-credential.ts) wraps this call in withDbBudgetOrThrow
// so a degraded DB yields the honest degraded card instead of a hang or a 500 —
// it moved out of the page along with the decision, which is what lets the route
// handler inherit the same budget instead of copying the number. The queries are
// byte-for-byte the former inline stages — only the await boundary moved.
// ---------------------------------------------------------------------------

export type CredentialViewData = Awaited<ReturnType<typeof loadCredentialViewData>>;

export async function loadCredentialViewData(pet: Pet) {
  // WAVE D1 (Invariant #3): every clinical badge folds `event_amended`
  // corrections via overlayAmendments so a stranger scanning the QR sees the
  // CORRECTED value — same projection the authenticated libreta applies. This
  // shell-side cache now serves only the service-dog rabies warning; the
  // streamed Tier-2 section fetches its own copy (#16a) — at most one extra
  // query, only for the rare tier2-AND-bannered-service-dog pet.
  let amendmentEventsCache: CredentialEvent[] | null = null;
  const getAmendmentEvents = async (): Promise<CredentialEvent[]> => {
    if (amendmentEventsCache === null) {
      amendmentEventsCache = await db
        .select({
          id: petEvents.id,
          eventType: petEvents.eventType,
          occurredAt: petEvents.occurredAt,
          payload: petEvents.payload,
        })
        .from(petEvents)
        .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "event_amended")));
    }
    return amendmentEventsCache;
  };

  // ---------------------------------------------------------------------------
  // Stage 1 — independent reads keyed only off pet.id, run concurrently.
  // These were previously four sequential awaits (canonical ids, vaccination
  // existence, latest-vaccination provenance, open custody episode). None
  // depends on another's result, so a single Promise.all collapses four
  // round-trips into one. This is the hottest public path (every QR scan), so
  // the round-trip reduction is the biggest win here. The lost / tier2 / service
  // -dog reads stay in later conditional stages because they gate on derived
  // flags (isLost, tier2Active, species).
  // ---------------------------------------------------------------------------
  const [
    canonicalIds,
    vaccinationExists,
    latestVaccinationRows,
    openCustodyEpisodeRows,
    rabiesVaccinationRows,
    microchipRegistryRule,
  ] = await Promise.all([
    // Canonical identifier rows — boolean indicators + lost-branch display.
    fetchActiveIdentifications(pet.id),
    // Tier 0 vaccination rollup — only a boolean is needed, so LIMIT 1 instead
    // of fetching the pet's entire vaccination history just to test existence.
    db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "vaccination_administered")))
      .limit(1),
    // A.4: most recent vaccination's provenance to compute the confidence tier.
    db
      .select({
        authorRole: petEvents.authorRole,
        authorVerified: petEvents.authorVerified,
        authorOrganizationId: petEvents.authorOrganizationId,
        payload: petEvents.payload,
      })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "vaccination_administered")))
      .orderBy(desc(petEvents.occurredAt))
      .limit(1),
    // DC13: open custody_episode opened by a sanitary_authority org.
    db
      .select({
        caseId: cases.id,
        authorityName: organizations.displayName,
      })
      .from(cases)
      .innerJoin(
        organizations,
        and(
          eq(organizations.id, cases.openedByOrganizationId),
          eq(organizations.orgType, "sanitary_authority"),
        ),
      )
      .where(
        and(
          eq(cases.primaryPetId, pet.id),
          eq(cases.caseKind, "custody_episode"),
          eq(cases.status, "open"),
        ),
      )
      .limit(1),
    // pet-state-header R4: vaccination rows for the rabies semaphore —
    // HOISTED out of the showServiceDogBanner guard so one bounded fetch
    // serves BOTH the semaphore and the service-dog rabies warning (net zero
    // extra vaccination queries when the banner already fired).
    db
      .select({
        id: petEvents.id,
        eventType: petEvents.eventType,
        occurredAt: petEvents.occurredAt,
        payload: petEvents.payload,
        // Authorship travels with the dose so the semaphore can say whether a
        // professional signed it. Selected here rather than in a second query:
        // the provenance must describe the SAME row the vigencia describes.
        authorRole: petEvents.authorRole,
        authorVerified: petEvents.authorVerified,
        authorOrganizationId: petEvents.authorOrganizationId,
      })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "vaccination_administered")))
      .orderBy(desc(petEvents.occurredAt))
      .limit(50),
    // Credential claim tiering (ADR-7, CT1/CT2) — PII-free rule lookup keyed
    // by the pet's jurisdiction; see lib/domain/credential-claims.ts.
    resolveBusinessRule("microchip_required", {
      province: pet.jurisdictionProvince,
      locality: pet.jurisdictionLocality,
    }),
  ]);

  // Corrections fold into the semaphore + banner (WAVE D1) — one fetch, cached
  // for any later consumer (the streamed Tier-2 section fetches its own copy).
  const rabiesEvents = [...rabiesVaccinationRows, ...(await getAmendmentEvents())];

  // Service-dog row — only queried for dogs (Ley 26.858 scope).
  const [serviceDog] =
    pet.species === "dog"
      ? await db.select().from(petServiceDog).where(eq(petServiceDog.petId, pet.id)).limit(1)
      : [];

  const isLost = pet.status === "lost";

  // Tier 1 reveal: only when the pet is marked lost. Each field is gated by
  // the owner's disclosure preference (disclose_*_when_lost columns on pets).
  // Active pets expose NO owner PII — leave lostContext null.
  //
  // lost_description is always visible if present — these are animal details,
  // not owner contact info, so no disclosure pref gates them (spec §8.4 / §10).
  let lostContext: {
    ownerFirstName: string | null;
    phone: string | null;
    email: string | null;
    locationText: string | null;
    /** Raw "lat, lng" decimal degrees — the demoted line under the map (M3). */
    lastSeenCoords: string | null;
    /** When the DISPLAYED last-seen point was reported (owner update, else the
     *  mark-lost event). Drives the "hace N días" recency the section leads with
     *  — distinct from `lostSince`, which is when the search opened. */
    lastSeenAt: Date | null;
    lostLat: number | null;
    lostLng: number | null;
    lostDescription: {
      accessoriesWhenLost: string | null;
      behaviorNotes: string | null;
      lastSeenContext: string | null;
    } | null;
    lostSince: Date | null;
    /**
     * Alternate public contact — the temporary caretaker (custodia-temporal,
     * PO 2026-08-19). NULL unless BOTH keys hold: the titular's
     * `disclose_caretaker_contact_when_lost` AND the caretaker's own consent,
     * recorded at invitation-accept. The gate is one query in
     * lib/infra/caretaker-public-contact.ts, deliberately not two booleans
     * combined here — see that file for why the two must not be separable.
     */
    caretakerContact: { firstName: string | null; phoneE164: string | null } | null;
  } | null = null;

  if (isLost) {
    // S4 defense-in-depth: only FETCH what the owner opted to disclose. Location
    // (free-text + lat/lng) and phone are pulled from Postgres only when their
    // disclosure flag is set — not fetched-then-redacted. Mirrors the query-level
    // split in lost-listing-read.ts. lost_description (animal identity) and
    // lostSince are always shown, so they are always fetched.
    const showLocation = pet.discloseLastLocationWhenLost;
    const showPhone = pet.disclosePhoneWhenLost;

    const [ownerRows, latestLostEventRows] = await Promise.all([
      db
        .select({
          displayName: profiles.displayName,
          // phone never leaves the DB unless the owner disclosed it.
          phone: showPhone ? profiles.phone : sql<string | null>`null`,
          ownerUserId: ownerships.ownerUserId,
        })
        .from(ownerships)
        .innerJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
        // role='owner' is load-bearing, not decoration. A pet can hold more than
        // one ACTIVE ownerships row: an accepted temporary-caretaker grant
        // (custodia-temporal) inserts a second row with role='caretaker' and no
        // endedAt. Without this predicate the limit(1) below resolved to
        // whichever row the heap returned first, so the titular's
        // `disclose_phone_when_lost` / `disclose_first_name_when_lost` consent
        // could publish the CARETAKER's phone and first name on the public lost
        // credential — a third party who never consented. That is precisely what
        // the two-key model in lib/infra/caretaker-public-contact.ts exists to
        // prevent (the titular may not consent on someone else's behalf), and
        // this query was routing around it. Measured on staging: the one pet
        // with both rows active resolved to the caretaker.
        //
        // orderBy is the second half of the fix. The partial unique index
        // ownerships_one_active_owner_per_pet already caps active owner rows at
        // one, so the ordering is redundant TODAY — it is here so the row choice
        // can never again depend on heap order if that cap ever changes shape.
        .where(
          and(
            eq(ownerships.petId, pet.id),
            eq(ownerships.role, "owner"),
            isNull(ownerships.endedAt),
          ),
        )
        .orderBy(asc(ownerships.startedAt))
        .limit(1),
      // Last-known location from the most recent status_changed → lost event.
      // Filtering on payload->>'to_status' = 'lost' so a later "found" event
      // (to_status='active') does not eclipse the actual lost-event payload.
      // Location keys/columns are projected as SQL NULL when not disclosed, so
      // the raw payload and coordinates never enter server memory.
      db
        .select({
          lostDescriptionJson: sql`${petEvents.payload}->'lost_description'`,
          locationText: showLocation
            ? sql<
                string | null
              >`coalesce(${petEvents.payload}->>'location_description', ${petEvents.payload}->>'last_known_location')`
            : sql<string | null>`null`,
          locationLat: showLocation ? petEvents.locationLat : sql<number | null>`null`,
          locationLng: showLocation ? petEvents.locationLng : sql<number | null>`null`,
          occurredAt: petEvents.occurredAt,
        })
        .from(petEvents)
        .where(
          and(
            eq(petEvents.petId, pet.id),
            eq(petEvents.eventType, "status_changed"),
            sql`${petEvents.payload}->>'to_status' = 'lost'`,
          ),
        )
        .orderBy(desc(petEvents.occurredAt))
        .limit(1),
    ]);
    const [ownerRow] = ownerRows;
    const [latestLostEvent] = latestLostEventRows;

    // Overlay parity with fetchLostEpisodeForPet (fresh-review F1, QA
    // 2026-08-03): "actualizar última ubicación" appends an owner-authored
    // note_added(kind='sighting') event — append-only spine — so the CURRENT
    // last-seen location may live there, not on the status_changed origin.
    // Without this, the public credential a finder scans showed the origin
    // address while the owner profile, poster and sighting map showed the
    // update. Same ATOMIC semantics (place + coords + never mixed across
    // events) and same S4 defense-in-depth: location key/columns projected
    // as SQL NULL when not disclosed. Scoped to the current episode by
    // occurredAt >= the latest mark-lost event (owner updates of a previous
    // episode necessarily predate it). authorRole='owner' keeps unvetted
    // finder sightings out of the headline.
    let ownerUpdate:
      | {
          locationText: string | null;
          // numeric columns come back as string from Drizzle; readPoint
          // normalizes (same shape as latestLostEvent above).
          locationLat: string | number | null;
          locationLng: string | number | null;
          occurredAt: Date;
        }
      | undefined;
    if (latestLostEvent) {
      [ownerUpdate] = await db
        .select({
          locationText: showLocation
            ? sql<string | null>`nullif(trim(${petEvents.payload}->>'location_description'), '')`
            : sql<string | null>`null`,
          locationLat: showLocation ? petEvents.locationLat : sql<number | null>`null`,
          locationLng: showLocation ? petEvents.locationLng : sql<number | null>`null`,
          occurredAt: petEvents.occurredAt,
        })
        .from(petEvents)
        .where(
          and(
            eq(petEvents.petId, pet.id),
            eq(petEvents.eventType, "note_added"),
            eq(petEvents.authorRole, "owner"),
            gte(petEvents.occurredAt, latestLostEvent.occurredAt),
            sql`${petEvents.payload}->>'kind' = 'sighting'`,
            sql`(${petEvents.payload}->>'location_description' IS NOT NULL OR ${petEvents.locationLat} IS NOT NULL)`,
            // Overlay parity, second half: an owner who reported their own
            // update — the way somebody takes down a home address they typed by
            // mistake — must stop seeing it HERE above all, because this is the
            // page a stranger with the QR is reading. `notReportedClause` states
            // the rule and names the one surface it deliberately spares.
            notReportedClause(),
          ),
        )
        .orderBy(desc(petEvents.occurredAt))
        .limit(1);
    }

    const lastSeenSource = ownerUpdate ?? latestLostEvent;
    const textLocation =
      typeof lastSeenSource?.locationText === "string" && lastSeenSource.locationText.length > 0
        ? lastSeenSource.locationText
        : null;
    // Precise lat/lng captured on the event row itself (null unless disclosed).
    const eventPoint = lastSeenSource ? readPoint(lastSeenSource) : null;
    // Raw decimal degrees, for the DEMOTED coordinate line only (UI review M3,
    // PO 2026-08-06). These used to be substituted INTO `locationText` when the
    // event carried no address, so the "Última vez vista" heading led with
    // "-54.806060, -68.304976 · Ushuaia" — six decimal places (≈11 cm) of
    // machine precision as the first thing a worried neighbour reads, with the
    // one word they could act on pushed to the end. The place name and the
    // recency lead now; the numbers ride under the map for the finder who
    // actually wants to type them into a GPS.
    const geoLocation = eventPoint
      ? `${eventPoint.lat.toFixed(6)}, ${eventPoint.lng.toFixed(6)}`
      : null;

    // Split display_name on first whitespace to get just the first name. We
    // never expose the full legal name on a public credential.
    // Guard at resolution: only derive when the owner opted in.
    const firstName =
      pet.discloseFirstNameWhenLost && ownerRow?.displayName
        ? ownerRow.displayName.trim().split(/\s+/)[0]
        : null;

    // Email is stored in auth.users (not profiles). Only fetch it when the
    // owner has opted in — avoids an unnecessary admin API call on every
    // credential page load.
    let ownerEmail: string | null = null;
    if (pet.discloseEmailWhenLost && ownerRow?.ownerUserId) {
      try {
        const adminClient = createAdminClient();
        const { data } = await adminClient.auth.admin.getUserById(ownerRow.ownerUserId);
        ownerEmail = data?.user?.email ?? null;
      } catch (err) {
        // Non-fatal: if email fetch fails, fall through to null (same as
        // if the pref were false). The credential renders without email.
        reportError("public-credential/owner-email", err, { publicToken: pet.publicToken });
        ownerEmail = null;
      }
    }

    // lost_description (spec §8.4) — animal-identity details, always shown if
    // present, no disclosure pref gates them.
    const lostDesc = latestLostEvent?.lostDescriptionJson as
      | {
          accessories_when_lost?: string | null;
          behavior_notes?: string | null;
          last_seen_context?: string | null;
        }
      | null
      | undefined;

    const lostDescription =
      lostDesc &&
      (lostDesc.accessories_when_lost || lostDesc.behavior_notes || lostDesc.last_seen_context)
        ? {
            accessoriesWhenLost: lostDesc.accessories_when_lost ?? null,
            behaviorNotes: lostDesc.behavior_notes ?? null,
            lastSeenContext: lostDesc.last_seen_context ?? null,
          }
        : null;

    lostContext = {
      ownerFirstName: firstName ?? null,
      phone: ownerRow?.phone ?? null,
      email: ownerEmail,
      locationText: textLocation,
      lastSeenCoords: geoLocation,
      lastSeenAt: lastSeenSource?.occurredAt ?? null,
      lostLat: eventPoint?.lat ?? null,
      lostLng: eventPoint?.lng ?? null,
      lostDescription,
      lostSince: latestLostEvent?.occurredAt ?? null,
      // Both keys, resolved in one place. A custody dispute suppresses it for
      // the same reason it suppresses the titular's own contact: the finder's
      // reply would land on a party whose standing is under review.
      //
      // The key-1 test here is REDUNDANT with the resolver's own SQL predicate,
      // and deliberately so — it is the S4 "only FETCH what the owner opted to
      // disclose" rule stated at the top of this block, applied to the strongest
      // case in the family. With the toggle off (the overwhelming default) a
      // third party's phone number is never read out of the database at all,
      // not read and then discarded. The resolver stays correct if called
      // blindly; this just means it usually is not called.
      caretakerContact:
        pet.inCustodyDispute || !pet.discloseCaretakerContactWhenLost
          ? null
          : await resolveCaretakerPublicContact({ petId: pet.id }),
    };
  }

  // Tattoo photo — only resolved in lost mode. Active credentials never
  // query this attachment to keep the data surface minimal (D3 closed
  // 2026-05-22 — code + location + photo are gated by lost status, mirroring
  // how the chip number is gated).
  // Photo ID is sourced from the canonical tattoo row (ARCH-Q).
  let lostTattooPhotoUrl: string | null = null;
  if (isLost && lostContext && canonicalIds.tattoo?.photoId) {
    const [tattooPhoto] = await db
      .select({ storagePath: attachments.storagePath })
      .from(attachments)
      .where(eq(attachments.id, canonicalIds.tattoo.photoId))
      .limit(1);
    lostTattooPhotoUrl = petPhotoUrl(tattooPhoto?.storagePath);
  }

  return {
    canonicalIds,
    hasVaccinations: vaccinationExists.length > 0,
    latestVaccinationRows,
    openCustodyEpisodeRows,
    rabiesEvents,
    serviceDog,
    lostContext,
    lostTattooPhotoUrl,
    // The rule proves the OBLIGATION exists; canonicalIds prove THIS animal is
    // identified. The unqualified "Identidad registrada" needs both (M4).
    registryClaim: deriveCredentialRegistryClaim(microchipRegistryRule, {
      hasMicrochip: canonicalIds.microchip !== null,
      hasTattoo: canonicalIds.tattoo !== null,
    }),
  };
}
