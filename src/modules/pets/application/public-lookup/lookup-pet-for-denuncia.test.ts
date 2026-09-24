// Privacy contract for the ANONYMOUS pet lookup (denuncia wizard).
//
// This use-case answers an unauthenticated caller who typed a token that is
// printed on the tag hanging from the animal's collar. Whatever it returns is
// therefore readable by anyone who can read the tag.
//
// It used to return `ownerInitials`. QA 2026-08-08 measured the consequence:
// step 4 of the public wizard answered "Esta mascota está registrada como
// CW-Luna (activa). Dueño: D.D." to an anonymous caller, while four other
// screens promise the owner that nothing of theirs is shown unless they turn
// it on — and this is the MISTREATMENT COMPLAINT flow, where the person asking
// is the one most likely to be in conflict with the owner.
//
// The test is written as an exact-key assertion rather than "expect no
// ownerInitials", because the failure mode to defend against is someone adding
// a DIFFERENT owner field later. A named absence only catches the name it was
// told about.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const dbState = { queue: [] as unknown[] };
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit", "leftJoin", "innerJoin"]) {
    builder[m] = () => builder;
  }
  // biome-ignore lint/suspicious/noThenProperty: intentional thenable query-builder stub for the @/db mock
  (builder as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject: (e: unknown) => unknown,
  ) => Promise.resolve(dbState.queue.length ? dbState.queue.shift() : []).then(resolve, reject);
  const tableProxy = new Proxy({}, { get: () => ({}) });
  const mockLookupByChip = vi.fn();
  return { dbState, builder, tableProxy, mockLookupByChip };
});

vi.mock("@/db", () => ({
  db: h.builder,
  pets: h.tableProxy,
  ownerships: h.tableProxy,
  profiles: h.tableProxy,
}));

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));

vi.mock("@/lib/infra/rate-limit", () => ({
  RateLimitError: class RateLimitError extends Error {},
  callerIp: () => "203.0.113.7",
  enforceRateLimit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/infra/chip-lookup", () => ({
  lookupByChip: (...args: unknown[]) => h.mockLookupByChip(...args),
}));

import { lookupPetForDenuncia } from "./lookup-pet-for-denuncia";

const ALLOWED_KEYS = ["found", "petName", "petStatus"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  h.dbState.queue = [];
});

describe("lookupPetForDenuncia — public projection", () => {
  it("returns ONLY found/petName/petStatus for a token hit", async () => {
    h.dbState.queue = [[{ petName: "CW-Luna", petStatus: "active" }]];

    const result = await lookupPetForDenuncia("DIM-ABCD-2345");

    expect(result.found).toBe(true);
    expect(Object.keys(result).sort()).toEqual([...ALLOWED_KEYS].sort());
  });

  it("returns ONLY found/petName/petStatus for a microchip hit", async () => {
    // The chip helper resolves the owner too; this projection must drop it.
    h.mockLookupByChip.mockResolvedValueOnce({
      pet: { name: "CW-Luna", status: "lost" },
      ownerFirstName: "Dueño Demo",
    });

    const result = await lookupPetForDenuncia("123456789012345");

    expect(result.found).toBe(true);
    expect(Object.keys(result).sort()).toEqual([...ALLOWED_KEYS].sort());
  });

  it("leaks nothing about the owner even when the row carries owner columns", async () => {
    // Belt and braces: if a future change re-adds a join, the extra column
    // must not ride out through the spread of a row object.
    h.dbState.queue = [
      [{ petName: "CW-Luna", petStatus: "active", ownerDisplayName: "Dueño Demo CABA" }],
    ];

    const result = await lookupPetForDenuncia("DIM-ABCD-2345");

    expect(JSON.stringify(result)).not.toMatch(/dueño|demo|D\.D\./i);
  });

  it("does not distinguish an unregistered token from a malformed one", async () => {
    // Both answer {found:false}: the caller learns nothing about existence.
    h.dbState.queue = [[]];
    expect(await lookupPetForDenuncia("DIM-ABCD-2345")).toEqual({ found: false });
    expect(await lookupPetForDenuncia("no-es-un-token")).toEqual({ found: false });
  });
});

describe("lookupPetForDenuncia — token normalisation is ASCII-only", () => {
  it("still resolves a lowercase ASCII token (behaviour unchanged for plain input)", async () => {
    h.dbState.queue = [[{ petName: "CW-Luna", petStatus: "active" }]];
    expect(await lookupPetForDenuncia("  dim-abcd-2345 ")).toMatchObject({ found: true });
  });

  it("does NOT fold a Unicode lookalike into a real token (dotless ı)", async () => {
    // A row is queued: if the lookalike reached the query it would answer
    // found. Unicode toUpperCase() maps `ı` to `I`, so the old code did.
    h.dbState.queue = [[{ petName: "CW-Luna", petStatus: "active" }]];
    expect(await lookupPetForDenuncia("dım-abcd-2345")).toEqual({ found: false });
  });
});
