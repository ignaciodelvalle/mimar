// The projection from the owner-face domain read onto its wire shape.
//
// It lives beside the route, not inside the reader, for the reason the public
// credential's `payload.ts` gives: the reader answers "what is true about this
// animal", and this answers "what may a client hold, and in what form". Those
// are different questions with different reasons to change, and the page — which
// consumes the same reader and none of this — is the proof they are separable.
//
// WHAT THIS DELIBERATELY DROPS. `OwnerPetDetail` is wider than `OwnerPetDetailV1`
// on purpose: `typedEvents` (the pet's clinical spine), `lost.lostScans` (scan
// geolocation and finder photos) and `viewerContacts` (the viewer's own phone
// numbers) are all read for the page's own components and none of them cross
// here. A payload a device caches to disk carries what the owner face SHOWS, not
// everything the server touched to build it.
//
// THE MICROCHIP CODE IS AN EXCEPTION, AND THIS PARAGRAPH USED TO DENY IT.
// It said `canonicalIds` (the microchip code) does not cross. The FIELD does
// not; the VALUE does — `compliance.cards` carries it as the microchip card's
// `detail`, which is exactly what the web panel prints as that row's pill
// (lib/projections/pet-compliance.ts, and the contract's own
// `OwnerPetObligationCardV1.detail` says so). That is web parity and not a leak:
// the same holder reading the same face sees the same number in a browser.
//
// The correction matters anyway, because this paragraph is what a future reader
// trusts when deciding whether this payload is safe to cache to disk, to log, or
// to hand to a crash reporter. A privacy note that is 90% true is worse than
// none: it gets believed. What is TRUE is that the clinical spine, the scan
// geolocation, the finder photos and the viewer's own phone numbers do not cross
// — and the chip code does, inside `compliance.detail`.

import { apiV1Envelope } from "@/lib/infra/api-v1";
import type { OwnerPetDetail } from "@/src/modules/pets/application/read/load-owner-pet-detail";
import type {
  OwnerPetAlertsSection,
  OwnerPetBannersSection,
  OwnerPetCarouselSection,
  OwnerPetCaseKind,
  OwnerPetCasesSection,
  OwnerPetComplianceSection,
  OwnerPetDetailV1,
  OwnerPetDetailViewerRole,
  OwnerPetIdentitySection,
  OwnerPetObligationCardV1,
  OwnerPetPostAdoptionCheckinSection,
  OwnerPetPppRegistriesSection,
  OwnerPetPregnancySection,
  OwnerPetRemindersSection,
  OwnerPetStatusSection,
  PublicPetStatus,
} from "@dim/contract/api";
import type { CredentialSection } from "@dim/contract/api";
import {
  OWNER_PET_CASE_KINDS,
  OWNER_PET_DETAIL_PAYLOAD_VERSION,
  OWNER_PET_DETAIL_STALE_AFTER_MS,
  PUBLIC_PET_STATUSES,
} from "@dim/contract/api";

/**
 * `pets.status` narrowed to the three states a client knows.
 *
 * Anything else is reported as `active`, which is the same clamp the public
 * credential applies. A status this contract has no word for must not become an
 * undefined field a client branches on.
 */
function toPublicPetStatus(status: string): PublicPetStatus {
  return (PUBLIC_PET_STATUSES as readonly string[]).includes(status)
    ? (status as PublicPetStatus)
    : "active";
}

/**
 * A case kind, clamped to the words this contract has.
 *
 * Same shape and same reason as `toPublicPetStatus` above: `cases.case_kind` is
 * TEXT with no enum behind it, so a row can carry a string outside `CASE_KINDS`
 * (the panorama seed's `rabies_observation` is the live example). It reports
 * `other` instead of the raw key — a client that branches on an unknown string
 * branches wrong, and printing an internal identifier at a person is not a
 * fallback, it is a leak of vocabulary nobody outside the codebase shares.
 *
 * It is NOT where the hidden kinds are excluded. `welfare_denuncia` and
 * `lost_pet_episode` never reach here — the reader's query filters them with
 * `GENERIC_CASE_LIST_EXCLUDED_KINDS` — and a second, weaker copy of that rule
 * here would invite someone to delete the first one.
 */
function toOwnerPetCaseKind(caseKind: string): OwnerPetCaseKind {
  return (OWNER_PET_CASE_KINDS as readonly string[]).includes(caseKind)
    ? (caseKind as OwnerPetCaseKind)
    : "other";
}

/**
 * The viewer's role.
 *
 * The organization path has no ownership row of its own — the ORGANIZATION
 * holds the animal and the caller is a member of it — so it reports
 * `org_member` rather than borrowing the org's ownership role, which would tell
 * a client that a volunteer is the titular.
 *
 * EXPORTED (WU-J) because the libreta face answers the same question about the
 * same caller. Two mappings of `ownerships.role` onto the wire vocabulary is
 * how one endpoint starts calling a co-owner a caretaker while its sibling does
 * not, on the same request.
 */
export function toViewerRole(
  accessPath: "owner" | "org",
  ownershipRole: string | null,
): OwnerPetDetailViewerRole {
  if (accessPath === "org") return "org_member";
  switch (ownershipRole) {
    case "owner":
    case "co_owner":
    case "foster":
    case "caretaker":
      return ownershipRole;
    default:
      // An owner-path access with a role this contract has no word for. It
      // still HELD the pet (requirePetAccess proved that), so refuse the
      // titular affordances rather than the read: `caretaker` is the least
      // privileged holder word available, and isTitular below is false anyway.
      return "caretaker";
  }
}

function toObligationCard(
  card: OwnerPetDetail["compliance"]["cards"][number],
): OwnerPetObligationCardV1 {
  return {
    key: card.key,
    label: card.label,
    state: card.state,
    tone: card.tone,
    detail: card.detail,
    legalFootnote: card.legalFootnote,
    // The projection leaves these undefined when they do not apply. Over a
    // network an absent key and a null value are the same thing, so they are
    // normalised to null here rather than left for a client to guess at.
    currencyKnown: card.currencyKnown ?? null,
    currencyUntil: card.currencyUntil ?? null,
    dataUnknown: card.dataUnknown ?? false,
    requirementTier: card.requirementTier ?? null,
  };
}

/** How many reminders a single read hands a client. */
export const OWNER_PET_REMINDERS_CAP = 20;

export function buildOwnerPetDetailV1(input: {
  publicToken: string;
  petStatus: string;
  pregnancyStatus: string | null;
  accessPath: "owner" | "org";
  detail: OwnerPetDetail;
  /**
   * The registries the pet's OWN jurisdiction names for a PPP attestation,
   * already resolved.
   *
   * ARRIVES AS A WHOLE SECTION rather than as a payload this function derives,
   * because deriving it is a DATABASE READ — `ppp_attestation_required_registries`
   * is admin-editable and resolved per jurisdiction — and everything else here
   * is a pure mapping over a `detail` the caller already loaded. The route owns
   * the read, its budget, and the `unavailable` it degrades to; this function
   * owns the shape.
   *
   * `data: null` means the animal is not under the regime at all.
   */
  pppRegistries: CredentialSection<OwnerPetPppRegistriesSection>;
  /**
   * Whether this viewer owes a post-adoption check-in, already resolved — a
   * section of the route's own for the same reason `pppRegistries` is: it is a
   * database read with its own budget and its own `unavailable`.
   */
  postAdoptionCheckin: CredentialSection<OwnerPetPostAdoptionCheckinSection>;
  now: Date;
}): OwnerPetDetailV1 {
  const { detail, now } = input;

  const identity: OwnerPetIdentitySection = {
    name: detail.identity.name,
    species: detail.identity.species,
    // The contract types sex as the shared `PetSex` vocabulary; a row carrying
    // anything else reports null rather than widening the union.
    sex:
      detail.identity.sex === "male" || detail.identity.sex === "female"
        ? detail.identity.sex
        : null,
    breed: detail.identity.breed,
    breedLine: detail.identity.breedLine,
    photoUrl: detail.identity.photoUrl,
    jurisdictionProvince: detail.identity.jurisdictionProvince,
    jurisdictionLocality: detail.identity.jurisdictionLocality,
    tags: detail.identity.tags.map((t) => ({ key: t.key, label: t.label })),
  };

  const status: OwnerPetStatusSection = {
    petStatus: toPublicPetStatus(input.petStatus),
    ringStatus: detail.ringStatus,
    // The MASTHEAD situation, which is the one that also tints for a deceased
    // animal — the face body's `situation` is null there because the memorial
    // skin owns it and the two skins never stack. A client rendering a header
    // wants the band's version; nothing on the wire wants the other one.
    situation: detail.chromeSituation,
    memorial: detail.memorial,
    pregnancyStatus: input.pregnancyStatus,
  };

  const alerts: OwnerPetAlertsSection = { items: detail.alerts };

  const compliance: OwnerPetComplianceSection = {
    cards: detail.compliance.cards.map(toObligationCard),
    summary: detail.compliance.summary,
    worstTone: detail.compliance.worstTone,
    worstIsUnknown: detail.compliance.worstIsUnknown,
  };

  const shownReminders = detail.reminders.slice(0, OWNER_PET_REMINDERS_CAP);
  const reminders: OwnerPetRemindersSection = {
    items: shownReminders.map((r) => ({
      reminderId: r.reminderId,
      title: r.title,
      dueAt: r.dueAt.toISOString(),
      daysUntilDue: r.daysUntilDue,
      variant: r.variant,
      isReportable: r.isReportable,
    })),
    total: detail.reminders.length,
    // Derived, never assumed: a client must not have to know the cap to tell a
    // complete list from a capped one.
    truncated: shownReminders.length < detail.reminders.length,
  };

  const caretakerActive = detail.caretakerState?.active ?? null;
  const banners: OwnerPetBannersSection = {
    transit: detail.isTransit
      ? { canManageFosterActions: detail.ownershipRole === "foster" }
      : null,
    caretaker: detail.caretakerState
      ? detail.caretakerState.active
        ? {
            state: "active",
            caretakerName: caretakerActive?.caretakerName ?? null,
            publicContactName: detail.caretakerConsentName,
          }
        : detail.caretakerState.pending
          ? { state: "pending", caretakerName: null, publicContactName: null }
          : detail.caretakerState.recentlyEnded
            ? { state: "recently_ended", caretakerName: null, publicContactName: null }
            : null
      : null,
    // The reader types `kind` structurally (it may not import `rehome` — see
    // its header), so the narrowing to the two states this contract names
    // happens HERE rather than being assumed. Anything else reports no banner,
    // which is the safe direction: a banner is a claim about an arrangement.
    rehome:
      detail.rehomeState?.kind === "pending" || detail.rehomeState?.kind === "active"
        ? {
            kind: detail.rehomeState.kind,
            orgDisplayName: detail.rehomeState.orgDisplayName ?? null,
          }
        : null,
  };

  const cases: OwnerPetCasesSection = {
    openCount: detail.cases.openCount,
    truncated: detail.cases.truncated,
    // A `.map` AND NOT A `.flatMap`, because this projection does not get to
    // decide which cases are open. The reader decided that once, and
    // `openCount` above is the length of the very array being mapped here —
    // that is what makes the contract's `items.length === openCount` true by
    // construction rather than by two filters happening to agree. It WAS a
    // flatMap re-filtering on status until a fresh-context review pointed out
    // that a second copy of the predicate is how the two fields start
    // describing different sets, with nothing raising an error when they do.
    //
    // `caseKind` is still narrowed here: it is unconstrained TEXT in the DB and
    // staging carries legacy strings, so a kind outside the union becomes
    // `other` rather than travelling as itself. The web prints the raw key; a
    // raw internal string is not a thing to show a person, and dropping the row
    // would lose a case the owner is entitled to see.
    items: detail.cases.openCases.map((c) => ({
      casePublicCode: c.publicCode,
      kind: toOwnerPetCaseKind(c.caseKind),
      status: c.status,
    })),
  };

  const pregnancy: OwnerPetPregnancySection = detail.pregnancy
    ? {
        startedAt: detail.pregnancy.startedAt.toISOString(),
        weeksAtDiagnosis: detail.pregnancy.weeksAtDiagnosis,
        expectedBirthAt: detail.pregnancy.expectedBirthAt.toISOString(),
        lastClinicalAt: detail.pregnancy.lastClinicalAt?.toISOString() ?? null,
      }
    : null;

  // THE ANIMAL BEING READ IS NOT ONE OF ITS OWNER'S "OTHER" PETS, and it took a
  // client rendering an empty card to notice that this section was shipping it.
  //
  // The domain read is right for the WEB, which uses the same list as a SWIPE
  // SWITCHER and needs the current pet in it to know where it is standing
  // (`PetCredentialCarousel` takes a `currentToken`). This wire section is not a
  // switcher: the contract names it "the owner's OTHER live pets", so the
  // exclusion belongs here, once, rather than in every client — the mobile face
  // filtered for RENDERING and then branched and counted on the unfiltered
  // array, so a one-pet owner got a "Tus otras mascotas" card with nothing in it
  // and a nine-pet owner read "Mostrando 8 de 9" beside seven rows.
  const carouselItems = detail.carousel.items.filter((p) => p.token !== input.publicToken);
  // `total` counts every LIVE pet the viewer holds
  // (`fetchLivePetsForCarouselRanking`: an active ownership row, status not
  // `deceased`), so this animal is in that count under exactly that condition —
  // NOT "was it among the capped items", which is false whenever the cap pushed
  // it out and would leave the total one too high on precisely the households
  // big enough to notice.
  const selfCountedInCarousel = input.accessPath === "owner" && input.petStatus !== "deceased";
  const carouselTotal = Math.max(0, detail.carousel.total - (selfCountedInCarousel ? 1 : 0));
  const carousel: OwnerPetCarouselSection = {
    items: carouselItems.map((p) => ({
      publicToken: p.token,
      name: p.name,
      photoUrl: p.photoUrl,
      status: toPublicPetStatus(p.status),
    })),
    total: carouselTotal,
    // DERIVED HERE, not borrowed from the reader, for the same reason the count
    // is: the reader's flag answers "did the RANKING hit its cap", and this
    // section answers a different question — "is this list a prefix of that
    // total" — after an exclusion the reader never made.
    //
    // They come apart on one household exactly: nine live pets, a cap of eight,
    // and THIS animal ranking ninth. The reader returns eight others and says
    // truncated; the subtraction then makes the total eight as well, so the wire
    // list is COMPLETE and the borrowed flag still told a client to print
    // "mostrando 8 de 8, hay más". `items.length < total` cannot say that, and
    // it is the same rule `MyPetsV1.truncated` already states.
    truncated: carouselItems.length < carouselTotal,
  };

  return {
    ...apiV1Envelope({
      payloadVersion: OWNER_PET_DETAIL_PAYLOAD_VERSION,
      issuedAt: now,
      staleAfterMs: OWNER_PET_DETAIL_STALE_AFTER_MS,
    }),
    publicToken: input.publicToken,
    viewer: {
      role: toViewerRole(input.accessPath, detail.ownershipRole),
      // TITULAR means the legal owner and nothing else. A foster holds the
      // animal; a caretaker is trusted with it; neither gets to see who else the
      // owner trusts, and an org member never does.
      isTitular: input.accessPath === "owner" && detail.ownershipRole === "owner",
    },
    identity: { status: "ok", data: identity },
    status: { status: "ok", data: status },
    alerts: { status: "ok", data: alerts },
    compliance: { status: "ok", data: compliance },
    reminders: { status: "ok", data: reminders },
    banners: { status: "ok", data: banners },
    cases: { status: "ok", data: cases },
    pregnancy: { status: "ok", data: pregnancy },
    pppRegistries: input.pppRegistries,
    postAdoptionCheckin: input.postAdoptionCheckin,
    carousel: { status: "ok", data: carousel },
  };
}
