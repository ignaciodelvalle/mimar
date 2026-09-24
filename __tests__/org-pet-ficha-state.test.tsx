// Structure test — org pet ficha situation strip (pet-state-header R6).
//
// The org portal pet detail had NO state visibility beyond a plain-text
// "Estado" dd. It now derives the pet's situation (FULL set — org viewers are
// custodians, not the public) and renders an Op-styled tone strip at the top
// of the ficha plus a badge (icon + gendered label) in the Estado row. A
// default al-dia pet renders NO strip (quiet ficha, today's look).
//
// Rendering strategy mirrors public-token-landing-structure.test.tsx:
// react-dom/server → static HTML string, mocked DB/auth surface.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
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

// requireLiveUser (T1.2) resolves the acting profile from the DATABASE, so this
// suite now transitively loads lib/infra/request-cache — whose module-level SQL
// (notification-reconcile) cannot be built from this file's deliberately partial
// @/db mock. Stubbing the cache keeps the mock surface honest: the profile read
// is not what any assertion below is about.
vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: vi.fn(async (id: string) => ({
    id,
    role: "owner",
    displayName: "Fixture",
    accountType: "personal",
    deactivatedAt: null,
    deletedAt: null,
  })),
  getJurisdictionsCached: vi.fn(async () => []),
  getOrgMembershipCached: vi.fn(async () => null),
  getOrgMembershipsCached: vi.fn(async () => []),
  getUnreadCountCached: vi.fn(async () => 0),
  getOwnedPetsCountCached: vi.fn(async () => 0),
  getOrgQueueCountsCached: vi.fn(async () => ({})),
  orgQueueCacheKey: (keys: readonly string[]) => [...keys].sort().join(","),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireOrgAccessByToken: vi.fn(async () => ({
    organization: { id: "org-1", displayName: "Refugio Test" },
    membership: { role: "admin" },
  })),
}));

vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  getGrantedCapabilities: vi.fn(async () => new Set(["pet.read_held"])),
}));

vi.mock("@/src/modules/return-to-owner/application/proposal-queries", () => ({
  fetchPendingOwnerReturnProposalForOrg: vi.fn(async () => null),
}));

vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: vi.fn(async () => ({ microchip: null, tattoo: null })),
}));

vi.mock("@/lib/utils/format", () => ({
  speciesLabel: vi.fn(() => "perro"),
  situationLabelForSex: vi.fn((label: string) => label),
}));

// Client components mounted by the ficha — inert for this structure test.
vi.mock("@/app/org/[orgToken]/mascotas/[publicToken]/OrgPetSheetMounter", () => ({
  OrgPetSheetMounter: vi.fn(() => null),
}));
vi.mock("@/app/org/[orgToken]/mascotas/[publicToken]/OwnerReturnProposalCard", () => ({
  OwnerReturnProposalCard: vi.fn(() => null),
}));

const mockDbSelect = vi.fn();
// `execute` is the raw-SQL door `findOpenSponsorship` (rehome-by-titular,
// REQ-11) knocks on from the ficha. Resolving [] = "not sponsored", so the
// possession notice stays out of the way of what this suite is about (the
// situation strip); the notice itself is pinned by
// __tests__/rehome-possession-disclosure.test.tsx.
const mockDbExecute = vi.fn(async () => []);
vi.mock("@/db", () => ({
  db: { select: mockDbSelect, execute: mockDbExecute },
  pets: {},
  ownerships: {},
  petEvents: {},
  profiles: {},
  organizations: {},
  cases: {},
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return actual as object;
});

// First .limit resolves the pet row; every later query resolves [].
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
  };
  return chain;
}

const BASE_PET = {
  id: "pet-1",
  name: "Firulais",
  publicToken: "DIM-ORGF-TEST",
  species: "dog",
  breed: null,
  color: null,
  sex: "male",
  status: "active",
  rabiesObservationStatus: null,
  pregnancyStatus: null,
  adoptionEligible: null,
  adoptionIneligibleReason: null,
  adoptionIneligibleReasonNotes: null,
  adoptionIneligibleUntil: null,
  adoptionListedAt: null,
  adoptionListingPausedAt: null,
};

async function renderFicha(pet: Record<string, unknown>): Promise<string> {
  // ONE shared chain across every db.select() of a render: only the FIRST
  // .limit() (the pet+ownership fetch) yields the row; every later query
  // (foster, custody discriminator, proposals) resolves [].
  const chain = buildSelectChain([{ pet, ownershipRole: "shelter_custody" }]);
  mockDbSelect.mockImplementation(() => chain);
  const { default: OrgPetDetailPage } = await import(
    "@/app/org/[orgToken]/mascotas/[publicToken]/page"
  );
  const element = await OrgPetDetailPage({
    params: Promise.resolve({ orgToken: "ORG-TOKEN", publicToken: "DIM-ORGF-TEST" }),
  });
  return renderToStaticMarkup(element as React.ReactElement);
}

describe("org pet ficha — situation strip (pet-state-header R6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("LOST pet: renders the situation strip + badge with icon and gendered label", async () => {
    const html = await renderFicha({ ...BASE_PET, status: "lost" });

    expect(html).toContain('data-section="org-situation-strip"');
    expect(html).toContain('data-section="org-situation-badge"');
    // Gendered label (mock passes through the canonical feminine label).
    expect(html).toContain("Perdida");
    // Icon = the non-color signal — the strip renders an svg.
    expect(html).toMatch(/data-section="org-situation-strip"[^>]*>[\s\S]*?<svg/);
  });

  it("active al-dia pet: NO strip, quiet Estado text (today's look)", async () => {
    const html = await renderFicha(BASE_PET);

    expect(html).not.toContain('data-section="org-situation-strip"');
    expect(html).not.toContain('data-section="org-situation-badge"');
    expect(html).toContain("Activa");
  });

  it("pregnant pet: strip present (org sees the FULL set, unlike the public masthead)", async () => {
    const html = await renderFicha({ ...BASE_PET, pregnancyStatus: "in_progress" });

    expect(html).toContain('data-section="org-situation-strip"');
    expect(html).toContain("Preñada");
  });
});
