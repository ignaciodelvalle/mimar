// Privacy gate test — /p/[publicToken]/encontre ("La tengo conmigo") must not
// leak the owner's first name unless pet.discloseFirstNameWhenLost is true.
//
// This mirrors the sibling credential page's DB-mocked render-test pattern
// (see __tests__/public-token-landing-structure.test.tsx) and adds coverage
// the sibling pages themselves never had: asserting BOTH flag states, and
// proving the owner-name query is never even issued when the flag is off
// (defense-in-depth — no PII fetch, not just no PII render).

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

vi.mock("@/app/(public)/p/[publicToken]/encontre/FinderInPossessionForm", () => ({
  FinderInPossessionForm: vi.fn(() => null),
}));

vi.mock("@/lib/infra/storage", () => ({ petPhotoUrl: vi.fn(() => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));

const mockGetUser = vi.fn(async () => ({ data: { user: null } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

// ---------------------------------------------------------------------------
// DB select-chain stub. Unlike the sibling structure test's per-chain
// callCount, this indexes a SHARED, module-level sequence across every
// db.select(...) invocation the page makes — so we can assert not just what
// the second query returns, but WHETHER a second query happens at all.
// ---------------------------------------------------------------------------

let queuedResults: unknown[][] = [];
let callIndex = 0;

const mockDbSelect = vi.fn(() => {
  const chain = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => {
      const result = queuedResults[callIndex] ?? [];
      callIndex++;
      return result;
    }),
  };
  return chain;
});

vi.mock("@/db", () => ({
  db: { select: mockDbSelect },
  pets: {},
  attachments: {},
  ownerships: {},
  profiles: {},
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return actual as object;
});

// Lost + finder-form-enabled pet — reaches the happy path (owner-name header)
// without hitting the "not lost" or "owner disabled finder form" gates.
const LOST_PET_BASE = {
  id: "pet-1",
  name: "Firulais",
  status: "lost",
  publicToken: "DIM-AAAA-BBBB",
  primaryPhotoId: null,
  allowFinderFormWhenLost: true,
  disclosePhoneWhenLost: false,
  discloseEmailWhenLost: false,
  discloseLastLocationWhenLost: false,
  jurisdictionProvince: null,
  jurisdictionLocality: null,
};

async function renderEncontrePage() {
  const { default: FinderInPossessionPage } = await import(
    "@/app/(public)/p/[publicToken]/encontre/page"
  );
  const element = await FinderInPossessionPage({
    params: Promise.resolve({ publicToken: "DIM-AAAA-BBBB" }),
  });
  return renderToStaticMarkup(element as React.ReactElement);
}

describe("/p/[publicToken]/encontre — owner first-name disclosure gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: null } });
    queuedResults = [];
    callIndex = 0;
  });

  it("discloseFirstNameWhenLost=true shows the owner's first name", async () => {
    queuedResults = [
      [{ pet: { ...LOST_PET_BASE, discloseFirstNameWhenLost: true }, photo: null }],
      [{ displayName: "Lucía Fernández" }],
    ];

    const html = await renderEncontrePage();

    expect(html).toContain("Lucía está esperando reencontrarse con Firulais.");
    expect(html).not.toContain("Su familia está esperando");
  });

  it("discloseFirstNameWhenLost=false shows neutral copy and never fetches the name", async () => {
    queuedResults = [
      [{ pet: { ...LOST_PET_BASE, discloseFirstNameWhenLost: false }, photo: null }],
    ];

    const html = await renderEncontrePage();

    expect(html).toContain("Su familia está esperando reencontrarse con Firulais.");
    expect(html).not.toContain("Lucía");
    // Defense-in-depth: the owner-name join query must never be issued when
    // the flag is off, not merely suppressed at render time.
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });
});
