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
  }
  return { WelfareRepository };
});

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return {
    ...actual,
    db: { transaction: mockTransaction },
  };
});

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
    normalizeLocationForWrite: vi.fn().mockResolvedValue({
      address: null,
      province: null,
      locality: null,
      lat: null,
      lng: null,
    }),
  };
});

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
    set: () => undefined,
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
    expect(mockOpenCase).toHaveBeenCalledWith(expect.objectContaining({ openedByUserId: null }));
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
