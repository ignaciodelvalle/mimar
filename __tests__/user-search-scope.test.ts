// Unit tests for searchUsers jurisdiction-scoping logic (P1-2).
//
// Security invariant: a govt viewer with zero jurisdiction assignments MUST
// receive an empty result without hitting the database.
//
// The full SQL-query path is an integration concern (requires a live DB).
// Here we test only the pure guard logic and the UserSearchScope discriminant
// by stubbing the DB import so the module can be loaded without a Postgres
// connection.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the DB module before importing the module under test so the Drizzle
// client is never initialised. `mockSelect` is hoisted so the tests can assert
// on WHETHER the query path was reached — the whole point of the guard tests
// is call-count observability, not just the (always-empty) result.
const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }));

vi.mock("@/db", () => ({
  db: {
    select: mockSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
          limit: vi.fn().mockResolvedValue([]),
        }),
        orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
  profiles: {
    id: "profiles.id",
    displayName: "profiles.displayName",
    role: "profiles.role",
    matriculaJurisdiccion: "profiles.matriculaJurisdiccion",
    // Wave 5 Item 25a: no plaintext DNI. search/omnibox-upgrade: a DNI-shaped
    // query additionally matches dniHash by equality (hashDni), unioned with
    // the display_name search — still under the SAME jurisdiction scope.
    dniHash: "profiles.dniHash",
    // Migration 0109 — excludes system/service accounts from admin rosters.
    isSystem: "profiles.isSystem",
  },
  ownerships: {
    ownerUserId: "ownerships.ownerUserId",
    petId: "ownerships.petId",
    endedAt: "ownerships.endedAt",
    role: "ownerships.role",
  },
  pets: {
    id: "pets.id",
    jurisdictionProvince: "pets.jurisdictionProvince",
    jurisdictionLocality: "pets.jurisdictionLocality",
  },
  organizations: {},
}));

import { searchUsers } from "@/lib/infra/admin-search";

describe("searchUsers — jurisdiction scope guard", () => {
  beforeEach(() => {
    mockSelect.mockClear();
  });

  it("has no default scope: omitting it is a compile error (A01-6)", () => {
    // The default used to be `{ role: "admin" }`: universal PII search for any
    // caller that forgot the argument. Never invoked; `pnpm typecheck` is the
    // assertion, and it fails the moment a default comes back (the directive
    // below would then be unused).
    const compileOnly = () =>
      // @ts-expect-error scope is required
      searchUsers("juan");
    expect(typeof compileOnly).toBe("function");
  });

  it("returns empty array immediately for a govt viewer with zero assignments — WITHOUT querying", async () => {
    const result = await searchUsers("juan", { role: "govt", jurisdictions: [] });
    expect(result).toEqual([]);
    // The guard's security property: the DB is never consulted.
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("returns empty array for empty query with zero govt assignments (landing page case) — WITHOUT querying", async () => {
    const result = await searchUsers("", { role: "govt", jurisdictions: [] });
    expect(result).toEqual([]);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("does not apply the zero-jurisdiction guard for admin scope — the query path IS reached", async () => {
    // Admin with no jurisdictions must still reach the DB query. The mock
    // returns [], so only the select call count proves no short-circuit.
    const result = await searchUsers("", { role: "admin" });
    expect(result).toEqual([]);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("proceeds to the DB query for a govt viewer with at least one jurisdiction", async () => {
    const result = await searchUsers("juan", {
      role: "govt",
      jurisdictions: [{ province: "Buenos Aires", locality: "La Plata" }],
    });
    expect(result).toEqual([]);
    // No early return: the search query actually executed.
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  // search/omnibox-upgrade — DNI search must NOT become a jurisdiction-scope
  // bypass. The DNI-hash predicate lives inside textPredicate, which is ANDed
  // with the same scope conditions as the name search, so these guards must
  // hold identically for a DNI-shaped query ("12345678") as for a name.
  it("a DNI-shaped query still short-circuits a govt viewer with zero assignments — WITHOUT querying", async () => {
    const result = await searchUsers("12345678", { role: "govt", jurisdictions: [] });
    expect(result).toEqual([]);
    // The DNI path does not punch a hole in the fail-closed guard.
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("a DNI-shaped query for a govt viewer with a jurisdiction reaches the scoped query", async () => {
    const result = await searchUsers("12345678", {
      role: "govt",
      jurisdictions: [{ province: "Buenos Aires", locality: "La Plata" }],
    });
    expect(result).toEqual([]);
    // Reaches the DB — under the same jurisdiction scope as the name search.
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });
});
