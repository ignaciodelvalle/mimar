// Tier-0 PII contract — /p/[publicToken] (task #33, TOP-5 gap #2).
//
// This is the single worst public-leak surface in the product: anyone who
// scans (or guesses) a public token reaches this page with NO auth. The
// existing structure test (public-token-landing-structure.test.tsx) proves
// chrome/a11y landmarks but never asserts on PII content — a refactor could
// start rendering owner phone/email/name and nothing in CI would catch it.
//
// This file drives the REAL page.tsx data path (mocked DB) and asserts:
//   1. ACTIVE credential (Tier 0): no owner PII query happens at all — the
//      page must never surface phone/email/full-name/address/DNI.
//   2. LOST credential, ALL disclose_*_when_lost flags OFF: the mocked DB
//      returns REAL, sensitive-looking owner data (simulating what would
//      happen if the SQL-level gate had a bug) — the page's prop-passing
//      gate (page.tsx ~759-784) is the last line of defense and must still
//      null everything out. This is the meaningful "flags OFF" case.
//
//      HOW FAR THAT CLAIM GOES, verified 2026-08-17 by instrumenting the
//      PublicLostSections spy rather than by reading the page. An audit had
//      called this case inert on the theory that page.tsx skips the owner
//      query when the flags are off, leaving `ownerRow` null and the gate
//      untouched. That is NOT what happens: the owner query at page.tsx ~1149
//      runs unconditionally inside `if (isLost)` — only individual COLUMNS are
//      projected as SQL null — so the sequenced mock's OWNER_ROW (index 7) does
//      reach `lostContext`. Proof: cases 2 and 3 share the same DB sequence and
//      case 3 observes FULL_NAME/PHONE/coords in the props, while case 2
//      observes null in every one. The difference between them is the prop
//      gate, and nothing else. Three of the four PII channels — first name,
//      phone, last-seen location — are genuinely exercised here.
//
//      THE ONE THAT IS NOT, stated so nobody re-derives false comfort from
//      this header: ownerEmail. Its value is produced by an admin-API call
//      that is ITSELF behind `pet.discloseEmailWhenLost` (page.tsx ~1270), so
//      with the flag off `lostContext.email` is already null before the prop
//      gate at ~767 ever looks at it. The prop gate nulls a null. What case 2
//      can honestly assert for email is that the FETCH gate held — that no
//      admin lookup was issued at all — and it now asserts exactly that,
//      instead of leaning on a `not.toContain(EMAIL)` that would pass whether
//      or not the gate exists.
//   3. LOST credential, ALL disclose_*_when_lost flags ON: only the
//      consented fields (first name, phone, location) reach the rendered
//      output — never the owner's DNI (never queried on this route at all)
//      and never a full legal name (only ever the first token).
//
// pet-state-header R3.4.12 closed the email gap: the page now passes
// `ownerEmail` to <PublicLostSections> (mailto CTA) when — and ONLY when —
// discloseEmailWhenLost is on. Case 3 asserts it reaches the props; case 2
// asserts it never does with the flag off.
//
// pet-state-header R3.3 adds a second contract on this surface: the public
// masthead may reflect ONLY the public-safe situation set (perdida,
// custodia-oficial, observacion-antirrabica, fallecida). Medical/household
// states (treatment, pregnancy, adoption, transit) must NEVER tint the public
// card — a Tier-0 medical-state leak. Case 4 guards it.

import { DISPUTE_TIP_INTRO } from "@/lib/ui/dispute-copy";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks shared by the page render (mirror public-token-landing-structure.test.tsx)
// ---------------------------------------------------------------------------

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === "x-real-ip" ? "198.51.100.9" : null),
  })),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  usePathname: vi.fn(() => "/p/TEST-TOKEN"),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

const { MockRateLimitError, mockEnforceRateLimit } = vi.hoisted(() => {
  class MockRateLimitError extends Error {
    resetAt: Date;
    reason: string;
    constructor(resetAt: Date, reason: string) {
      super(`Rate limit exceeded: ${reason}`);
      this.name = "RateLimitError";
      this.resetAt = resetAt;
      this.reason = reason;
    }
  }
  return {
    MockRateLimitError,
    mockEnforceRateLimit: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: (endpoint: string, id: string, cfg: unknown) =>
      mockEnforceRateLimit(endpoint, id, cfg),
    RateLimitError: MockRateLimitError,
  };
});

const mockDbSelect = vi.fn();
const mockDb = { select: mockDbSelect };

vi.mock("@/db", () => ({
  db: mockDb,
  pets: {},
  attachments: {},
  ownerships: {},
  petEvents: {},
  petServiceDog: {},
  cases: {},
  organizations: {},
  profiles: {},
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return actual as object;
});

// Business-rule resolver — the page resolves the registry-claim rule (ADR-7)
// and the streamed Tier-2 section resolves the observation window; neither may
// touch real infra here. matchedRow null → the neutral miMAR-scoped claim.
vi.mock("@/lib/infra/business-rules-resolver", () => ({
  resolveBusinessRule: vi.fn(async () => ({
    payload: { days: 30 },
    source: "default",
    matchedRow: null,
  })),
}));

vi.mock("@/lib/events/event-confidence", () => ({
  computeConfidence: vi.fn(() => "self_reported"),
  isAtLeast: vi.fn(() => false),
}));
vi.mock("@/lib/utils/format", () => ({
  AR_TIME_ZONE: "America/Argentina/Buenos_Aires",
  sexLabel: vi.fn(() => ""),
  speciesLabel: vi.fn(() => "perro"),
  statusLabel: vi.fn(() => "activo"),
  lostBannerHeadline: vi.fn(() => "Estoy perdida"),
  lostFirstPersonLine: vi.fn(() => "estoy perdida"),
  normalizePhoneForTel: vi.fn((p: string | null) => p),
  situationLabelForSex: vi.fn((label: string) => label),
  foundPossessivePhrase: vi.fn(() => "La tengo conmigo"),
  sightingPhrase: vi.fn(() => "La vi cerca de acá"),
  foundReportPrompt: vi.fn(() => "¿La encontraste? Reportala"),
}));
vi.mock("@/lib/reference/lookups", () => ({ tattooLocationLabel: vi.fn(() => null) }));
vi.mock("@/lib/ui/branding", () => ({
  BRANDING: { appName: "miMAR", appNameLong: "Mi Mascota Argentina Registrada" },
}));
vi.mock("@/lib/infra/origin-org", () => ({
  resolveOriginOrg: vi.fn(async () => null),
  shouldShowOriginOrgBadge: vi.fn(() => false),
}));
vi.mock("@/lib/reference/permanent-conditions", () => ({
  isPermanentCondition: vi.fn(() => false),
  permanentConditionShortLabel: vi.fn(() => ""),
  permanentConditionLabel: vi.fn(() => ""),
  resolveLostSpecialConditions: vi.fn(() => null),
}));
vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: vi.fn(async () => ({ microchip: null, tattoo: null })),
}));
vi.mock("@/lib/infra/storage", () => ({ petPhotoUrl: vi.fn(() => null) }));
vi.mock("@/components/PppPublicBadge", () => ({ PppPublicBadge: vi.fn(() => null) }));
vi.mock("@/components/event/ConfidenceBadge", () => ({ ConfidenceBadge: vi.fn(() => null) }));
vi.mock("@/app/(public)/p/[publicToken]/FoundPetForm", () => ({ FoundPetForm: vi.fn(() => null) }));
vi.mock("@/app/(public)/p/[publicToken]/DisputeTipForm", () => ({
  DisputeTipForm: vi.fn(() => null),
}));
vi.mock("@/app/(public)/p/[publicToken]/ScanLogger", () => ({ ScanLogger: vi.fn(() => null) }));
vi.mock("@/app/(public)/p/[publicToken]/Tier2MedicalView", () => ({
  Tier2MedicalView: vi.fn(() => null),
}));

// readPoint: real-ish behavior so lastSeenLat/Lng gating is exercisable —
// derives {lat,lng} from the row's locationLat/locationLng columns exactly
// like the real helper does, so this test can prove the coords are gated.
vi.mock("@/lib/domain/location", () => ({
  readPoint: vi.fn((row: { locationLat?: unknown; locationLng?: unknown } | null | undefined) => {
    if (!row || row.locationLat == null || row.locationLng == null) return null;
    return { lat: Number(row.locationLat), lng: Number(row.locationLng) };
  }),
}));

// createAdminClient — returns a real-looking email so we can prove it is (or
// per the discovered gap, currently never is) rendered.
const mockGetUserById = vi.fn(async () => ({
  data: { user: { email: "juan.perez@example.com" } },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ auth: { admin: { getUserById: mockGetUserById } } })),
}));

// PublicLostSections — SPY replacement. The component never decides what to
// show — the page passes only what's actually disclosable. This spy dumps
// every prop it receives into the DOM as JSON, so THIS test can assert on the
// page's prop-passing contract directly — the real security boundary —
// without depending on the child component's own rendering choices.
// formatLostSince lives in the same module (the page imports it for the
// masthead chip recency), so the factory must export it too.
vi.mock("@/components/pet-profile/PublicLostSections", () => ({
  PublicLostSections: vi.fn((props: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "lost-credential-spy" }, JSON.stringify(props)),
  ),
  formatLostSince: vi.fn(() => "hace 3 días"),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_NAME = "Juan Carlos Pérez";
const FIRST_NAME = "Juan";
const PHONE = "+5491122334455";
const EMAIL = "juan.perez@example.com";
const ADDRESS = "Av. Corrientes 1234, CABA";
/**
 * What the page is allowed to SAY about that address (PO decision 2026-09-16).
 *
 * Consent to publish the location is not consent to publish a door. A pet very
 * often goes missing from its own doorstep, so a street number on an open page
 * is the owner's home address on an open page — and by the time anybody reads
 * the line, the animal has moved, so the number buys a search nothing.
 * `publicPlaceReference` removes it at the publication boundary; the full
 * address and the coordinates stay in the event, route the case and reach the
 * operator working it.
 */
const ADDRESS_AS_PUBLISHED = "Av. Corrientes, CABA";
const HOUSE_NUMBER_IN_ADDRESS = "Corrientes 1234";
const LOCALITY = "Palermo";
const FAKE_DNI = "20-11222333-4";
const LAT = "-34.603722";
const LNG = "-58.381592";

const BASE_PET = {
  id: "pet-pii-1",
  name: "Firulais",
  species: "dog",
  breed: null,
  sex: "male",
  color: null,
  distinguishingFeatures: null,
  dateOfBirth: null,
  publicToken: "DIM-PIIT-EST0",
  primaryPhotoId: null,
  emergencyInfoVisible: false,
  discloseConditionsPublicly: false,
  permanentConditions: [] as string[],
  permanentConditionsOther: null,
  potentiallyDangerousBreed: false,
  tier2PublicPermanent: false,
  tier2PublicEnabledUntil: null,
  jurisdictionLocality: LOCALITY,
  jurisdictionProvince: "CABA",
  allowFinderFormWhenLost: false,
};

const ACTIVE_PET = {
  ...BASE_PET,
  status: "active",
  discloseFirstNameWhenLost: false,
  disclosePhoneWhenLost: false,
  discloseEmailWhenLost: false,
  discloseLastLocationWhenLost: false,
};

function lostPet(flags: {
  firstName: boolean;
  phone: boolean;
  email: boolean;
  location: boolean;
}) {
  return {
    ...BASE_PET,
    status: "lost",
    discloseFirstNameWhenLost: flags.firstName,
    disclosePhoneWhenLost: flags.phone,
    discloseEmailWhenLost: flags.email,
    discloseLastLocationWhenLost: flags.location,
  };
}

// Owner row with REAL, sensitive-looking data returned regardless of the
// disclose flags — this is the point: it simulates what would happen if the
// SQL-level gate (page.tsx `showPhone ? profiles.phone : sql\`null\``) had a
// bug, so the ONLY thing standing between this data and the rendered HTML is
// the prop-passing gate. `dni` is extraneous data the real query never
// selects — included here purely as a canary: if a future refactor starts
// reading `ownerRow.dni`, this test catches it.
const OWNER_ROW = {
  displayName: FULL_NAME,
  phone: PHONE,
  ownerUserId: "owner-fixture-uuid",
  dni: FAKE_DNI,
};

const LOST_EVENT_ROW = {
  lostDescriptionJson: null,
  locationText: ADDRESS,
  locationLat: LAT,
  locationLng: LNG,
  occurredAt: new Date("2026-06-01T12:00:00Z"),
};

// ---------------------------------------------------------------------------
// DB select-chain stub — SEQUENCED by call order (not call-count), so
// distinct queries can return distinct, purpose-built rows. Call order for
// the LOST path (page.tsx, Stage 1 Promise.all + isLost Promise.all):
//   0: main pet+photo fetch
//   1: vaccinationExists
//   2: latestVaccinationRows
//   3: openCustodyEpisodeRows
//   4: rabiesVaccinationRows (hoisted for the semaphore — pet-state-header R4)
//   5: amendment events (getAmendmentEvents, folded into the semaphore)
//   6: petServiceDog (pet.species === 'dog')
//   7: ownerRows (isLost block)
//   8: latestLostEventRows (isLost block)
// The ACTIVE path only ever reaches index 0-6 (isLost block is skipped).
// ---------------------------------------------------------------------------

function buildSequencedSelectChain(sequence: unknown[][]) {
  let callIndex = 0;
  return () => {
    const idx = callIndex++;
    const chain = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(async () => sequence[idx] ?? []),
      // Thenable: the amendments query (getAmendmentEvents, always-run
      // semaphore path) awaits the chain directly with no .limit().
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable — mocks drizzle's awaitable query chain
      then: (
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(sequence[idx] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };
}

describe("/p/[publicToken] — Tier-0 PII contract (task #33)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockGetUserById.mockResolvedValue({ data: { user: { email: EMAIL } } });
  });

  it("ACTIVE credential: renders with NONE of owner phone/email/DNI/full-name/address", async () => {
    mockDbSelect.mockImplementation(
      buildSequencedSelectChain([[{ pet: ACTIVE_PET, photo: null }], [], [], [], []]),
    );
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");

    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: ACTIVE_PET.publicToken }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    expect(html).toContain("Credencial pública"); // sanity: active render happened
    // ADDRESS_AS_PUBLISHED, not ADDRESS, and the difference is what keeps this
    // canary alive. Since the publication boundary coarsens every location
    // (`publicPlaceReference`, PO 2026-09-16), the FULL address can no longer
    // appear on any page for any reason — so asserting its absence would pass
    // whether or not consent was honoured, and a genuine leak would walk past
    // showing "Av. Corrientes, CABA". The string to watch is the one the page
    // would really emit if it leaked.
    for (const marker of [PHONE, EMAIL, FULL_NAME, ADDRESS, ADDRESS_AS_PUBLISHED, FAKE_DNI]) {
      expect(html).not.toContain(marker);
    }
    // No owner query is ever issued on the active path — ownerships/profiles
    // rows are only read inside the `if (isLost)` branch (page.tsx ~415).
  });

  it("LOST credential, ALL disclose_*_when_lost flags OFF: prop-passing gate nulls owner PII even though the DB returned real data", async () => {
    const pet = lostPet({ firstName: false, phone: false, email: false, location: false });
    mockDbSelect.mockImplementation(
      buildSequencedSelectChain([
        [{ pet, photo: null }],
        [],
        [],
        [],
        [],
        [],
        [],
        [OWNER_ROW],
        [LOST_EVENT_ROW],
      ]),
    );
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");

    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: pet.publicToken }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    expect(html).toContain('data-testid="lost-credential-spy"'); // sanity: lost branch rendered
    // ADDRESS_AS_PUBLISHED joins the list for the reason spelled out on the
    // active-pet canary above: the raw address is now unreachable by
    // construction, so only the coarsened form can testify to a leak.
    for (const marker of [
      PHONE,
      EMAIL,
      FULL_NAME,
      FIRST_NAME,
      ADDRESS,
      ADDRESS_AS_PUBLISHED,
      FAKE_DNI,
      LAT,
      LNG,
    ]) {
      expect(
        html,
        `PII marker "${marker}" leaked into the rendered lost credential despite all disclose flags being OFF`,
      ).not.toContain(marker);
    }

    // ---------------------------------------------------------------------
    // Non-vacuity: prove the gate RAN, not merely that the page is quiet.
    // ---------------------------------------------------------------------
    // Every assertion above is negative, and a negative assertion is satisfied
    // just as well by a page that never had the data as by a page that had it
    // and withheld it. Those are completely different security postures, and
    // only the second is what this case claims to test. So: assert the props
    // EXIST and are explicitly null. Delete the `discloseXWhenLost &&` from any
    // of the three gates at page.tsx ~759-784 and these go red, because the
    // sequenced mock puts real values on the other side of them.
    for (const prop of [
      "ownerFirstName",
      "ownerPhoneE164",
      "ownerEmail",
      "lastSeenPlaceName",
      "lastSeenCoords",
      "lastSeenLat",
      "lastSeenLng",
    ]) {
      expect(
        html,
        `${prop} is not being passed to PublicLostSections as an explicit null — the prop-passing gate may have been removed rather than closed`,
      ).toContain(`&quot;${prop}&quot;:null`);
    }

    // …and prove the owner row really was on the other side of that gate: the
    // page reached a lost render with a populated `lostSince`, which comes from
    // the SAME sequenced mock that supplies OWNER_ROW. If the sequence ever
    // drifts so `ownerRow` lands undefined, this case would silently become the
    // inert test an audit once believed it already was.
    expect(
      html,
      "the lost-event row did not reach the page — the DB sequence drifted, so the owner row probably did not either and this case is no longer testing the gate",
    ).toContain("&quot;lostSince&quot;:");

    // Email: the gate that actually holds here is the FETCH gate (page.tsx
    // ~1270), not the prop gate. Assert the admin lookup was never issued —
    // the owner's email must not even be read out of auth.users.
    expect(
      mockGetUserById,
      "the admin API was queried for the owner's email despite discloseEmailWhenLost being OFF",
    ).not.toHaveBeenCalled();
  });

  it("LOST credential, ALL disclose_*_when_lost flags ON: only the consented fields (first name, phone, location) reach the page — never DNI, never the full legal name", async () => {
    const pet = lostPet({ firstName: true, phone: true, email: true, location: true });
    mockDbSelect.mockImplementation(
      buildSequencedSelectChain([
        [{ pet, photo: null }],
        [],
        [],
        [],
        [],
        [],
        [],
        [OWNER_ROW],
        [LOST_EVENT_ROW],
      ]),
    );
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");

    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: pet.publicToken }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    // Consented fields DO reach the page.
    expect(html).toContain(PHONE);
    expect(html).toContain(FIRST_NAME);
    expect(html).toContain(LAT);
    expect(html).toContain(LNG);

    // THE LOCATION REACHES THE PAGE, THE DOOR DOES NOT. This assertion used to
    // be a single `toContain(ADDRESS)`, written when the whole address was
    // published; it is now two, and the pair is the point. The first keeps the
    // original guarantee — an owner who consented to sharing where the animal
    // was last seen still gets that shared, and a change that quietly stopped
    // publishing it would be breaking a promise in the other direction. The
    // second is new and is the actual privacy posture: the street survives as a
    // landmark, the number does not.
    //
    // Checked against the RAW form too, not only the rendered one: the page
    // embeds a JSON spy blob, so asserting on the visible text alone would miss
    // the address travelling in a payload one element away.
    expect(html).toContain(ADDRESS_AS_PUBLISHED);
    expect(html).not.toContain(HOUSE_NUMBER_IN_ADDRESS);

    // Never the full legal name — only the first token is ever derived.
    expect(html).not.toContain(FULL_NAME);
    // Never DNI — this route never selects it; canary against future leakage.
    expect(html).not.toContain(FAKE_DNI);
    // Email gap CLOSED (pet-state-header R3.4.12): the disclosed email now
    // reaches the lost sections (mailto CTA).
    expect(html).toContain(EMAIL);
  });

  it("LOST + open custody dispute (D2): disclosed contact PII AND every finder-relay path are suppressed — the neutral authority tip renders instead", async () => {
    // All disclose flags ON, but a custody dispute is open: no contested-owner
    // contact may render anywhere, AND (red-team hardening 2026-07) no
    // finder-report relay may be offered either — both /encontre and /sighting
    // end in an owner-directed notification / owner-visible finder contact,
    // which would take sides in a legal dispute. PO 2026-07-24: instead of a
    // dead end, the page renders the NEUTRAL dispute-tip path (sticky CTA +
    // inline form) whose submission goes to the reviewing authority only.
    const pet = {
      ...lostPet({ firstName: true, phone: true, email: true, location: true }),
      inCustodyDispute: true,
    };
    mockDbSelect.mockImplementation(
      buildSequencedSelectChain([
        [{ pet, photo: null }],
        [],
        [],
        [],
        [],
        [],
        [],
        [OWNER_ROW],
        [LOST_EVENT_ROW],
      ]),
    );
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");

    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: pet.publicToken }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    // NO relay path renders: no finder/sighting routes, no "Avisar al dueño"
    // found form. The sticky bar DOES render (PO 2026-07-24) but carries only
    // the neutral dispute-tip verb — never a relay.
    expect(html).toContain('data-section="sticky-action-bar"');
    expect(html).toContain("Tengo información sobre esta mascota");
    expect(html).not.toContain("/sighting");
    expect(html).not.toContain("/encontre");
    expect(html).not.toContain("Avisar al dueño");

    // The neutral authority tip renders in the found-form slot, and the
    // lost-sections spy proves the page threads the dispute state + nulled
    // relay hrefs into PublicLostSections (which renders its own notice —
    // covered by its colocated test).
    // PO decision 2026-07-30: this used to assert "La titularidad de esta
    // mascota está en revisión por la autoridad." — copy that handed a passing
    // stranger the fact that two people are fighting over the animal. The
    // finder is not a party. The sentence now states where their message goes
    // (they must never be left believing the owner was notified) and says
    // nothing about why. Imported from the single source so a copy edit breaks
    // this assertion instead of silently diverging from the other surfaces.
    expect(html).toContain(DISPUTE_TIP_INTRO);
    expect(html).not.toContain("titularidad");
    expect(html).toContain('data-section="found-form-disputed"');
    expect(html).toContain("&quot;custodyDisputed&quot;:true");
    expect(html).toContain("&quot;finderFormHref&quot;:null");
    expect(html).toContain("&quot;sightingFormHref&quot;:null");

    // No direct-contact channel anywhere: no tel: href (bar or card), no
    // phone/email/name marker in the whole render.
    expect(html).not.toContain("tel:");
    for (const marker of [PHONE, EMAIL, FULL_NAME, FIRST_NAME]) {
      expect(
        html,
        `contested-owner contact marker "${marker}" leaked despite the open custody dispute (D2)`,
      ).not.toContain(marker);
    }
  });

  it("LOST credential stamps the public masthead with data-situation=perdida", async () => {
    const pet = lostPet({ firstName: false, phone: false, email: false, location: false });
    mockDbSelect.mockImplementation(
      buildSequencedSelectChain([
        [{ pet, photo: null }],
        [],
        [],
        [],
        [],
        [],
        [],
        [OWNER_ROW],
        [LOST_EVENT_ROW],
      ]),
    );
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");

    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: pet.publicToken }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    expect(html).toContain('data-situation="perdida"');
  });

  it("DECEASED credential: masthead reflects fallecida and NO finder CTAs render", async () => {
    // A deceased pet's public credential is a memorial, not a search surface:
    // the masthead must stamp data-situation="fallecida" (public-safe situation
    // set) and neither finder flow — "la encontré" nor "la vi" — may render a
    // link. Both CTA hrefs only ever exist inside the lost branch; this pins
    // that a status regression can't resurrect them on a deceased render.
    const pet = { ...ACTIVE_PET, status: "deceased" };
    mockDbSelect.mockImplementation(
      buildSequencedSelectChain([[{ pet, photo: null }], [], [], [], []]),
    );
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");

    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: BASE_PET.publicToken }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    expect(html).toContain("Credencial pública"); // sanity: card rendered
    expect(html).toContain('data-situation="fallecida"');
    // No finder CTAs: the lost branch (and only the lost branch) carries them.
    expect(html).not.toContain("/encontre");
    expect(html).not.toContain("/sighting");
    expect(html).not.toContain('data-testid="lost-credential-spy"');
  });

  it("NEVER tints the public masthead for medical/household states (R3.3 — Tier-0 leak guard)", async () => {
    // A pet in treatment AND pregnant, but active and not under observation or
    // custody: the owner credential would show a situation band — the PUBLIC
    // masthead must stay in its default state. Tinting it would disclose a
    // medical/household state to any stranger scanning the QR (Tier 0 is
    // identity-only).
    const pet = {
      ...ACTIVE_PET,
      pregnancyStatus: "in_progress",
      rabiesObservationStatus: null,
    };
    mockDbSelect.mockImplementation(
      buildSequencedSelectChain([[{ pet, photo: null }], [], [], [], []]),
    );
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");

    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: pet.publicToken }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    expect(html).toContain("Credencial pública"); // sanity: card rendered
    expect(html).not.toContain("data-situation");
    expect(html).not.toContain('data-section="masthead-situation-chip"');
  });
});

// Custody-state dedup (PO-approved fix, mirrors the owner-profile single-
// authority standard in components/pet-profile/pet-state-single-authority.test.tsx,
// PO decision 2026-07-16). Before the fix, the public credential announced
// "under official custody" TWICE: once via the masthead situation chip, once
// via a redundant body sentence in the DC13 custody-disclaimer box. The
// standard: the masthead chip is the single authority for the STATE; the
// disclaimer box may only add what the chip can't (who's in charge, what a
// finder should do next).
function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("/p/[publicToken] — custody state announced exactly once (DC13 dedup)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockGetUserById.mockResolvedValue({ data: { user: { email: EMAIL } } });
  });

  it("ACTIVE pet under official custody: 'Bajo custodia oficial' renders once (the chip), the redundant sentence is gone, unique authority info remains", async () => {
    mockDbSelect.mockImplementation(
      buildSequencedSelectChain([
        [{ pet: ACTIVE_PET, photo: null }],
        [],
        [],
        [{ caseId: "case-custody-1", authorityName: "Municipalidad de Test" }],
        [],
      ]),
    );
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");

    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: ACTIVE_PET.publicToken }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    // The state is announced exactly once, by the masthead chip.
    expect(countOccurrences(html, "Bajo custodia oficial")).toBe(1);
    expect(html).toContain('data-section="masthead-situation-chip"');
    expect(html).toContain('data-situation="custodia-oficial"');

    // The redundant restatement sentence is gone — it carried no info the
    // chip didn't already give.
    expect(html).not.toContain("Esta mascota está bajo custodia oficial.");

    // The disclaimer box still renders — but only for its unique content:
    // who's in charge and what a finder should do.
    expect(html).toContain('data-section="custody-disclaimer"');
    expect(html).toContain("Autoridad a cargo: Municipalidad de Test");
    expect(html).toContain("Comunicate con la autoridad sanitaria competente");
  });

  it("ACTIVE pet NOT under official custody: neither the chip nor the disclaimer box render", async () => {
    mockDbSelect.mockImplementation(
      buildSequencedSelectChain([[{ pet: ACTIVE_PET, photo: null }], [], [], [], []]),
    );
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");

    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: ACTIVE_PET.publicToken }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    expect(html).not.toContain("Bajo custodia oficial");
    expect(html).not.toContain('data-section="custody-disclaimer"');
  });
});
