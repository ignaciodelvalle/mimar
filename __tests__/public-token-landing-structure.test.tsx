// Structure test — /p/[publicToken] AppShell variant=landing migration
// (Item 7, Phase C2). Proves the chrome invariant after dropping the page-owned
// `<main id="main-content">` on every render path: the LANDING SHELL now owns
// the single `#main-content`, and NO render path (active credential / throttle /
// lost) emits its own `<main>` or a second `#main-content`. The skip-link target
// must be unambiguous (WCAG 2.4.1 / 1.3.1).
//
// This guards directly against the duplicate-<main> regression the Phase C
// (public) layout passthrough + this C2 landing wrap exist to prevent.
//
// Rendering strategy mirrors the repo's other component structure tests
// (pet-sighting-form / finder-in-possession-form): react-dom/server →
// static HTML string, no jsdom. The page is a heavy async server component, so
// its DB + auth surface is mocked exactly like public-token-page-rate-limit.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Small helpers — count landmark occurrences in a rendered HTML string.
// ---------------------------------------------------------------------------

function countMainTags(html: string): number {
  return (html.match(/<main(\s|>)/g) ?? []).length;
}
function countMainContentIds(html: string): number {
  return (html.match(/id="main-content"/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// Mocks shared by the page render (mirror public-token-page-rate-limit.test.ts)
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
  // ScrollReset (mounted by every AppShell variant) reads the pathname.
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

// next/dynamic — LostPublicCredential lazy-loads the map. Return a no-op so the
// component renders synchronously to static markup.
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

// Heavy lib + child component deps (not under test) — neutralised so the page
// renders to markup without touching real infra. Children that would otherwise
// inject their own DOM are stubbed to null; we only assert on the page-owned
// chrome (the credential wrapper), never on child internals.
vi.mock("@/lib/events/event-confidence", () => ({
  computeConfidence: vi.fn(() => "self_reported"),
  isAtLeast: vi.fn(() => false),
}));
vi.mock("@/lib/utils/format", () => ({
  sexLabel: vi.fn(() => ""),
  speciesLabel: vi.fn(() => "perro"),
  statusLabel: vi.fn(() => "activo"),
  // Used by the lost render path (masthead chip + PublicLostSections).
  lostBannerHeadline: vi.fn(() => "Estoy perdida"),
  lostFirstPersonLine: vi.fn(() => "estoy perdida"),
  normalizePhoneForTel: vi.fn((p: string | null) => p),
  situationLabelForSex: vi.fn((label: string) => label),
  foundPossessivePhrase: vi.fn(() => "La tengo conmigo"),
  sightingPhrase: vi.fn(() => "La vi cerca de acá"),
  foundReportPrompt: vi.fn(() => "¿La encontraste? Reportala"),
}));
// LostPublicCredential deps (lost render path).
vi.mock("@/lib/reference/lookups", () => ({ tattooLocationLabel: vi.fn(() => null) }));
vi.mock("@/lib/ui/branding", () => ({
  BRANDING: { appName: "miMAR", appNameLong: "Mi Mascota Argentina Registrada" },
}));
vi.mock("@/lib/domain/location", () => ({ readPoint: vi.fn(() => null) }));
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
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/components/PppPublicBadge", () => ({ PppPublicBadge: vi.fn(() => null) }));
vi.mock("@/components/event/ConfidenceBadge", () => ({ ConfidenceBadge: vi.fn(() => null) }));
vi.mock("@/app/(public)/p/[publicToken]/FoundPetForm", () => ({ FoundPetForm: vi.fn(() => null) }));
vi.mock("@/app/(public)/p/[publicToken]/ScanLogger", () => ({ ScanLogger: vi.fn(() => null) }));
vi.mock("@/app/(public)/p/[publicToken]/Tier2MedicalView", () => ({
  Tier2MedicalView: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// DB select-chain stub. The first .limit() resolves the pet row; every later
// query resolves to []. Lets us drive the active-credential happy path with a
// single seeded pet object.
// ---------------------------------------------------------------------------

// Thenable (resolving []) besides .limit(): the amendments query
// (getAmendmentEvents, on the always-run semaphore path) awaits the chain
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

// Minimal ACTIVE pet row — enough for the active credential render path. All
// disclosure/Tier flags are off, so no gating branch fires and no PII is read.
const ACTIVE_PET = {
  id: "pet-1",
  name: "Firulais",
  status: "active",
  species: "dog",
  breed: null,
  sex: "male",
  color: null,
  distinguishingFeatures: null,
  dateOfBirth: null,
  publicToken: "DIM-AAAA-BBBB",
  primaryPhotoId: null,
  emergencyInfoVisible: false,
  discloseConditionsPublicly: false,
  permanentConditions: [] as string[],
  permanentConditionsOther: null,
  potentiallyDangerousBreed: false,
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

describe("/p/[publicToken] — landing-shell structure (Item 7, Phase C2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
  });

  it("AppShell variant=landing owns EXACTLY ONE #main-content", async () => {
    const { AppShell } = await import("@/components/layout/AppShell");
    const html = renderToStaticMarkup(
      <AppShell variant="landing">
        <div data-testid="child">credential body</div>
      </AppShell>,
    );
    expect(countMainContentIds(html)).toBe(1);
    expect(countMainTags(html)).toBe(1);
  });

  it("ACTIVE credential render path emits NO page-owned <main> / #main-content", async () => {
    mockDbSelect.mockImplementation(() => buildSelectChain([{ pet: ACTIVE_PET, photo: null }]));
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");

    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: "DIM-AAAA-BBBB" }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    // The page now renders a <div> wrapper; the shell provides the single
    // #main-content. So the page's own output must contain ZERO of either.
    expect(countMainTags(html)).toBe(0);
    expect(countMainContentIds(html)).toBe(0);
    // Sanity: the credential actually rendered (active content present).
    expect(html).toContain("Credencial pública");
    // The most-scanned public page in the product must expose a page-level
    // heading (WCAG 1.3.1 / 2.4.6) — exactly one <h1>, carrying the pet name.
    expect((html.match(/<h1(\s|>)/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<h1[^>]*>[\s\S]*Firulais/);
    // Rabies semaphore row (pet-state-header R4) — present on the active
    // render; no doses mocked → honest "Sin registro".
    expect(html).toContain("Antirrábica");
    expect(html).toContain("Sin registro");
  });

  it("THROTTLE (rate-limited) render path emits NO page-owned <main> / #main-content", async () => {
    mockDbSelect.mockImplementation(() => buildSelectChain([]));
    mockEnforceRateLimit.mockRejectedValue(
      new MockRateLimitError(new Date(Date.now() + 60_000), "public_token_page:ip:minute"),
    );
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");

    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: "DIM-AAAA-BBBB" }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    expect(countMainTags(html)).toBe(0);
    expect(countMainContentIds(html)).toBe(0);
    // Sanity: the throttle notice actually rendered, and no DB query ran.
    expect(html).toContain("Demasiadas consultas");
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("ACTIVE credential composed under the landing shell yields EXACTLY ONE #main-content", async () => {
    mockDbSelect.mockImplementation(() => buildSelectChain([{ pet: ACTIVE_PET, photo: null }]));
    const { AppShell } = await import("@/components/layout/AppShell");
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");

    const page = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: "DIM-AAAA-BBBB" }),
    });
    const html = renderToStaticMarkup(
      <AppShell variant="landing">{page as React.ReactElement}</AppShell>,
    );

    expect(countMainContentIds(html)).toBe(1);
    expect(countMainTags(html)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LOST render path — pet-state-header R3.1: the full-page lost takeover is
// RETIRED. A lost pet renders the SAME single-card structure as an active pet
// (one h1, no page-owned <main>), with the masthead in the lost treatment
// (`data-situation="perdida"` + state chip) instead of the old
// `lost-urgent-banner`.
// ---------------------------------------------------------------------------

const LOST_PET = {
  ...ACTIVE_PET,
  status: "lost",
};

describe("/p/[publicToken] — LOST path renders the single-card structure (pet-state-header)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
  });

  it("emits NO page-owned <main>, exactly ONE h1, and the situation masthead instead of the banner", async () => {
    mockDbSelect.mockImplementation(() => buildSelectChain([{ pet: LOST_PET, photo: null }]));
    const { default: PublicCredentialPage } = await import("@/app/(public)/p/[publicToken]/page");

    const element = await PublicCredentialPage({
      params: Promise.resolve({ publicToken: "DIM-AAAA-BBBB" }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);

    // Same chrome contract as the active path.
    expect(countMainTags(html)).toBe(0);
    expect(countMainContentIds(html)).toBe(0);
    expect((html.match(/<h1(\s|>)/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<h1[^>]*>[\s\S]*Firulais/);

    // The masthead is the state carrier now: card stamped with the situation
    // + a chip with the gendered label. The old full-page takeover banner is out.
    expect(html).toContain('data-situation="perdida"');
    expect(html).toContain('data-section="masthead-situation-chip"');
    expect(html).toContain("Perdida");
    // NOTE (2026-07-28): this pins the absence of the RETIRED full-page
    // takeover (LostPublicCredential), a component that no longer exists in the
    // tree at all — so the assertion cannot fail and proves nothing on its own.
    // It is kept as a tombstone: if anyone reintroduces that selector, this
    // catches it. What actually guards the CURRENT lost treatment is the pair
    // above (data-situation + masthead chip) plus the e2e specs asserting
    // data-section="lost-urgent-strip", which is a DIFFERENT element and does
    // render here.
    expect(html).not.toContain('data-section="lost-urgent-banner"');

    // The normal credential body still renders (identity grid + footer).
    expect(html).toContain("Identidad registrada");
    expect(html).toContain("Credencial pública");
    // Rabies semaphore row (pet-state-header R4) — present on the LOST render
    // too (finder-relevant: bite protocol).
    expect(html).toContain("Antirrábica");
    expect(html).toContain("Sin registro");
  });

  it("keeps the owner credential band and the public masthead keyed off the SAME data-situation attribute (parity guard)", async () => {
    // D2 drift guard: the public masthead deliberately MIRRORS DocumentChrome
    // (it is not the same component). Both stylesheet families must key off
    // `data-situation="perdida"` so a rename in one cannot silently detach the
    // other.
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toContain('.ln-face[data-situation="perdida"]');
    expect(css).toContain('.pc-cred[data-situation="perdida"]');
  });
});
