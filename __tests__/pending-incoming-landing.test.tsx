// Where the "Esperan tu respuesta" read lands, page by page.
//
//   /mis-mascotas — the banner on top, fed by the bounded read; the header
//                   link to /transferencias carries the count; a failed read
//                   (`null`) costs the banner and nothing else; and the banner
//                   survives the page's own degraded branch.
//   /inicio       — a bare landing with something pending goes to the index
//                   (where the banner is) instead of into a pet; nothing
//                   pending, or a failed read, lands on the pet exactly as
//                   before; a deep link with a query never takes the detour.
//
// The read itself is mocked here — its selection, budget and failure modes are
// pinned in app/(app)/_lib/pending-incoming.test.ts, and the banner's three
// render states in app/(app)/_components/PendingIncomingBanner.test.tsx.

import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPendingIncoming: vi.fn(),
  listOwnerPets: vi.fn(),
  livePets: vi.fn(),
  compliance: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  unstable_rethrow: vi.fn(),
}));
vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: async () => ({
    user: { id: "user-1" },
    supabase: {
      auth: {
        getUser: async () => ({
          data: { user: { email: "PO@Example.com", email_confirmed_at: "2026-10-01T00:00:00Z" } },
        }),
      },
    },
  }),
}));
vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: async () => ({ role: "owner" }),
}));
vi.mock("@/lib/infra/role-landing", () => ({ resolveVetLanding: async () => "/org/x" }));
vi.mock("@/lib/analytics/owner-dashboard", () => ({
  countPendingApplications: async () => 0,
  countPendingTransfers: async () => 4,
  countOutgoingPendingTransfers: async () => 0,
  fetchOpenWorkflows: async () => [],
  fetchPreviousWorkflows: async () => [],
  fetchActiveReminders: async () => [],
  fetchComplianceStatesForPets: () => mocks.compliance(),
  fetchLivePetsForCarouselRanking: () => mocks.livePets(),
}));
vi.mock("@/src/modules/pets/application/read/list-owner-pets", () => ({
  OWNER_PET_LIST_LIMIT: 200,
  listOwnerPets: () => mocks.listOwnerPets(),
}));
vi.mock("@/app/(app)/_lib/pending-incoming", () => ({
  loadPendingIncoming: mocks.loadPendingIncoming,
}));

import { PendingIncomingBanner } from "@/app/(app)/_components/PendingIncomingBanner";
import type { PendingIncoming } from "@/app/(app)/_lib/pending-incoming";
import { LnBadge } from "@/components/ui/Badge";

const PENDING: PendingIncoming = {
  items: [
    {
      kind: "caretaker",
      token: "CTG-PAMP-0001",
      href: "/cuidado/CTG-PAMP-0001",
      petName: "Pampita",
      petSpecies: "ferret",
      counterpartyName: "Graciela",
      startsAt: new Date("2026-10-07T15:00:00Z"),
      endsAt: new Date("2026-10-14T15:00:00Z"),
    },
  ],
};

const OWN_PET = {
  pet: {
    id: "pet-1",
    publicToken: "DIM-OWN0-0001",
    name: "Luna",
    status: "active",
    species: "dog",
    sex: "female",
    breed: null,
    pregnancyStatus: null,
  },
  photo: null,
  ownershipRole: "owner",
};

beforeEach(() => {
  mocks.loadPendingIncoming.mockReset();
  mocks.listOwnerPets.mockReset().mockResolvedValue({ rows: [OWN_PET], total: 1 });
  mocks.livePets
    .mockReset()
    .mockResolvedValue([
      { id: "pet-1", publicToken: "DIM-OWN0-0001", status: "active", pregnancyStatus: null },
    ]);
  mocks.compliance.mockReset().mockResolvedValue(new Map());
});

// ---- a minimal walk over a server component's returned element tree --------

type ElementLike = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

function isElementLike(node: unknown): node is ElementLike {
  return typeof node === "object" && node !== null && "type" in node;
}

function collect(node: unknown, match: (el: ElementLike) => boolean, out: ElementLike[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, match, out);
    return out;
  }
  if (!isElementLike(node)) return out;
  if (match(node)) out.push(node);
  collect(node.props?.children, match, out);
  return out;
}

async function renderIndex(): Promise<React.ReactNode> {
  const { default: MisMascotasPage } = await import("@/app/(app)/mis-mascotas/page");
  return MisMascotasPage({ searchParams: Promise.resolve({}) });
}

function bannerProps(tree: React.ReactNode) {
  return collect(tree, (el) => el.type === PendingIncomingBanner).map((el) => el.props);
}

/** The plain text under a node — strings and numbers, depth first. */
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isElementLike(node)) return textOf(node.props?.children);
  return "";
}

function headerLink(tree: React.ReactNode): ElementLike | undefined {
  return collect(
    tree,
    (el) =>
      el.props?.href === "/transferencias" &&
      textOf(el.props?.children).includes("Transferencias y cuidados"),
  )[0];
}

// ---- /mis-mascotas ----------------------------------------------------------

describe("/mis-mascotas — the pending banner on top", () => {
  it("hands the banner what is pending, and the header link counts it", async () => {
    mocks.loadPendingIncoming.mockResolvedValue(PENDING);
    const tree = await renderIndex();

    expect(bannerProps(tree)).toEqual([{ pending: PENDING }]);
    const badge = collect(headerLink(tree), (el) => el.type === LnBadge)[0];
    expect(textOf(badge)).toBe("1 sin responder");
  });

  it("reads with the session's CONFIRMED address, lowercased — the hub's own predicate", async () => {
    mocks.loadPendingIncoming.mockResolvedValue({ items: [] });
    await renderIndex();

    expect(mocks.loadPendingIncoming).toHaveBeenCalledWith({
      userId: "user-1",
      callerEmail: "po@example.com",
      callerEmailConfirmed: true,
    });
  });

  it("a failed read costs the banner and nothing else", async () => {
    mocks.loadPendingIncoming.mockResolvedValue(null);
    const tree = await renderIndex();

    // The banner gets `null` and renders nothing (its own test pins that) …
    expect(bannerProps(tree)).toEqual([{ pending: null }]);
    // … the pets are still there …
    expect(collect(tree, (el) => el.props?.href === "/mis-mascotas/DIM-OWN0-0001")).toHaveLength(1);
    // … and the header badge falls back to the page's own transfer count.
    const badge = collect(headerLink(tree), (el) => el.type === LnBadge)[0];
    expect(textOf(badge)).toBe("4 sin responder");
  });

  it("the banner survives the page's own degraded branch", async () => {
    mocks.loadPendingIncoming.mockResolvedValue(PENDING);
    mocks.listOwnerPets.mockRejectedValue(new Error("57P01"));
    const tree = await renderIndex();

    expect(bannerProps(tree)).toEqual([{ pending: PENDING }]);
  });
});

// ---- /inicio ----------------------------------------------------------------

async function landing(searchParams: Record<string, string> = {}): Promise<string> {
  const { default: InicioPage } = await import("@/app/(app)/inicio/page");
  try {
    await InicioPage({ searchParams: Promise.resolve(searchParams) });
  } catch (err) {
    return (err as Error).message.replace(/^REDIRECT:/, "");
  }
  throw new Error("/inicio rendered instead of redirecting");
}

describe("/inicio — something pending lands on the index", () => {
  it("a bare landing with a pending invitation goes to /mis-mascotas, not into a pet", async () => {
    mocks.loadPendingIncoming.mockResolvedValue(PENDING);

    expect(await landing()).toBe("/mis-mascotas");
  });

  it("matches by account id only — no second auth.getUser() on the front door", async () => {
    mocks.loadPendingIncoming.mockResolvedValue({ items: [] });
    await landing();

    expect(mocks.loadPendingIncoming.mock.calls[0]?.[0]).toEqual({
      userId: "user-1",
      callerEmail: "",
      callerEmailConfirmed: false,
    });
  });

  it("nothing pending lands on the pet, as before", async () => {
    mocks.loadPendingIncoming.mockResolvedValue({ items: [] });

    expect(await landing()).toBe("/mis-mascotas/DIM-OWN0-0001");
  });

  it("a failed read lands on the pet, as before", async () => {
    mocks.loadPendingIncoming.mockResolvedValue(null);

    expect(await landing()).toBe("/mis-mascotas/DIM-OWN0-0001");
  });

  it("a deep link with a query keeps its destination and never reads", async () => {
    mocks.loadPendingIncoming.mockResolvedValue(PENDING);

    expect(await landing({ sheet: "anotar" })).toBe("/mis-mascotas/DIM-OWN0-0001?sheet=anotar");
    expect(mocks.loadPendingIncoming).not.toHaveBeenCalled();
  });
});
