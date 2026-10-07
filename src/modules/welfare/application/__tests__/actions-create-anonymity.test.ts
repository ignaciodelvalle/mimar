// Anonymity-gating tests for createWelfareReportAction.
//
// PO decision (2026-07-08): the wizard's "Enviar anónima" choice must fully
// unlink the report from any logged-in account. A logged-in user who submits
// anonymously gets reporter_user_id = null and lands on the anonymous
// tracking-code surface (/denuncias/codigo/DEN-XXXX). Only a non-anonymous
// submission attaches the account and redirects to /denuncias/mias.
//
// These tests drive the action to the insert + redirect. Repo, db.transaction,
// case-helpers, moderation, geocoding, supabase, rate-limit and next/* are all
// mocked so no Postgres/network is touched.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted spies (created before vi.mock factories run)
// ---------------------------------------------------------------------------

const {
  mockInsertReportWithRetry,
  mockFindPetByToken,
  mockFindActiveOwnership,
  mockInsertAttachments,
  mockLinkCase,
  mockInsertPetEventIdempotent,
  mockSetFlagged,
  mockOpenCase,
  mockRedirect,
  mockTransaction,
  mockFindBridgedReportReplay,
  mockLockAndFindBridgedReportReplay,
  mockDeleteUnlinkedReport,
  mockRequireUserOrRedirect,
  mockDbSelect,
  mockFindReportByKeyDigest,
  mockLockAndFindReportByKeyDigest,
  mockCookieSet,
} = vi.hoisted(() => ({
  mockInsertReportWithRetry: vi.fn(),
  mockFindPetByToken: vi.fn(),
  mockFindActiveOwnership: vi.fn(),
  mockInsertAttachments: vi.fn(),
  mockLinkCase: vi.fn(),
  mockInsertPetEventIdempotent: vi.fn(),
  mockSetFlagged: vi.fn(),
  mockOpenCase: vi.fn(),
  mockRedirect: vi.fn(),
  mockTransaction: vi.fn(),
  mockFindBridgedReportReplay: vi.fn(),
  mockLockAndFindBridgedReportReplay: vi.fn(),
  mockDeleteUnlinkedReport: vi.fn(),
  mockRequireUserOrRedirect: vi.fn(),
  mockDbSelect: vi.fn(),
  mockFindReportByKeyDigest: vi.fn(),
  mockLockAndFindReportByKeyDigest: vi.fn(),
  // The reporter-session cookie (mintFreshReporterSession): an anonymous
  // replay must never set one.
  mockCookieSet: vi.fn(),
}));

vi.mock("../../infrastructure/welfare-repository", () => {
  class WelfareRepository {
    insertReportWithRetry = mockInsertReportWithRetry;
    findPetByToken = mockFindPetByToken;
    findActiveOwnership = mockFindActiveOwnership;
    insertAttachments = mockInsertAttachments;
    linkCase = mockLinkCase;
    insertPetEventIdempotent = mockInsertPetEventIdempotent;
    setFlagged = mockSetFlagged;
    findBridgedReportReplay = mockFindBridgedReportReplay;
    lockAndFindBridgedReportReplay = mockLockAndFindBridgedReportReplay;
    deleteUnlinkedReport = mockDeleteUnlinkedReport;
    findReportByKeyDigest = mockFindReportByKeyDigest;
    lockAndFindReportByKeyDigest = mockLockAndFindReportByKeyDigest;
  }
  return { WelfareRepository };
});

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return {
    ...actual,
    // `select` serves the org action's membership gate (one chained query).
    db: { transaction: mockTransaction, select: mockDbSelect },
  };
});

// Evidence I/O. The org report REQUIRES a file, so its tests need these; the
// citizen tests send none and never reach them.
vi.mock("@/lib/infra/welfare-uploads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infra/welfare-uploads")>()),
  prepareWelfareEvidence: vi.fn(async () => ({ error: null, prepared: [{}] })),
  uploadPreparedWelfareEvidence: vi.fn(async () => ({
    error: null,
    uploaded: [
      {
        storagePath: "welfare-evidence/report-2/evidencia.jpg",
        mimeType: "image/jpeg",
        fileSize: 1024,
        originalFilename: "evidencia.jpg",
      },
    ],
    uploadedPaths: ["welfare-evidence/report-2/evidencia.jpg"],
  })),
  removeWelfareEvidence: vi.fn(async () => undefined),
}));

// The org action's session gate. The citizen action never calls it.
vi.mock("@/lib/infra/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infra/auth-guards")>()),
  requireUserOrRedirect: mockRequireUserOrRedirect,
}));

vi.mock("@/lib/infra/case-helpers", () => ({
  openCase: mockOpenCase,
  closeCase: vi.fn(),
}));

vi.mock("@/lib/infra/welfare-moderation", () => ({
  computeFlagReasons: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/domain/authority", () => ({
  signalWelfareReport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/domain/location-normalize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain/location-normalize")>();
  return {
    ...actual,
    // The pin is not this file's subject: its range and presence are pinned in
    // welfare-coord-error.test.ts.
    assertLocationCoords: vi.fn(),
    normalizeLocationForWrite: vi.fn().mockResolvedValue({
      address: null,
      province: null,
      locality: null,
      lat: null,
      lng: null,
    }),
  };
});

// The denuncia's place (localidades-por-id A6) is resolved by one composition,
// pinned against the real catalogue in lib/place/denuncia-place.test.ts; this
// file's fake client cannot answer it, and nothing here is about placement.
vi.mock("@/lib/place/denuncia-place", () => ({
  resolveDenunciaJurisdiction: vi.fn(async () => ({
    province: null,
    locality: null,
    localityId: null,
    unverified: true,
  })),
}));

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: vi.fn().mockResolvedValue(undefined),
    callerIp: vi.fn().mockReturnValue("1.2.3.4"),
  };
});

// requireLiveUser (T1.2) resolves profiles.deleted_at / deactivated_at from the
// DATABASE — the guard is deliberately not claim-based. These action tests mock
// the Supabase client but not the profile read, so without this the guard would
// issue a real query with a fixture user id. A healthy profile keeps every
// assertion below testing what it was written to test.
vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: vi.fn(async (id: string) => ({
    id,
    role: "owner" as const,
    displayName: "Fixture",
    accountType: "personal" as const,
    deactivatedAt: null,
    deletedAt: null,
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

// next/headers — BOTH exports the app reads. `headers` is what the action
// under test uses (the caller IP); `cookies` is read by modules elsewhere in
// the import graph (lib/supabase/server.ts, src/modules/adoption/actions.ts).
// A mock that lists only `headers` logged `No "cookies" export on the
// "next/headers" mock` twice per run — a warning today, and a broken file the
// day a module in this graph reads it at evaluation time (the 2026-08-22
// set-pet-lost-coord-range lesson, one mock over). The store is empty: no
// test here depends on a cookie.
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Map([["x-forwarded-for", "1.2.3.4"]])),
  cookies: vi.fn().mockResolvedValue({
    get: () => undefined,
    getAll: () => [],
    has: () => false,
    set: mockCookieSet,
    delete: () => undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REF_CODE = "DEN-TEST-0001";

function setUser(user: { id: string } | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
    storage: { from: vi.fn().mockReturnValue({ remove: vi.fn().mockResolvedValue({}) }) },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
}

/** A minimal, valid welfare report FormData (no location, no files). */
function baseFormData(contactMode: "anonymous" | "with_contact"): FormData {
  const fd = new FormData();
  fd.set("kind", "neglect");
  fd.set("severity", "medium");
  fd.set("description", "El animal parece estar desnutrido y sin agua.");
  fd.set("subjectKind", "unowned_animal");
  fd.set("subjectDescription", "Perro callejero en la esquina.");
  fd.set("contactMode", contactMode);
  return fd;
}

function reporterUserIdFromInsert(): string | null {
  return mockInsertReportWithRetry.mock.calls[0][0].reporterUserId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWelfareReportAction — anonymity fully unlinks the account", () => {
  vi.setConfig({ testTimeout: 20_000 });

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertReportWithRetry.mockResolvedValue({ id: "report-1", referenceCode: REF_CODE });
    mockFindPetByToken.mockResolvedValue(null);
    mockFindActiveOwnership.mockResolvedValue(null);
    mockOpenCase.mockResolvedValue({ id: "case-1", publicCode: "CASE-1" });
    // db.transaction just runs the callback with a dummy tx.
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
  });

  it("anonymous + logged-in session: reporter_user_id is null and redirect goes to the tracking code", async () => {
    setUser({ id: "user-123" });

    const { createWelfareReportAction } = await import("../../actions");
    const state = await createWelfareReportAction({ error: null }, baseFormData("anonymous"));

    // The report row must NOT carry the account id.
    expect(reporterUserIdFromInsert()).toBeNull();
    // The case opened for it must not attribute an opener either.
    expect(mockOpenCase).toHaveBeenCalledWith(
      expect.objectContaining({ openedByUserId: null }),
      expect.anything(),
    );
    // Lands on the anonymous tracking surface (retrievable by DEN code), NOT
    // /denuncias/mias. Asserted on the RETURNED destination since the B.2
    // migration — the action no longer calls redirect(), whose transition the
    // App Router drops: a filed report and no receipt (nav contract N3).
    expect(state.redirectTo).toBe(`/denuncias/codigo/${REF_CODE}?nueva=1`);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("non-anonymous + logged-in session: reporter_user_id is the user and redirect goes to /denuncias/mias", async () => {
    setUser({ id: "user-123" });

    const fd = baseFormData("with_contact");
    fd.set("reporterContactEmail", "reporter@example.com");

    const { createWelfareReportAction } = await import("../../actions");
    const state = await createWelfareReportAction({ error: null }, fd);

    expect(reporterUserIdFromInsert()).toBe("user-123");
    expect(mockOpenCase).toHaveBeenCalledWith(
      expect.objectContaining({ openedByUserId: "user-123" }),
      expect.anything(),
    );
    expect(state.redirectTo).toBe("/denuncias/mias");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("anonymous + no session: unchanged — reporter_user_id null, tracking-code redirect", async () => {
    setUser(null);

    const { createWelfareReportAction } = await import("../../actions");
    const state = await createWelfareReportAction({ error: null }, baseFormData("anonymous"));

    expect(reporterUserIdFromInsert()).toBeNull();
    expect(state.redirectTo).toBe(`/denuncias/codigo/${REF_CODE}?nueva=1`);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Replay before the report row exists (plan A5c). A retry of a denuncia that
// already succeeded used to insert a second report and open a second
// welfare_denuncia case (that kind is exempt from the one-open-case index).
// ---------------------------------------------------------------------------

describe("createWelfareReportAction — a retry with the same key replays", () => {
  vi.setConfig({ testTimeout: 20_000 });

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertReportWithRetry.mockResolvedValue({ id: "report-2", referenceCode: REF_CODE });
    mockFindPetByToken.mockResolvedValue({ id: "pet-1", seedTag: null });
    mockFindActiveOwnership.mockResolvedValue(null);
    mockOpenCase.mockResolvedValue({ id: "case-2", publicCode: "CASE-2" });
    mockInsertPetEventIdempotent.mockResolvedValue({ wasNoop: false, eventId: "evt-1" });
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
  });

  function petReport(key: string, contactMode: "anonymous" | "with_contact"): FormData {
    const fd = baseFormData(contactMode);
    fd.set("kind", "physical_abuse");
    fd.set("subjectKind", "registered_pet");
    fd.set("subjectPetToken", "DIM-PET1-TEST");
    fd.set("clientIdempotencyKey", key);
    if (contactMode === "with_contact") fd.set("reporterContactEmail", "reporter@example.com");
    return fd;
  }

  it("same key, same reporter: lands on the original — no second report, no second case", async () => {
    setUser({ id: "user-123" });
    mockFindBridgedReportReplay.mockResolvedValue({
      reportId: "report-1",
      referenceCode: REF_CODE,
    });

    const { createWelfareReportAction } = await import("../../actions");
    const state = await createWelfareReportAction(
      { error: null },
      petReport("key-retry", "with_contact"),
    );

    expect(state).toEqual({ error: null, redirectTo: "/denuncias/mias" });
    expect(mockFindBridgedReportReplay).toHaveBeenCalledWith("pet-1", "key-retry", "user-123");
    expect(mockInsertReportWithRetry).not.toHaveBeenCalled();
    expect(mockOpenCase).not.toHaveBeenCalled();
  });

  it("a key the ledger has never seen files a new report", async () => {
    setUser({ id: "user-123" });
    mockFindBridgedReportReplay.mockResolvedValue(null);

    const { createWelfareReportAction } = await import("../../actions");
    await createWelfareReportAction({ error: null }, petReport("key-new", "with_contact"));

    expect(mockInsertReportWithRetry).toHaveBeenCalledTimes(1);
    expect(mockOpenCase).toHaveBeenCalledTimes(1);
  });

  it("an anonymous report is never replayed: there is no reporter to scope the key to", async () => {
    setUser({ id: "user-123" });

    const { createWelfareReportAction } = await import("../../actions");
    await createWelfareReportAction({ error: null }, petReport("key-anon", "anonymous"));

    expect(mockFindBridgedReportReplay).not.toHaveBeenCalled();
    expect(mockInsertReportWithRetry).toHaveBeenCalledTimes(1);
  });
});

// The concurrent half: the pre-check missed (the twin had not committed), the
// write's own claim found it, and this submit's inserted row and files go.
describe("createWelfareReportAction — a concurrent twin filed it first", () => {
  vi.setConfig({ testTimeout: 20_000 });

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertReportWithRetry.mockResolvedValue({ id: "report-2", referenceCode: "DEN-TWIN-0002" });
    mockFindPetByToken.mockResolvedValue({ id: "pet-1", seedTag: null });
    mockFindActiveOwnership.mockResolvedValue(null);
    mockFindBridgedReportReplay.mockResolvedValue(null);
    mockLockAndFindBridgedReportReplay.mockResolvedValue({
      reportId: "report-1",
      referenceCode: REF_CODE,
    });
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
  });

  it("discards the row it inserted and lands on the original", async () => {
    setUser({ id: "user-123" });
    const fd = baseFormData("with_contact");
    fd.set("kind", "physical_abuse");
    fd.set("subjectKind", "registered_pet");
    fd.set("subjectPetToken", "DIM-PET1-TEST");
    fd.set("clientIdempotencyKey", "key-twin");
    fd.set("reporterContactEmail", "reporter@example.com");

    const { createWelfareReportAction } = await import("../../actions");
    const state = await createWelfareReportAction({ error: null }, fd);

    expect(state).toEqual({ error: null, redirectTo: "/denuncias/mias" });
    expect(mockDeleteUnlinkedReport).toHaveBeenCalledWith("report-2");
    expect(mockOpenCase).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The ORG door's replay (plan A5c): same key + same member lands on the
// original before any report row or case exists; another member does not.
// ---------------------------------------------------------------------------

describe("createOrgWelfareReportAction — a retry with the same key replays", () => {
  vi.setConfig({ testTimeout: 20_000 });

  const ORG_ROW = {
    orgId: "org-1",
    orgDisplayName: "Refugio Test",
    orgVerified: true,
    memberRole: "coordinator",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // The membership gate: select().from().innerJoin().where().limit() → [ORG_ROW].
    const chain = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue([ORG_ROW]),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    mockDbSelect.mockReturnValue(chain);
    mockFindPetByToken.mockResolvedValue({ id: "pet-1", seedTag: null });
  });

  function orgPetReport(key: string): FormData {
    const fd = new FormData();
    fd.set("kind", "physical_abuse");
    fd.set(
      "description",
      "Documentamos durante tres visitas que el animal permanece atado sin agua ni sombra, con lesiones visibles en el lomo y las patas traseras.",
    );
    fd.set("subjectKind", "registered_pet");
    fd.set("subjectPetToken", "DIM-PET1-TEST");
    fd.set("clientIdempotencyKey", key);
    return fd;
  }

  it("same key, same member: lands on the original — no report row, no case", async () => {
    mockRequireUserOrRedirect.mockResolvedValue({ user: { id: "member-1" } });
    mockFindBridgedReportReplay.mockResolvedValue({
      reportId: "report-1",
      referenceCode: REF_CODE,
    });

    const { createOrgWelfareReportAction } = await import("../../actions");
    const state = await createOrgWelfareReportAction(
      "org-tok-1",
      { error: null },
      orgPetReport("k1"),
    );

    expect(state).toEqual({
      error: null,
      redirectTo: `/org/org-tok-1/maltrato/recibidos?tab=emitidos&creado=${REF_CODE}`,
    });
    expect(mockFindBridgedReportReplay).toHaveBeenCalledWith("pet-1", "k1", "member-1");
    expect(mockInsertReportWithRetry).not.toHaveBeenCalled();
    expect(mockOpenCase).not.toHaveBeenCalled();
  });

  it("another member with the same key is asked about THEIR key and gets no replay", async () => {
    mockRequireUserOrRedirect.mockResolvedValue({ user: { id: "member-2" } });
    // The ledger is scoped to the reporter: nothing filed by member-2 under k1.
    mockFindBridgedReportReplay.mockImplementation(
      async (_pet: string, _key: string, reporter: string) =>
        reporter === "member-1" ? { reportId: "report-1", referenceCode: REF_CODE } : null,
    );

    const { createOrgWelfareReportAction } = await import("../../actions");
    const state = await createOrgWelfareReportAction(
      "org-tok-1",
      { error: null },
      orgPetReport("k1"),
    );

    expect(mockFindBridgedReportReplay).toHaveBeenCalledWith("pet-1", "k1", "member-2");
    // Not a replay: it went on to the org report's own gates (evidence is
    // required, and this form carries none).
    expect(state.redirectTo).toBeUndefined();
    expect(state.error).toBe("Una denuncia profesional requiere al menos un adjunto de evidencia.");
  });
});

// The org door's CONCURRENT half: its pre-check missed, the write's own claim
// found the twin, and this submit's row and files go.
describe("createOrgWelfareReportAction — a concurrent twin filed it first", () => {
  vi.setConfig({ testTimeout: 20_000 });

  beforeEach(() => {
    vi.clearAllMocks();
    const chain = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue([
        {
          orgId: "org-1",
          orgDisplayName: "Refugio Test",
          orgVerified: true,
          memberRole: "coordinator",
        },
      ]),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    mockDbSelect.mockReturnValue(chain);
    mockRequireUserOrRedirect.mockResolvedValue({ user: { id: "member-1" } });
    mockFindPetByToken.mockResolvedValue({ id: "pet-1", seedTag: null });
    mockFindBridgedReportReplay.mockResolvedValue(null);
    mockInsertReportWithRetry.mockResolvedValue({ id: "report-2", referenceCode: "DEN-TWIN-0002" });
    mockLockAndFindBridgedReportReplay.mockResolvedValue({
      reportId: "report-1",
      referenceCode: REF_CODE,
    });
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
  });

  it("discards the row it inserted and lands on the original's EMITIDOS", async () => {
    const fd = new FormData();
    fd.set("kind", "physical_abuse");
    fd.set(
      "description",
      "Documentamos durante tres visitas que el animal permanece atado sin agua ni sombra, con lesiones visibles en el lomo y las patas traseras.",
    );
    fd.set("subjectKind", "registered_pet");
    fd.set("subjectPetToken", "DIM-PET1-TEST");
    fd.set("clientIdempotencyKey", "k-twin");
    fd.append(
      "attachment",
      new File([new Uint8Array([1, 2, 3])], "evidencia.jpg", { type: "image/jpeg" }),
    );

    const { createOrgWelfareReportAction } = await import("../../actions");
    const state = await createOrgWelfareReportAction("org-tok-1", { error: null }, fd);

    expect(state).toEqual({
      error: null,
      redirectTo: `/org/org-tok-1/maltrato/recibidos?tab=emitidos&creado=${REF_CODE}`,
    });
    expect(mockLockAndFindBridgedReportReplay).toHaveBeenCalledWith(
      "pet-1",
      "k-twin",
      "member-1",
      {},
    );
    expect(mockDeleteUnlinkedReport).toHaveBeenCalledWith("report-2");
    expect(mockOpenCase).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The report-level replay (plan A5f, migration 0289). An ANONYMOUS denuncia
// about an unowned animal — no reporter, no pet, no bridge event — used to
// file a second report and case on every retry. The key's digest is the only
// scope an anonymous submitter has, so its replay must carry nothing.
// ---------------------------------------------------------------------------

describe("createWelfareReportAction — an anonymous retry lands on what it filed, and learns nothing", () => {
  vi.setConfig({ testTimeout: 20_000 });

  const VICTIM_KEY = "0f9e8d7c-6b5a-4f3e-8d2c-1b0a9f8e7d6c";
  const OTHER_KEY = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const ORIGINAL = { reportId: "report-victim", referenceCode: "DEN-VICT-0001" };

  /** The ledger knows exactly one filing: the victim's anonymous one. */
  async function ledgerWithVictim() {
    const { reportKeyDigest } = await import("../../domain/report-key-digest");
    const victimDigest = reportKeyDigest(VICTIM_KEY, null);
    mockFindReportByKeyDigest.mockImplementation(async (digest: string) =>
      digest === victimDigest ? ORIGINAL : null,
    );
    return { reportKeyDigest, victimDigest };
  }

  function anonReport(key: string): FormData {
    const fd = baseFormData("anonymous");
    fd.set("clientIdempotencyKey", key);
    return fd;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertReportWithRetry.mockResolvedValue({ id: "report-2", referenceCode: "DEN-NEW-0002" });
    mockFindPetByToken.mockResolvedValue(null);
    mockFindReportByKeyDigest.mockResolvedValue(null);
    mockLockAndFindReportByKeyDigest.mockResolvedValue(null);
    mockOpenCase.mockResolvedValue({ id: "case-2", publicCode: "CASE-2" });
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
  });

  it("same key: no second report, no second case, no session — and nothing of the original in the answer", async () => {
    setUser(null);
    const { victimDigest } = await ledgerWithVictim();

    const { createWelfareReportAction } = await import("../../actions");
    const state = await createWelfareReportAction({ error: null }, anonReport(VICTIM_KEY));

    expect(mockFindReportByKeyDigest).toHaveBeenCalledWith(victimDigest);
    expect(mockInsertReportWithRetry).not.toHaveBeenCalled();
    expect(mockOpenCase).not.toHaveBeenCalled();
    // No reporter session: the key alone does not open the denuncia.
    expect(mockCookieSet).not.toHaveBeenCalled();
    // The answer is a notice and no destination, carrying neither the
    // original's id nor its reference code.
    expect(state.redirectTo).toBeUndefined();
    expect(state.error).toMatch(/ya había sido recibida/);
    expect(JSON.stringify(state)).not.toContain(ORIGINAL.referenceCode);
    expect(JSON.stringify(state)).not.toContain(ORIGINAL.reportId);
  });

  it("a different key files its own report and gets its own receipt", async () => {
    setUser(null);
    const { reportKeyDigest } = await ledgerWithVictim();

    const { createWelfareReportAction } = await import("../../actions");
    const state = await createWelfareReportAction({ error: null }, anonReport(OTHER_KEY));

    expect(mockFindReportByKeyDigest).toHaveBeenCalledWith(reportKeyDigest(OTHER_KEY, null));
    expect(mockInsertReportWithRetry).toHaveBeenCalledTimes(1);
    expect(mockOpenCase).toHaveBeenCalledTimes(1);
    expect(state.redirectTo).toBe("/denuncias/codigo/DEN-NEW-0002?nueva=1");
    // The digest is stamped with the case, inside the write.
    expect(mockLinkCase).toHaveBeenCalledWith(
      "report-2",
      "case-2",
      {},
      reportKeyDigest(OTHER_KEY, null),
    );
  });

  it("a logged-in, non-anonymous person presenting an anonymous key reaches their OWN slot, not the anonymous one", async () => {
    setUser({ id: "user-123" });
    const { reportKeyDigest } = await ledgerWithVictim();

    const fd = baseFormData("with_contact");
    fd.set("reporterContactEmail", "reporter@example.com");
    fd.set("clientIdempotencyKey", VICTIM_KEY);
    const { createWelfareReportAction } = await import("../../actions");
    const state = await createWelfareReportAction({ error: null }, fd);

    expect(mockFindReportByKeyDigest).toHaveBeenCalledWith(reportKeyDigest(VICTIM_KEY, "user-123"));
    // Filed as a new report of their own; the anonymous one never surfaced.
    expect(mockInsertReportWithRetry).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ error: null, redirectTo: "/denuncias/mias" });
  });

  it("a concurrent anonymous twin: this submit's row goes, no session is minted, nothing of the original returns", async () => {
    setUser(null);
    // The pre-check missed (the twin had not committed); the write's claim found it.
    mockLockAndFindReportByKeyDigest.mockResolvedValue(ORIGINAL);

    const { createWelfareReportAction } = await import("../../actions");
    const state = await createWelfareReportAction({ error: null }, anonReport(VICTIM_KEY));

    expect(mockInsertReportWithRetry).toHaveBeenCalledTimes(1);
    expect(mockOpenCase).not.toHaveBeenCalled();
    expect(mockDeleteUnlinkedReport).toHaveBeenCalledWith("report-2");
    expect(mockCookieSet).not.toHaveBeenCalled();
    expect(state.redirectTo).toBeUndefined();
    expect(state.error).toMatch(/ya había sido recibida/);
    expect(JSON.stringify(state)).not.toContain(ORIGINAL.referenceCode);
    // Not even this submit's own discarded code.
    expect(JSON.stringify(state)).not.toContain("DEN-NEW-0002");
  });

  it("a filed anonymous report DOES mint its session — the guard above is the replay's, not the filing's", async () => {
    setUser(null);
    const { createWelfareReportAction } = await import("../../actions");
    await createWelfareReportAction({ error: null }, anonReport(OTHER_KEY));
    expect(mockCookieSet).toHaveBeenCalledTimes(1);
  });
});
