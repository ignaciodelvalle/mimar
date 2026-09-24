// Unit tests for loadOperatorPetSubView's jurisdiction-only gate
// (search/omnibox-upgrade — the destination page for the re-wired pet omnibox
// search).
//
// Security invariant: a govt viewer with zero jurisdiction assignments MUST
// receive null (→ notFound()) without hitting the database, and a govt viewer
// WITH assignments must never resolve a pet outside their (province, locality)
// scope. Mirrors the guard style in __tests__/user-search-scope.test.ts.
//
// The full tail (microchip / owner-of-record / open-cases projection) is an
// integration concern normally exercised against a live DB; here we stub @/db
// with a per-call result QUEUE so the module loads without a Postgres
// connection and each successive db.select() call in a test resolves to the
// next queued row set, in call order.

import { beforeEach, describe, expect, it, vi } from "vitest";

// `mockSelect` + `selectQueue` are hoisted so tests can (a) assert WHETHER the
// query path was reached at all (the zero-assignment guard's security
// property) and (b) script exactly what each successive db.select() call
// resolves to, in the order the code under test issues them.
const { mockSelect, selectQueue } = vi.hoisted(() => {
  const queue: unknown[][] = [];

  // A single chainable "query" object: every builder method (from/where/
  // orderBy/join) returns the SAME object so any call order chains cleanly,
  // and the object is itself a thenable resolving to `rows` — covering both
  // call shapes in the loader + case-queries.ts: `...limit(n)` (terminal
  // promise) and `...orderBy(x)` with NO trailing `.limit()` (the code awaits
  // the chain directly, as findOpenCasesForPetWithCodes does).
  function makeChain(rows: unknown[]) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.from = self;
    chain.where = self;
    chain.orderBy = self;
    chain.innerJoin = self;
    chain.leftJoin = self;
    chain.limit = () => Promise.resolve(rows);
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable — mocks drizzle's awaitable query chain
    chain.then = (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject);
    return chain;
  }

  const select = vi.fn().mockImplementation(() => makeChain(queue.shift() ?? []));
  return { mockSelect: select, selectQueue: queue };
});

vi.mock("@/db", () => ({
  db: { select: mockSelect },
  pets: {
    id: "pets.id",
    publicToken: "pets.publicToken",
    name: "pets.name",
    species: "pets.species",
    sex: "pets.sex",
    status: "pets.status",
    breed: "pets.breed",
    color: "pets.color",
    jurisdictionProvince: "pets.jurisdictionProvince",
    jurisdictionLocality: "pets.jurisdictionLocality",
    deletedAt: "pets.deletedAt",
  },
  petIdentifications: {
    petId: "petIdentifications.petId",
    kind: "petIdentifications.kind",
    status: "petIdentifications.status",
    code: "petIdentifications.code",
    recordedAt: "petIdentifications.recordedAt",
  },
  ownerships: {
    petId: "ownerships.petId",
    role: "ownerships.role",
    endedAt: "ownerships.endedAt",
    ownerUserId: "ownerships.ownerUserId",
    ownerOrganizationId: "ownerships.ownerOrganizationId",
    startedAt: "ownerships.startedAt",
  },
  profiles: { id: "profiles.id", displayName: "profiles.displayName" },
  organizations: { id: "organizations.id", displayName: "organizations.displayName" },
  cases: {
    id: "cases.id",
    publicCode: "cases.publicCode",
    caseKind: "cases.caseKind",
    status: "cases.status",
    primaryPetId: "cases.primaryPetId",
    jurisdictionProvince: "cases.jurisdictionProvince",
    jurisdictionLocality: "cases.jurisdictionLocality",
    openedAt: "cases.openedAt",
  },
  welfareReports: {
    id: "welfareReports.id",
    subjectPetId: "welfareReports.subjectPetId",
    jurisdictionProvince: "welfareReports.jurisdictionProvince",
    jurisdictionLocality: "welfareReports.jurisdictionLocality",
    status: "welfareReports.status",
  },
}));

import { loadOperatorPetSubView } from "@/lib/infra/gob-pet-subview";

const CABA_PET = {
  id: "pet-1",
  publicToken: "DIM-CABA-0001",
  name: "Luna",
  species: "dog",
  sex: "female",
  status: "active",
  breed: null,
  color: null,
  jurisdictionProvince: "CABA",
  jurisdictionLocality: "Buenos Aires",
};

describe("loadOperatorPetSubView — jurisdiction-only gate", () => {
  beforeEach(() => {
    mockSelect.mockClear();
    selectQueue.length = 0;
  });

  it("returns null for a govt viewer with zero jurisdiction assignments — WITHOUT querying", async () => {
    const result = await loadOperatorPetSubView("DIM-CABA-0001", {
      role: "govt",
      jurisdictions: [],
    });
    expect(result).toBeNull();
    // The guard's security property: the DB is never consulted.
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("returns null when the pet does not exist (admin scope still reaches the query)", async () => {
    selectQueue.push([]); // pets SELECT — no row
    const result = await loadOperatorPetSubView("DIM-NOPE-0000", { role: "admin" });
    expect(result).toBeNull();
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("returns null for a govt viewer whose assignments do NOT cover the pet's jurisdiction", async () => {
    selectQueue.push([CABA_PET]); // pets SELECT — CABA pet
    const result = await loadOperatorPetSubView("DIM-CABA-0001", {
      role: "govt",
      jurisdictions: [{ province: "Mendoza", locality: "Mendoza" }],
    });
    expect(result).toBeNull();
    // The pet row was fetched (1 query) but the tail (microchip/owner/open
    // cases) must NEVER run for an out-of-scope pet — no further query, no
    // extra existence signal beyond the single scoped SELECT.
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("a whole-CABA govt assignment subsumes a barrio-tagged pet (subsumption, not exact-pair)", async () => {
    selectQueue.push(
      [{ ...CABA_PET, jurisdictionLocality: "Palermo" }], // pets SELECT (barrio)
      [], // petIdentifications (no chip)
      [], // ownerships (no owner)
      [], // cases (no open cases) — findOpenCasesForPetWithCodes
    );
    // Whole-province assignment — governs every barrio in CABA.
    const result = await loadOperatorPetSubView("DIM-CABA-0001", {
      role: "govt",
      jurisdictions: [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }],
    });
    expect(result).not.toBeNull();
    expect(result?.publicToken).toBe("DIM-CABA-0001");
    expect(mockSelect).toHaveBeenCalledTimes(4);
  });

  it("an admin (universal scope) resolves a pet regardless of its jurisdiction", async () => {
    selectQueue.push(
      [{ ...CABA_PET, jurisdictionProvince: "Mendoza", jurisdictionLocality: "Mendoza" }],
      [],
      [],
      [],
    );
    const result = await loadOperatorPetSubView("DIM-CABA-0001", { role: "admin" });
    expect(result).not.toBeNull();
    expect(result?.publicToken).toBe("DIM-CABA-0001");
  });
});
