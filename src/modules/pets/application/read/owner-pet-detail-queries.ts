// The database reads behind the owner face.
//
// Split out of `load-owner-pet-detail.ts` so the reader reads as a sequence of
// named collaborators rather than a wall of Drizzle, and so a test can replace
// any one of them without a database. Each function here is a QUERY and nothing
// else: no derivation, no policy, no ordering decision. Those live in the reader.
//
// EVERY SELECT IS AN EXPLICIT PROJECTION. Not one `select()` without a column
// list — that is what keeps a Drizzle row type from escaping into the DTO and,
// through it, onto the wire. The page this was extracted from used full-row
// selects in three places; each is narrowed here to the fields actually read.

import {
  appointments,
  attachments,
  cases,
  db,
  organizations,
  petServiceDog,
  pets,
  profiles,
  serviceOfferings,
  timeSlots,
} from "@/db";
import {
  fetchComplianceStatesForPets,
  fetchLivePetsForCarouselRanking,
} from "@/lib/analytics/owner-dashboard";
import {
  type CarouselPet,
  OWNER_CAROUSEL_CAP,
  rankOwnerCarousel,
} from "@/lib/domain/owner-carousel";
import { GENERIC_CASE_LIST_EXCLUDED_KINDS } from "@/lib/infra/case-queries";
import { fetchLostEpisodeForPet, fetchLostScanEvents } from "@/lib/infra/lost-mode";
import { petAlertsOriginShelter } from "@/lib/infra/origin-shelter-alert";
import { eventAttachmentSignedUrl, petPhotoUrl } from "@/lib/infra/storage";
import { lnPetStatusFromCompliance } from "@/lib/projections/pet-compliance";
import { and, asc, desc, eq, gt, inArray, notInArray } from "drizzle-orm";

/** The most-recent cases a pet's owner face reads. Deliberately capped. */
const CASE_READ_CAP = 50;

// ---------------------------------------------------------------------------
// Photo
// ---------------------------------------------------------------------------

export type OwnerPetPhotoRead = { photoUrl: string | null };

export async function readPhoto(primaryPhotoId: string | null): Promise<OwnerPetPhotoRead> {
  if (!primaryPhotoId) return { photoUrl: null };
  const rows = await db
    .select({ storagePath: attachments.storagePath })
    .from(attachments)
    .where(eq(attachments.id, primaryPhotoId))
    .limit(1);
  return { photoUrl: petPhotoUrl(rows[0]?.storagePath) };
}

// ---------------------------------------------------------------------------
// Service dog
// ---------------------------------------------------------------------------

/**
 * The service-dog row, narrowed to the three fields the credential reads.
 *
 * `serviceType` and `credentialStatus` keep their COLUMN types — they are
 * closed string unions, and the label map that renders them is exhaustive over
 * exactly those members. Widening them to `string` here would silently turn
 * that map's missing-case error into an index error at the call site. These are
 * scalars, not a row type, and none of them reach the wire.
 */
export type OwnerPetServiceDogRead = {
  serviceType: (typeof petServiceDog.$inferSelect)["serviceType"];
  credentialStatus: (typeof petServiceDog.$inferSelect)["credentialStatus"];
  inService: boolean;
} | null;

export async function readServiceDog(petId: string): Promise<OwnerPetServiceDogRead> {
  const rows = await db
    .select({
      serviceType: petServiceDog.serviceType,
      credentialStatus: petServiceDog.credentialStatus,
      inService: petServiceDog.inService,
    })
    .from(petServiceDog)
    .where(eq(petServiceDog.petId, petId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    serviceType: row.serviceType,
    credentialStatus: row.credentialStatus,
    inService: Boolean(row.inService),
  };
}

// ---------------------------------------------------------------------------
// Ownership role — DELETED, on purpose
// ---------------------------------------------------------------------------
//
// `readOwnershipRole(petId, userId)` used to live here and answer "which active
// ownership role does this viewer hold". It is gone, and this note is here so
// nobody adds it back.
//
// It re-asked a question `resolvePetHolderAccess` had already answered — and
// answered BETTER. The guard ranks its Path-1 rows explicitly (`owner` <
// `co_owner` < `foster` < `caretaker`) because one user can hold two active
// rows on one animal. This helper had `.limit(1)` and no `ORDER BY`, so on that
// exact pet it resolved by whatever order the planner produced. The value gates
// `viewer.isTitular`, the caretaker and rehome reads and `canManageDisclosure`,
// so a titular who is also caretaker of their own co-owned animal watched their
// cockpit come and go between refreshes.
//
// The role now travels as `OwnerPetDetailInput.holderRole`, decided once by the
// guard, which also saves a round-trip on the hottest owner surface. If you need
// the role somewhere new, take it from the access result — do not re-query it.

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/**
 * One open case, in the three fields an owner surface prints.
 *
 * `caseKind` stays a RAW string — `case_kind` is unconstrained TEXT in the DB —
 * and is narrowed to the wire vocabulary in the payload builder, where every
 * other narrowing in this read already lives.
 *
 * `status` does NOT, and the asymmetry is deliberate. This type is "an OPEN
 * case", so its status is one of two words by definition, and saying that in
 * the type is what lets the payload builder project the list with a plain
 * `.map` — no second filter, no cast. A `string` here would force the projection
 * to re-decide what "open" means, which is how `openCount` and `items` start
 * describing different sets.
 */
export type OwnerPetOpenCaseRead = {
  publicCode: string;
  caseKind: string;
  status: "open" | "escalated";
};

export type OwnerPetCasesRead = {
  /**
   * How many cases are in `open` or `escalated`, among the capped window.
   *
   * Literally `openCases.length` — see the return below. It is not a separately
   * computed number that happens to agree; a reader that counted one way and
   * listed another is exactly the drift the contract's
   * `items.length === openCount` sentence would then be lying about.
   */
  openCount: number;
  /** Those same cases, most recently opened first. */
  openCases: OwnerPetOpenCaseRead[];
  /** True when the window hit its cap, so `openCount` is a floor. */
  truncated: boolean;
  /** An open `custody_episode` opened by a sanitary authority. */
  underOfficialCustody: boolean;
  /** The org that opened an open bite incident, when one named itself. */
  observationOpenedByOrgName: string | null;
};

/**
 * The pet's own cases, plus the two facts derived from them.
 *
 * Capped at the 50 most recent with a DETERMINISTIC order — an uncapped read on
 * a pet with a long history is unbounded, and a cap without an order would drop
 * an arbitrary subset. `truncated` is what keeps the count honest when the cap
 * bites.
 *
 * Excludes the kinds hidden from the subject (welfare_denuncia) and
 * `lost_pet_episode`, matching `findOpenCasesForPetWithCodes` — so the alert
 * this feeds can never fire on a case the owner is not meant to see, and lost
 * keeps its single rendering path.
 */
export async function readCases(petId: string): Promise<OwnerPetCasesRead> {
  const [rows, custodyRows] = await Promise.all([
    db
      .select({
        publicCode: cases.publicCode,
        status: cases.status,
        caseKind: cases.caseKind,
        openedReasonCode: cases.openedReasonCode,
        openedReasonParams: cases.openedReasonParams,
      })
      .from(cases)
      .where(
        and(
          eq(cases.primaryPetId, petId),
          notInArray(cases.caseKind, [...GENERIC_CASE_LIST_EXCLUDED_KINDS]),
        ),
      )
      .orderBy(desc(cases.openedAt))
      .limit(CASE_READ_CAP),
    // The SAME canonical discriminator /p uses: caseKind + opener orgType, never
    // parsed from notes. The query above lacks the opener-org join, so this
    // stays its own bounded read.
    db
      .select({ caseId: cases.id })
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
          eq(cases.primaryPetId, petId),
          eq(cases.caseKind, "custody_episode"),
          eq(cases.status, "open"),
        ),
      )
      .limit(1),
  ]);

  // A TYPE PREDICATE and not merely a boolean, so the narrowing below is the
  // compiler's and not a cast: inside the `flatMap` guard, `c.status` IS one of
  // the two open words, and `OwnerPetOpenCaseRead` can say so.
  const isOpen = (s: string): s is "open" | "escalated" => s === "open" || s === "escalated";
  const orgBiteCase = rows.find(
    (c) =>
      c.caseKind === "bite_incident" &&
      isOpen(c.status) &&
      c.openedReasonCode === "bite_reported_org",
  );
  const params = orgBiteCase?.openedReasonParams as { orgDisplayName?: unknown } | null | undefined;

  // ONE array, built once. Already ordered by `openedAt` desc from the query
  // above — the same order the web's own open-cases strip draws — and the
  // `notInArray` in that query is what keeps `welfare_denuncia` out of it. That
  // exclusion is now the SOLE mechanism between the subject of a denuncia and
  // the code of the case against them, and it is pinned by a database test
  // (`__tests__/case-queries-hidden-kinds.test.ts`) rather than by inspection:
  // drop the clause and the row arrives labelled `other`, because
  // `welfare_denuncia` is not in `OWNER_PET_CASE_KINDS` and the payload clamps
  // what it does not recognise. A leak wearing a generic label is one no
  // reviewer reading output would catch.
  const openCases: OwnerPetOpenCaseRead[] = rows.flatMap((c) =>
    isOpen(c.status) ? [{ publicCode: c.publicCode, caseKind: c.caseKind, status: c.status }] : [],
  );

  return {
    // The COUNT IS THE LIST'S LENGTH, not a second pass over `rows` that agrees
    // with it by coincidence. This is the invariant the contract states
    // (`items.length === openCount`) made true by construction.
    openCount: openCases.length,
    openCases,
    truncated: rows.length === CASE_READ_CAP,
    underOfficialCustody: custodyRows.length > 0,
    observationOpenedByOrgName:
      typeof params?.orgDisplayName === "string" ? params.orgDisplayName : null,
  };
}

// ---------------------------------------------------------------------------
// Lost mode
// ---------------------------------------------------------------------------

export type OwnerPetLostRead = {
  lostEpisode: Awaited<ReturnType<typeof fetchLostEpisodeForPet>> | null;
  lostScans: Awaited<ReturnType<typeof fetchLostScanEvents>>;
  alertsOriginShelter: boolean;
};

/**
 * The lost episode and its scan feed — read ONLY when the pet is actually lost.
 *
 * The origin-shelter alert flag is read unconditionally: it is a property of the
 * pet's provenance, not of its being lost, and the sheets consume it either way.
 */
export async function readLostData(petId: string, petStatus: string): Promise<OwnerPetLostRead> {
  const alertsOriginShelter = await petAlertsOriginShelter(petId);
  if (petStatus !== "lost") {
    return { lostEpisode: null, lostScans: [], alertsOriginShelter };
  }
  const lostEpisode = await fetchLostEpisodeForPet(petId);
  const rawScans = await fetchLostScanEvents(petId, undefined, lostEpisode?.id);
  // Sighting and finder reports may carry a photo, which lives in private
  // storage and needs a signed URL before any surface can show it.
  const lostScans = await Promise.all(
    rawScans.map(async (item) => {
      if (item.kind !== "sighting" && item.kind !== "finder") return item;
      if (!item.photoStoragePath) return item;
      return { ...item, photoUrl: await eventAttachmentSignedUrl(item.photoStoragePath) };
    }),
  );
  return { lostEpisode, lostScans, alertsOriginShelter };
}

// ---------------------------------------------------------------------------
// Reserved rabies appointment
// ---------------------------------------------------------------------------

export type OwnerPetReservedTurnoRead = { date: Date; provider: string | null } | null;

/**
 * The next CONFIRMED future rabies appointment, if one is booked.
 *
 * Feeds the compliance projection's `reserved` tone — an obligation with a turno
 * already booked is not the same as one nobody has acted on.
 */
export async function readReservedRabiesTurno(petId: string): Promise<OwnerPetReservedTurnoRead> {
  const rows = await db
    .select({
      slotStartsAt: timeSlots.startsAt,
      orgName: organizations.displayName,
      vetName: profiles.displayName,
    })
    .from(appointments)
    .innerJoin(timeSlots, eq(timeSlots.id, appointments.slotId))
    .innerJoin(serviceOfferings, eq(serviceOfferings.id, appointments.serviceOfferingId))
    .leftJoin(organizations, eq(organizations.id, serviceOfferings.organizationId))
    .leftJoin(profiles, eq(profiles.id, serviceOfferings.providerUserId))
    .where(
      and(
        eq(appointments.petId, petId),
        eq(appointments.status, "confirmed"),
        eq(serviceOfferings.serviceKind, "vaccination_rabies"),
        gt(timeSlots.startsAt, new Date()),
      ),
    )
    .orderBy(asc(timeSlots.startsAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { date: row.slotStartsAt, provider: row.orgName ?? row.vetName ?? null };
}

// ---------------------------------------------------------------------------
// Viewer contacts
// ---------------------------------------------------------------------------

export type OwnerPetViewerContactsRead = {
  preferredVetName: string | null;
  preferredVetPhone: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  displayName: string;
} | null;

/**
 * The viewer's ACCOUNT-level contacts.
 *
 * These are the default the pet-level override falls back to, and the display
 * name is where the titular's first name comes from for the disclosure copy.
 */
export async function readViewerContacts(userId: string): Promise<OwnerPetViewerContactsRead> {
  const rows = await db
    .select({
      preferredVetName: profiles.preferredVetName,
      preferredVetPhone: profiles.preferredVetPhone,
      emergencyContactName: profiles.emergencyContactName,
      emergencyContactPhone: profiles.emergencyContactPhone,
      displayName: profiles.displayName,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Carousel
// ---------------------------------------------------------------------------

export type OwnerPetCarouselItem = {
  token: string;
  name: string;
  photoUrl: string | null;
  /** The ranked status, from the one mapper every owner surface shares. */
  status: CarouselPet["status"];
};

export type OwnerPetCarouselRead = {
  items: OwnerPetCarouselItem[];
  /** Every LIVE pet the viewer holds, including those beyond the cap. */
  total: number;
  truncated: boolean;
};

/**
 * The owner's live pets, urgency-ranked and capped.
 *
 * Ranks over EVERY live ownership rather than a page of them: a most-urgent pet
 * beyond the cap would otherwise be absent from the swipe entirely. The
 * name/photo join then runs only over the <= 8 tokens that survive the cap, so
 * the wide read stays narrow and the narrow read stays bounded.
 *
 * `total` is the TRUE household count, which is what lets a surface say
 * "mostrando 8 de 14" instead of quietly disagreeing with /mis-mascotas.
 */
export async function readCarousel(userId: string): Promise<OwnerPetCarouselRead> {
  const livePets = await fetchLivePetsForCarouselRanking(userId);
  const total = livePets.length;
  if (total === 0) return { items: [], total: 0, truncated: false };

  const complianceStates = await fetchComplianceStatesForPets(
    userId,
    livePets.map((p) => p.id),
  );
  const ranked = rankOwnerCarousel(
    livePets.map((p) => {
      const compliance = complianceStates.get(p.id);
      return {
        token: p.publicToken,
        status: p.status,
        pregnancyStatus: p.pregnancyStatus,
        complianceStatus: compliance
          ? lnPetStatusFromCompliance(
              { status: p.status, pregnancyStatus: p.pregnancyStatus ?? null },
              compliance,
            )
          : null,
      };
    }),
  );
  if (ranked.length === 0) return { items: [], total, truncated: total > 0 };

  const photoRows = await db
    .select({ token: pets.publicToken, name: pets.name, storagePath: attachments.storagePath })
    .from(pets)
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    .where(
      inArray(
        pets.publicToken,
        ranked.map((p) => p.token),
      ),
    );
  const byToken = new Map(
    photoRows.map((r) => [r.token, { name: r.name, photoUrl: petPhotoUrl(r.storagePath) }]),
  );

  return {
    items: ranked.map((p) => ({
      token: p.token,
      status: p.status,
      name: byToken.get(p.token)?.name ?? "",
      photoUrl: byToken.get(p.token)?.photoUrl ?? null,
    })),
    total,
    truncated: total > ranked.length,
  };
}

export { OWNER_CAROUSEL_CAP };
