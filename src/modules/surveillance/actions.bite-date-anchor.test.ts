// RO-HIGH (tier-3 event-sourcing critique): the bite date is the legal anchor of
// the 10-day rabies observation. A bare YYYY-MM-DD from <input type="date"> parsed
// with `new Date("2026-07-01")` is midnight UTC = the PREVIOUS AR calendar day
// (UTC−3), so every bite was recorded one AR-day early. These tests feed a bare
// date to the real action and assert the occurredAt handed to the use-case falls
// on the reporter's AR calendar day. They FAIL against the pre-fix `new Date(...)`.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AR_TIME_ZONE } from "@/lib/utils/format";

// --- Mocks: keep the action's real date-parsing, stub every collaborator ------

const reportBiteMock = vi.fn();
const reportBiteFromOrgMock = vi.fn();
const findPetByTokenMock = vi.fn();

vi.mock("@/db", () => ({
  db: { transaction: vi.fn(), insert: vi.fn(() => ({ values: vi.fn() })) },
  notifications: {},
}));

vi.mock("./infrastructure/surveillance-repository", () => ({
  SurveillanceRepository: class {
    findPetByToken = (...args: unknown[]) => findPetByTokenMock(...args);
  },
}));

vi.mock("@/lib/infra/pet-access", () => ({
  requireAlivePetAccess: vi.fn(),
}));

vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  requireCapabilityForOrgToken: vi.fn(),
}));

vi.mock("./application/report-bite", () => ({
  reportBite: (...args: unknown[]) => reportBiteMock(...args),
}));

vi.mock("./application/report-bite-from-org", () => ({
  reportBiteFromOrg: (...args: unknown[]) => reportBiteFromOrgMock(...args),
}));

vi.mock("@/lib/domain/location-normalize", () => ({
  CoordError: class extends Error {},
  assertLocationCoords: vi.fn(),
  normalizeLocationForWrite: vi
    .fn()
    .mockResolvedValue({ province: null, locality: null, lat: null, lng: null }),
}));

vi.mock("@/lib/domain/location-value", () => ({
  parseLocationFromFormData: vi.fn().mockReturnValue({}),
}));

// The place resolver (localidades-por-id A2) is pinned in
// actions.bite-place.test.ts; here it answers "nothing entered".
vi.mock("@/lib/place/reported-place", () => {
  const nothing = async () => ({
    province: null,
    locality: null,
    localityId: null,
    method: "unresolved",
    unresolvedReason: "none_entered",
    mismatch: false,
    entered: { province: null, locality: null, indecId: null },
  });
  return { resolveMapFormPlace: vi.fn(nothing), resolveReportedPlace: vi.fn(nothing) };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  // The action calls redirect() on success AFTER handing occurredAt to the
  // use-case; a throwing stub short-circuits so the test never leaves the action.
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

import { requireAlivePetAccess } from "@/lib/infra/pet-access";
import { requireCapabilityForOrgToken } from "@/src/modules/organizations/infrastructure/authz-resolver";
// Imported AFTER the mocks are registered.
import { reportBiteAction, reportBiteFromOrgAction } from "./actions";

const FAKE_PET = {
  id: "pet-1",
  publicToken: "tok-1",
  name: "Firulais",
  species: "dog",
  status: "alive",
  rabiesObservationStatus: null,
  jurisdictionProvince: null,
  jurisdictionLocality: null,
};

function biteFormData(occurredAt: string): FormData {
  const fd = new FormData();
  fd.set("occurredAt", occurredAt);
  fd.set("victimKind", "human");
  fd.set("severity", "minor");
  fd.set("confirmObservation", "on");
  return fd;
}

/** The AR calendar day (ISO YYYY-MM-DD) a Date lands on. */
function arCalendarDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

describe("reportBiteAction — bite date anchored on the reporter's AR calendar day (RO-HIGH)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reportBiteMock.mockResolvedValue({
      ok: true,
      value: { casePublicCode: "CAS-AAAA-BBBB" },
      notifications: [],
    });
    (requireAlivePetAccess as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      pet: FAKE_PET,
      user: { id: "user-1" },
      eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
    });
  });

  it("stores occurredAt on the picked AR day, not the previous one (owner path)", async () => {
    // A bare date whose midnight-UTC instant falls on the previous AR day.
    await reportBiteAction("tok-1", { error: null }, biteFormData("2026-07-01")).catch(() => {});

    expect(reportBiteMock).toHaveBeenCalledTimes(1);
    const input = reportBiteMock.mock.calls[0][0] as { occurredAt: Date };
    expect(arCalendarDay(input.occurredAt)).toBe("2026-07-01");
  });
});

describe("reportBiteFromOrgAction — bite date anchored on the reporter's AR calendar day (RO-HIGH)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reportBiteFromOrgMock.mockResolvedValue({
      ok: true,
      value: { casePublicCode: "CAS-AAAA-BBBB" },
      notifications: [],
    });
    (requireCapabilityForOrgToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      error: null,
      user: { id: "user-1" },
      organization: {
        id: "org-1",
        displayName: "Refugio",
        orgType: "shelter",
        verified: true,
      },
    });
  });

  it("stores occurredAt on the picked AR day, not the previous one (org path)", async () => {
    const fd = biteFormData("2026-07-01");
    fd.set("petPublicToken", "tok-1");
    // The org path looks the pet up via the repository; stub it to return alive.
    findPetByTokenMock.mockResolvedValue(FAKE_PET);

    await reportBiteFromOrgAction("org-tok", { error: null }, fd).catch(() => {});

    expect(reportBiteFromOrgMock).toHaveBeenCalledTimes(1);
    const input = reportBiteFromOrgMock.mock.calls[0][0] as { occurredAt: Date };
    expect(arCalendarDay(input.occurredAt)).toBe("2026-07-01");
  });

  // H1 (2026-08-22) — this file's mock is where the action's guard is visible,
  // so the pin lives here. Until then the guard was bare `requireCapability`,
  // which resolves the caller's most-recently-joined membership and never looks
  // at `orgToken`: a member of several orgs acting under /org/{A} was authorized
  // and attributed against whichever org they joined last.
  it("authorizes against the org in the URL, not the caller's last-joined membership", async () => {
    const fd = biteFormData("2026-07-01");
    fd.set("petPublicToken", "tok-1");
    findPetByTokenMock.mockResolvedValue(FAKE_PET);

    await reportBiteFromOrgAction("org-tok", { error: null }, fd).catch(() => {});

    expect(requireCapabilityForOrgToken).toHaveBeenCalledWith("bite.report", "org-tok");
  });
});

// FIX-25 #1 (PO, 2026-09-25) — web location provenance parity with the app/API
// path. A client-sent "geocodificada" is ranked "verificado" for officials by
// lib/domain/provenance.ts, so the server never stores the client's claim: a
// point the client sent is `pin_manual`, no point is null.
/** A parsed form location with (or without) a point and no pair. */
function withPoint(lat: number | null, lng: number | null) {
  return {
    province: null,
    provinceCode: null,
    locality: null,
    localityIndecId: null,
    lat,
    lng,
    address: null,
  };
}

describe("bite actions — a client-claimed location source is never stored (provenance parity)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // The point reaches the action through the parsed form (localidades-por-id
    // A2: the bite actions no longer read coordinates back from the gate).
    const { parseLocationFromFormData } = await import("@/lib/domain/location-value");
    (parseLocationFromFormData as ReturnType<typeof vi.fn>).mockReturnValue(
      withPoint(-34.6, -58.4),
    );
    reportBiteMock.mockResolvedValue({
      ok: true,
      value: { casePublicCode: "CAS-AAAA-BBBB" },
      notifications: [],
    });
    reportBiteFromOrgMock.mockResolvedValue({
      ok: true,
      value: { casePublicCode: "CAS-AAAA-BBBB" },
      notifications: [],
    });
    (requireAlivePetAccess as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      pet: FAKE_PET,
      user: { id: "user-1" },
      eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
    });
    (requireCapabilityForOrgToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      error: null,
      user: { id: "user-1" },
      organization: { id: "org-1", displayName: "Refugio", orgType: "shelter", verified: true },
    });
    findPetByTokenMock.mockResolvedValue(FAKE_PET);
  });

  it("owner path: a forged 'geocodificada' with a point is stored as pin_manual", async () => {
    const fd = biteFormData("2026-07-01");
    fd.set("locationSource", "geocodificada");
    await reportBiteAction("tok-1", { error: null }, fd).catch(() => {});

    expect(reportBiteMock).toHaveBeenCalledTimes(1);
    const input = reportBiteMock.mock.calls[0][0] as { locationSource: unknown };
    expect(input.locationSource).toBe("pin_manual");
  });

  it("org path: a forged 'geocodificada' with a point is stored as pin_manual", async () => {
    const fd = biteFormData("2026-07-01");
    fd.set("petPublicToken", "tok-1");
    fd.set("locationSource", "geocodificada");
    await reportBiteFromOrgAction("org-tok", { error: null }, fd).catch(() => {});

    expect(reportBiteFromOrgMock).toHaveBeenCalledTimes(1);
    const input = reportBiteFromOrgMock.mock.calls[0][0] as { locationSource: unknown };
    expect(input.locationSource).toBe("pin_manual");
  });

  it("a forged 'geocodificada' with NO point stores no source at all", async () => {
    const { parseLocationFromFormData } = await import("@/lib/domain/location-value");
    (parseLocationFromFormData as ReturnType<typeof vi.fn>).mockReturnValue(withPoint(null, null));
    const fd = biteFormData("2026-07-01");
    fd.set("locationSource", "geocodificada");
    await reportBiteAction("tok-1", { error: null }, fd).catch(() => {});

    const input = reportBiteMock.mock.calls[0][0] as { locationSource: unknown };
    expect(input.locationSource).toBeNull();
  });
});
