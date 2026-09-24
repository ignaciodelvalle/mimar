// #16a — /p/[publicToken] streaming + next/image characterization.
//
// The public credential is the highest-traffic path in the product (every QR
// scan lands here, mostly mobile), so its LCP posture is load-bearing. This
// suite pins the two guarantees of the #16a refactor:
//
//   1. LCP: the pet photo is a next/image with `priority` — it emits an image
//      PRELOAD link (early discovery) and an optimizer srcSet (device-sized,
//      byte-smaller on mobile). It must NOT be a raw <img> or the initials
//      fallback when a photo exists.
//   2. Streaming: the heavy Tier-2 medical projection is deferred behind
//      <Suspense>. The shell (photo, name, identity) paints on the first flush
//      while the medical body streams in behind an aria-busy skeleton — proven
//      here by the skeleton and the identity section co-existing in the SAME
//      synchronous render.
//   3. Characterization: the extracted streamed components render the SAME
//      content as the former inline blocks — CredentialTier2Medical forwards the
//      shared vaccination derivation to <Tier2MedicalView> inside the exact card
//      seam; CredentialOriginOrg keeps the origin badge with a RAW <img> avatar
//      (deliberately NOT next/image — free-text host, 28px, below the fold).
//
// Render strategy mirrors the sibling page tests (react-dom/server static
// markup, mocked DB/auth). next/image is intentionally NOT mocked so the real
// priority/preload output is asserted.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared page-render mocks (mirror public-token-landing-structure.test.tsx).
// ---------------------------------------------------------------------------

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === "x-real-ip" ? "198.51.100.7" : null),
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
  }: { href: string; children: React.ReactNode; className?: string }) =>
    React.createElement("a", { href, className }, children),
}));

vi.mock("next/dynamic", () => ({ default: () => () => null }));

const { MockRateLimitError, mockEnforceRateLimit } = vi.hoisted(() => {
  class MockRateLimitError extends Error {
    constructor() {
      super("rate limit");
      this.name = "RateLimitError";
    }
  }
  return { MockRateLimitError, mockEnforceRateLimit: vi.fn().mockResolvedValue(undefined) };
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
vi.mock("@/db", () => ({
  db: { select: mockDbSelect },
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

vi.mock("@/lib/events/event-confidence", () => ({
  computeConfidence: vi.fn(() => "self_reported"),
  isAtLeast: vi.fn(() => false),
}));
vi.mock("@/lib/utils/format", () => ({
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
vi.mock("@/lib/domain/location", () => ({ readPoint: vi.fn(() => null) }));
vi.mock("@/lib/reference/permanent-conditions", () => ({
  isPermanentCondition: vi.fn(() => false),
  permanentConditionShortLabel: vi.fn(() => ""),
  permanentConditionLabel: vi.fn(() => ""),
  resolveLostSpecialConditions: vi.fn(() => null),
}));
// Hoisted handle so a test can give the pet a real identifier: the credential's
// registry claim needs BOTH a backing rule and an identified animal (M4).
const { mockFetchActiveIdentifications } = vi.hoisted(() => ({
  mockFetchActiveIdentifications: vi.fn(),
}));
vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: mockFetchActiveIdentifications,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/components/PppPublicBadge", () => ({ PppPublicBadge: vi.fn(() => null) }));
vi.mock("@/components/event/ConfidenceBadge", () => ({ ConfidenceBadge: vi.fn(() => null) }));
vi.mock("@/components/pet-profile/PublicLostSections", () => ({
  PublicLostSections: vi.fn(() => null),
  formatLostSince: vi.fn(() => "hace 3 días"),
}));
vi.mock("@/app/(public)/p/[publicToken]/FoundPetForm", () => ({ FoundPetForm: vi.fn(() => null) }));
vi.mock("@/app/(public)/p/[publicToken]/ScanLogger", () => ({ ScanLogger: vi.fn(() => null) }));

// Origin-org resolver — configured per-test.
const mockResolveOriginOrg = vi.fn(async (_petId: string) => null as unknown);
const mockShouldShowOriginOrgBadge = vi.fn((_org: unknown) => false);
vi.mock("@/lib/infra/origin-org", () => ({
  resolveOriginOrg: (petId: string) => mockResolveOriginOrg(petId),
  shouldShowOriginOrgBadge: (org: unknown) => mockShouldShowOriginOrgBadge(org),
}));

// Business-rule resolver — called synchronously in CredentialTier2Medical's
// query prefix (even when the render suspends) AND by the page's registry-claim
// resolution (ADR-7), so it must not touch real infra. Configurable per test:
// the default resolves nothing (matchedRow: null → neutral claim).
const { mockResolveBusinessRule } = vi.hoisted(() => ({
  mockResolveBusinessRule: vi.fn(),
}));
vi.mock("@/lib/infra/business-rules-resolver", () => ({
  resolveBusinessRule: mockResolveBusinessRule,
}));

// Tier2MedicalView — prop-dumping spy so the characterization test can assert
// the exact derivation CredentialTier2Medical forwards.
vi.mock("@/app/(public)/p/[publicToken]/Tier2MedicalView", () => ({
  Tier2MedicalView: vi.fn((props: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "tier2-view-spy" }, JSON.stringify(props)),
  ),
}));

// Shared vaccination derivation — mocked to fixed outputs so the characterization
// asserts on the FORWARDING, not the derivation internals (covered elsewhere).
vi.mock("@/lib/domain/libreta-health-status", () => ({
  computeVaccinationSummary: vi.fn(() => ({ active: 2, expired: 0, dueSoon: 1, missing: 0 })),
  hasAnyVaccineRecord: vi.fn(() => true),
}));
vi.mock("@/lib/infra/amendment", () => ({ overlayAmendments: vi.fn((e: unknown) => e) }));
vi.mock("@/lib/domain/credential-badges", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, deriveActiveMedications: vi.fn(() => ["Meloxicam"]) };
});

const PET_PHOTO_URL = "http://127.0.0.1:54321/storage/v1/object/public/pet-photos/pampa.jpg";
vi.mock("@/lib/infra/storage", () => ({ petPhotoUrl: vi.fn(() => PET_PHOTO_URL) }));

// ---------------------------------------------------------------------------
// Fixtures + DB chain
// ---------------------------------------------------------------------------

const BASE_PET = {
  id: "pet-strm-1",
  name: "Pampa",
  status: "active",
  species: "dog",
  breed: null,
  sex: "male",
  color: null,
  distinguishingFeatures: null,
  dateOfBirth: null,
  publicToken: "DIM-PAMP-0001",
  primaryPhotoId: "photo-1",
  emergencyInfoVisible: false,
  discloseConditionsPublicly: false,
  permanentConditions: [] as string[],
  permanentConditionsOther: null,
  potentiallyDangerousBreed: false,
  rabiesObservationStatus: null,
  tier2PublicPermanent: false,
  tier2PublicEnabledUntil: null,
  jurisdictionLocality: null,
  jurisdictionProvince: null,
  discloseFirstNameWhenLost: false,
  disclosePhoneWhenLost: false,
  discloseEmailWhenLost: false,
  discloseLastLocationWhenLost: false,
  allowFinderFormWhenLost: false,
};

// Chain whose first .limit resolves the pet row; every later query resolves []
// (shell path only needs cheap Stage-1 lookups, all of which use .limit).
// The chain is also THENABLE (resolving []) because the amendments query
// (getAmendmentEvents, now on the always-run semaphore path) awaits the chain
// directly after .where() with no .limit().
function buildSelectChain(firstResult: unknown[]) {
  let callCount = 0;
  const chain = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => {
      callCount++;
      return callCount === 1 ? firstResult : [];
    }),
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable — mocks drizzle's awaitable query chain
    then: (
      onFulfilled?: (value: unknown[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve([] as unknown[]).then(onFulfilled, onRejected),
  };
  return chain;
}

describe("/p/[publicToken] — #16a streaming + next/image", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockResolveOriginOrg.mockResolvedValue(null);
    mockShouldShowOriginOrgBadge.mockReturnValue(false);
    // Default: nothing resolves anywhere in the cascade (payload keeps the
    // rabies-observation window consumers happy; matchedRow null → the
    // registry claim stays neutral).
    mockResolveBusinessRule.mockResolvedValue({
      payload: { days: 30 },
      source: "default",
      matchedRow: null,
    });
    // Default fixture pet carries NO identifier (its credential body prints
    // "Microchip: No" / "Tatuaje: No") — tests that need one say so.
    mockFetchActiveIdentifications.mockResolvedValue({ microchip: null, tattoo: null });
  });

  // -------------------------------------------------------------------------
  // 1. LCP: the pet photo is a priority next/image (preload + optimizer srcSet)
  // -------------------------------------------------------------------------
  it("renders the pet photo as a priority next/image — preload link + optimizer srcSet, not a raw img", async () => {
    mockDbSelect.mockImplementation(() =>
      buildSelectChain([{ pet: BASE_PET, photo: { storagePath: "pampa.jpg" } }]),
    );
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");
    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: BASE_PET.publicToken }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    // next/image `priority` → image preload link for early LCP discovery.
    expect(html).toMatch(/<link[^>]+rel="preload"[^>]+as="image"/);
    // The preload + srcset route through the Next optimizer (device-sized WebP,
    // byte-smaller on mobile) and reference the pet-photos bucket.
    expect(html).toContain("/_next/image?url=");
    expect(html).toContain("pet-photos");
    // next/image marker present; NOT the initials fallback.
    expect(html).toContain("data-nimg");
    expect(html).not.toContain("repeating-linear-gradient(135deg"); // initials placeholder bg
  });

  // -------------------------------------------------------------------------
  // 2. Streaming: shell (identity) paints while Tier-2 medical streams behind
  //    an aria-busy skeleton.
  // -------------------------------------------------------------------------
  it("streams the Tier-2 medical body — shell identity + skeleton coexist in the first flush", async () => {
    mockDbSelect.mockImplementation(() =>
      buildSelectChain([
        { pet: { ...BASE_PET, tier2PublicPermanent: true }, photo: { storagePath: "pampa.jpg" } },
      ]),
    );
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");
    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: BASE_PET.publicToken }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    // Shell paints synchronously: name + identity section are present now.
    expect(html).toMatch(/<h1[^>]*>[\s\S]*Pampa/);
    expect(html).toContain("Identidad registrada");
    // The heavy medical body is deferred — its aria-busy skeleton shows instead
    // of the resolved <Tier2MedicalView> (spy) in this synchronous render.
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Cargando");
    expect(html).not.toContain('data-testid="tier2-view-spy"');
  });

  // -------------------------------------------------------------------------
  // 3. Characterization — CredentialTier2Medical forwards the shared derivation
  //    to <Tier2MedicalView> inside the exact card seam.
  // -------------------------------------------------------------------------
  it("CredentialTier2Medical forwards the derived summary to Tier2MedicalView within the card seam", async () => {
    // Drizzle's query builder is itself a thenable, so a faithful mock must be
    // too: the tier2 vaccine/med/amendment queries have no terminal .limit() and
    // are awaited directly, while the sterilization query ends in .limit(). Both
    // resolve to [] here — the derivation helpers are mocked, so query contents
    // are irrelevant; this only has to not throw on the spread.
    const emptyChain: Record<string, unknown> = {};
    for (const m of ["from", "where"]) emptyChain[m] = () => emptyChain;
    emptyChain.limit = async () => [];
    // biome-ignore lint/suspicious/noThenProperty: mocking drizzle's thenable query builder
    emptyChain.then = (resolve: (v: unknown[]) => void) => resolve([]);
    mockDbSelect.mockImplementation(() => emptyChain);

    const { CredentialTier2Medical } = await import(
      "@/app/(public)/p/[publicToken]/CredentialStreamedSections"
    );
    const node = await CredentialTier2Medical({
      petId: "pet-strm-1",
      sex: "female",
      species: "dog" as never,
      jurisdictionProvince: null,
      jurisdictionLocality: null,
      enabledUntil: null,
      permanentConditions: ["ciega"],
      permanentConditionsOther: null,
    });
    const html = renderToStaticMarkup(node);
    // renderToStaticMarkup HTML-escapes the spy's JSON quotes — decode to assert.
    const decoded = html.replace(/&quot;/g, '"');

    // Exact card seam preserved.
    expect(html).toContain("border-t border-ln-line-2");
    // Forwarded props (from the spy JSON dump) match the derivation the inline
    // block produced: the summary, the record flag, sterilization (empty → No),
    // active meds, and the pet-row conditions passed through untouched.
    expect(decoded).toContain('"vaccineSummary":{"active":2,"expired":0,"dueSoon":1,"missing":0}');
    expect(decoded).toContain('"hasVaccineRecords":true');
    expect(decoded).toContain('"isSterilized":false');
    expect(decoded).toContain('"activeMedications":["Meloxicam"]');
    expect(decoded).toContain('"permanentConditions":["ciega"]');
  });

  // -------------------------------------------------------------------------
  // 4. Characterization — CredentialOriginOrg keeps the badge + a RAW <img>
  //    avatar (deliberately not next/image), and renders nothing when gated off.
  // -------------------------------------------------------------------------
  it("CredentialOriginOrg renders the badge with a RAW img avatar when the gate is open", async () => {
    const AVATAR = "http://127.0.0.1:54321/storage/v1/object/public/org-logos/refugio.png";
    mockResolveOriginOrg.mockResolvedValue({
      id: "org-1",
      displayName: "Refugio Pampa",
      verified: true,
      tier0ShowOriginOrg: true,
      avatarUrl: AVATAR,
    });
    mockShouldShowOriginOrgBadge.mockReturnValue(true);

    const { CredentialOriginOrg } = await import(
      "@/app/(public)/p/[publicToken]/CredentialStreamedSections"
    );
    const html = renderToStaticMarkup(await CredentialOriginOrg({ petId: "pet-strm-1" }));

    expect(html).toContain('data-section="origin-org-badge"');
    expect(html).toContain("Refugio Pampa");
    // RAW img — exact src, and NONE of the next/image machinery.
    expect(html).toContain(`src="${AVATAR}"`);
    expect(html).not.toContain("data-nimg");
    expect(html).not.toContain("/_next/image");
  });

  it("CredentialOriginOrg renders nothing when the gate is closed", async () => {
    mockResolveOriginOrg.mockResolvedValue(null);
    mockShouldShowOriginOrgBadge.mockReturnValue(false);

    const { CredentialOriginOrg } = await import(
      "@/app/(public)/p/[publicToken]/CredentialStreamedSections"
    );
    const html = renderToStaticMarkup(await CredentialOriginOrg({ petId: "pet-strm-1" }));
    expect(html).toBe("");
  });

  // -------------------------------------------------------------------------
  // 5. Credential claim tiering (ADR-7, spec CT1/CT2): the identity heading's
  //    unqualified "registrada" claim renders only where a registry rule backs
  //    it; a province with no rule resolved gets the miMAR-scoped claim.
  // -------------------------------------------------------------------------
  async function renderCredentialHtml(): Promise<string> {
    mockDbSelect.mockImplementation(() =>
      buildSelectChain([{ pet: BASE_PET, photo: { storagePath: "pampa.jpg" } }]),
    );
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");
    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: BASE_PET.publicToken }),
    });
    return renderToStaticMarkup(element as React.ReactElement);
  }

  it("no registry rule resolved → the identity claim scopes itself to miMAR (CT1)", async () => {
    // Default resolver mock: matchedRow null (nothing resolves in the cascade).
    const html = await renderCredentialHtml();
    expect(html).toContain("Identidad registrada en miMAR");
  });

  /** Mandatory microchip rule resolved for the pet's province. */
  function mockMandatoryRegistryRule(): void {
    mockResolveBusinessRule.mockImplementation(async (ruleType: string) =>
      ruleType === "microchip_required"
        ? {
            payload: { required: true },
            requirementLevel: "mandatory",
            source: "province",
            matchedRow: { id: "rule-1", country: "AR", province: "CABA", locality: null },
          }
        : { payload: { days: 30 }, source: "default", matchedRow: null },
    );
  }

  it("mandatory + registry-backed + pet IDENTIFIED → preserves the full claim (CT2)", async () => {
    mockMandatoryRegistryRule();
    // The claim's second half (T6 review M4): a chip actually on record. The
    // fixture's default is an UNIDENTIFIED pet, which is the case below.
    mockFetchActiveIdentifications.mockResolvedValue({
      microchip: { code: "982000123456789" },
      tattoo: null,
    });
    const html = await renderCredentialHtml();
    expect(html).toContain("Identidad registrada");
    expect(html).not.toContain("Identidad registrada en miMAR");
  });

  // T6 review M4. This test used to assert the OPPOSITE — it rendered the
  // unqualified "Identidad registrada" over a credential whose own body says
  // "Microchip: No" and "Tatuaje: No". The rule proves the OBLIGATION exists in
  // CABA; it says nothing about whether THIS animal is in any registry.
  it("mandatory rule but the pet has NO identifier → the claim stays scoped to miMAR", async () => {
    mockMandatoryRegistryRule();
    mockFetchActiveIdentifications.mockResolvedValue({ microchip: null, tattoo: null });
    const html = await renderCredentialHtml();
    expect(html).toContain("Identidad registrada en miMAR");
    // The credential must not contradict the field printed a few lines below it.
    expect(html).toContain("Microchip</p>");
  });
});
