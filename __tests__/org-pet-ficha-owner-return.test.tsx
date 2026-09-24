// Structure test — the org pet ficha's NOT-HELD panel and the adopter's
// pending return proposal (QA batch 2, D5).
//
// `ownerProposeReturnToOrgUseCase` writes `custody_transfer_proposed` and
// notifies this org's members with `ctaUrl:
// /org/{orgToken}/mascotas/{petToken}` — this page. A post-adoption return can
// only be proposed AFTER the adoption finalized, which is exactly when the
// org's `ownerships` row ended, so every one of those notifications used to
// land on the "ya no está bajo tu custodia" panel and stop there: the panel's
// only offer was `ReverseAdoptionAction`, the UNILATERAL override of an
// adoption, in answer to a consented handshake the adopter had opened. QA
// fixture: Rocco #2 DIM-BJBB-SKZU, adopted from Refugio Test 2026-09-02,
// proposal pending, nothing on screen anywhere.
//
// Both writers behind the card were already reachable —
// `orgAcceptOwnerReturnAction` / `orgRejectOwnerReturnAction` authorize on
// `requireOrgAccessByToken` + `custody.transfer` and never consult an ownership
// row — so the defect was the render alone, and so is the fix.
//
// Rendering strategy mirrors org-pet-ficha-state.test.tsx: react-dom/server →
// static HTML string, mocked DB/auth surface.

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

const mockGrantedCapabilities = vi.fn<() => Promise<Set<string>>>();
vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  getGrantedCapabilities: () => mockGrantedCapabilities(),
}));

const mockFetchPendingProposal = vi.fn();
vi.mock("@/src/modules/return-to-owner/application/proposal-queries", () => ({
  fetchPendingOwnerReturnProposalForOrg: (petId: string, orgId: string, exec: unknown) =>
    mockFetchPendingProposal(petId, orgId, exec),
}));

const mockFindReversibleAdoption = vi.fn<() => Promise<{ ok: boolean }>>();
vi.mock("@/src/modules/adoption/infrastructure/adoption-repository", () => ({
  AdoptionRepository: {
    findReversibleAdoption: () => mockFindReversibleAdoption(),
  },
}));

vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: vi.fn(async () => ({ microchip: null, tattoo: null })),
}));

// The two client components the panel can mount. Rendered as marker elements
// that echo the props under test, so an assertion sees WHICH card rendered and
// WHAT it was handed — not merely that some element exists.
vi.mock("@/app/org/[orgToken]/mascotas/[publicToken]/OrgPetSheetMounter", () => ({
  OrgPetSheetMounter: vi.fn(() => null),
}));
vi.mock("@/app/org/[orgToken]/mascotas/[publicToken]/OwnerReturnProposalCard", () => ({
  OwnerReturnProposalCard: (props: {
    orgToken: string;
    petPublicToken: string;
    petName: string;
    ownerDisplayName: string | null;
    proposedAt: string;
    proposalNotes: string | null;
  }) =>
    React.createElement(
      "div",
      {
        "data-testid": "owner-return-card",
        "data-org-token": props.orgToken,
        "data-pet-token": props.petPublicToken,
        "data-pet-name": props.petName,
        "data-owner": props.ownerDisplayName ?? "",
        "data-proposed-at": props.proposedAt,
        "data-notes": props.proposalNotes ?? "",
      },
      "OWNER RETURN CARD",
    ),
}));
vi.mock("@/app/org/[orgToken]/mascotas/[publicToken]/ReverseAdoptionAction", () => ({
  ReverseAdoptionAction: () =>
    React.createElement("div", { "data-testid": "reverse-adoption" }, "REVERTIR ADOPCION"),
}));

// db.select() results are handed out in call order — the NOT-HELD path asks
// three questions and each answer changes what renders.
const selectResults: unknown[][] = [];
const mockDbSelect = vi.fn(() => {
  const chain = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => selectResults.shift() ?? []),
  };
  return chain;
});
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

const PET_TOKEN = "DIM-BJBB-SKZU";
const ORG_TOKEN = "ORG-TOKEN";

/**
 * Render the ficha for a pet this org NO LONGER holds.
 *
 * Query order on that path: (1) the pet+active-ownership join, empty by
 * definition here; (2) the "does the animal still exist" probe; (3) the
 * proposing owner's display name, reached only when a proposal is pending.
 */
async function renderNotHeld(): Promise<string> {
  selectResults.length = 0;
  selectResults.push([]); // 1. no active ownership row for this org
  selectResults.push([{ id: "pet-1", name: "Rocco" }]); // 2. the pet is still there
  selectResults.push([{ displayName: "Ana Adoptante" }]); // 3. the proposing owner
  const { default: OrgPetDetailPage } = await import(
    "@/app/org/[orgToken]/mascotas/[publicToken]/page"
  );
  const element = await OrgPetDetailPage({
    params: Promise.resolve({ orgToken: ORG_TOKEN, publicToken: PET_TOKEN }),
  });
  return renderToStaticMarkup(element as React.ReactElement);
}

const PENDING_PROPOSAL = {
  proposal: {
    id: "evt-1",
    occurredAt: new Date("2026-09-02T14:00:00Z"),
    payload: {
      from_user_id: "owner-1",
      to_organization_id: "org-1",
      proposed_at: "2026-09-02T14:00:00.000Z",
      notes: "Me mudo y no puedo tenerlo.",
    },
  },
  ownerUserId: "owner-1",
};

describe("org pet ficha — the adopter's return proposal on the NOT-HELD panel (D5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGrantedCapabilities.mockResolvedValue(new Set(["pet.read_held", "custody.transfer"]));
    mockFindReversibleAdoption.mockResolvedValue({ ok: false });
  });

  it("renders the accept/reject card when a proposal is pending", async () => {
    mockFetchPendingProposal.mockResolvedValue(PENDING_PROPOSAL);
    const html = await renderNotHeld();

    expect(html).toContain('data-testid="owner-return-card"');
    // The card is handed the tokens the two actions authorize on, and the
    // proposal facts the org member needs to decide.
    expect(html).toContain(`data-org-token="${ORG_TOKEN}"`);
    expect(html).toContain(`data-pet-token="${PET_TOKEN}"`);
    expect(html).toContain('data-pet-name="Rocco"');
    expect(html).toContain('data-owner="Ana Adoptante"');
    expect(html).toContain('data-proposed-at="2026-09-02T14:00:00.000Z"');
    expect(html).toContain("Me mudo y no puedo tenerlo.");
  });

  it("says what is being asked instead of calling it the expected end of the story", async () => {
    mockFetchPendingProposal.mockResolvedValue(PENDING_PROPOSAL);
    const html = await renderNotHeld();

    expect(html).toContain("propone devolvértela");
    // The terminal-state sentence would tell the member there is nothing to do
    // on a screen that is asking them to decide.
    expect(html).not.toContain("Es el resultado esperado");
  });

  it("keeps the plain terminal panel when nothing is pending", async () => {
    mockFetchPendingProposal.mockResolvedValue(null);
    const html = await renderNotHeld();

    expect(html).not.toContain('data-testid="owner-return-card"');
    expect(html).toContain("Es el resultado esperado");
    expect(html).toContain("Esta mascota ya no está bajo tu custodia");
  });

  it("offers the consented handshake ABOVE the unilateral adoption reversal", async () => {
    // Both can be available at once. Reverting an adoption overrides the
    // adopter; accepting the return is what the adopter asked for, so it must
    // not read as the fallback option.
    mockFetchPendingProposal.mockResolvedValue(PENDING_PROPOSAL);
    // `adoption.finalize` is what gates the reversal CTA on this panel.
    mockGrantedCapabilities.mockResolvedValue(
      new Set(["pet.read_held", "custody.transfer", "adoption.finalize"]),
    );
    mockFindReversibleAdoption.mockResolvedValue({ ok: true });
    const html = await renderNotHeld();

    const cardAt = html.indexOf('data-testid="owner-return-card"');
    const reverseAt = html.indexOf('data-testid="reverse-adoption"');
    expect(cardAt).toBeGreaterThan(-1);
    expect(reverseAt).toBeGreaterThan(-1);
    expect(cardAt).toBeLessThan(reverseAt);
  });

  it("does not offer accept/reject without the custody.transfer capability", async () => {
    // The two server actions refuse without it; drawing the buttons anyway
    // would be a control that only fails after the click.
    mockFetchPendingProposal.mockResolvedValue(PENDING_PROPOSAL);
    mockGrantedCapabilities.mockResolvedValue(new Set(["pet.read_held"]));
    const html = await renderNotHeld();

    expect(html).not.toContain('data-testid="owner-return-card"');
    expect(mockFetchPendingProposal).not.toHaveBeenCalled();
  });
});
