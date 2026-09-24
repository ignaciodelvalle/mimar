// Fix A (2026-09-18 security review): a failed EXIF strip must not leave an
// evidence-less welfare_reports row behind.
//
// Before the fix, only the storage-free checks (count, HEIC, type, size) ran
// before `repo.insertReportWithRetry`; the strip's fail-closed refusal ran
// INSIDE `uploadWelfareEvidence`, which by construction ran AFTER that insert
// on both the citizen (createWelfareReportAction) and org
// (createOrgWelfareReportAction) create paths. A corrupt JPEG — or any file
// sharp could not decode — left a report row with no evidence behind, and
// another one on every retry (worse on the org path, which requires at least
// one attachment).
//
// These tests prove the ORDERING directly: `repo.insertReportWithRetry` (the
// call that creates the row) must never run when `prepareWelfareEvidence`
// refuses.
//
// Fully mocked — no real Postgres, no real Supabase Storage. `sharp` is
// mocked to always throw, so the strip fails deterministically without
// needing genuinely corrupt image bytes. Scaffold mirrors
// `welfare-coord-error.test.ts` (same @/db mock shape, same real
// `normalizeLocationForWrite` / `resolveRoutableJurisdiction`), extended with
// an `innerJoin` step and an organizations-table branch for the org path's
// membership query.
//
// CLASSIFICATION NOTE: this file imports `@/src/modules/welfare/actions`,
// which imports `@/db` — the suite partition (`__tests__/db-reachability.ts`)
// is MECHANICAL (import-graph reachability), not aware that `@/db` is mocked
// below. That puts this file in the "db" vitest project even though nothing
// here touches a real database. Run it with
// `pnpm exec vitest run --project db __tests__/welfare-evidence-strip-ordering.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: sharp — the strip always fails, so prepareWelfareEvidence always
// refuses for a raster attachment. Deterministic, no real image bytes needed.
// ---------------------------------------------------------------------------
const mockToBuffer = vi.fn();
const mockRotate = vi.fn(() => ({ toBuffer: mockToBuffer }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSharpFn = vi.fn((_arg: any) => ({ rotate: mockRotate }));
vi.mock("sharp", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (arg: any) => mockSharpFn(arg),
}));

// ---------------------------------------------------------------------------
// Mock: server-only / next
// ---------------------------------------------------------------------------
vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: auth — a logged-in, live, non-deactivated user for both paths.
// ---------------------------------------------------------------------------
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-evidence-order-stub" } },
      }),
    },
  }),
}));

vi.mock("@/lib/infra/rate-limit", () => ({
  enforceRateLimit: vi.fn().mockResolvedValue(undefined),
  callerIp: vi.fn().mockReturnValue("127.0.0.1"),
  RateLimitError: class RateLimitError extends Error {},
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
  requireAdminOrGovtOrRedirect: vi.fn(),
  requireAdminOrRedirect: vi.fn(),
  requireUserOrRedirect: vi.fn().mockResolvedValue({ user: { id: "org-evidence-order-user" } }),
}));

// ---------------------------------------------------------------------------
// Mock: location — parseLocationFromFormData reads raw form fields;
// normalizeLocationForWrite / resolveRoutableJurisdiction run FOR REAL (same
// as welfare-coord-error.test.ts), using the @/db mock below for the D.11
// locality fallback.
// ---------------------------------------------------------------------------
vi.mock("@/lib/domain/location-value", () => ({
  parseLocationFromFormData: vi.fn().mockImplementation((fd: FormData) => ({
    province: String(fd.get("jurisdictionProvince") ?? "") || null,
    provinceCode: null,
    locality: String(fd.get("jurisdictionLocality") ?? "") || null,
    localityIndecId: null,
    lat: fd.get("locationLat") ? Number(fd.get("locationLat")) : null,
    lng: fd.get("locationLng") ? Number(fd.get("locationLng")) : null,
    address: String(fd.get("locationAddress") ?? "") || null,
  })),
}));

vi.mock("@/lib/domain/location", () => ({
  writePoint: vi.fn(() => ({ locationLat: null, locationLng: null })),
}));

vi.mock("@/lib/infra/approval-routing", () => ({
  findAuthoritiesForJurisdiction: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Mock: @/db — generic chainable select() + an organizations-table branch so
// the org path's membership join resolves a verified admin membership.
// ---------------------------------------------------------------------------
const mockTransaction = vi.hoisted(() =>
  vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
);

const { mockInsertReportWithRetry } = vi.hoisted(() => ({
  mockInsertReportWithRetry: vi.fn(),
}));

vi.mock("@/db", () => {
  const organizationsTable = {};
  const organizationMembershipsTable = {};
  const arLocalitiesTable = {};

  const orgQueryResult = Promise.resolve([
    {
      orgId: "org-evidence-order",
      orgDisplayName: "Refugio de prueba",
      orgVerified: true,
      memberRole: "admin",
    },
  ]);
  const emptyResult = Promise.resolve([]);

  const chain = () => {
    let fromTable: unknown = null;
    const step: Record<string, unknown> = {};
    step.from = vi.fn((table: unknown) => {
      fromTable = table;
      return step;
    });
    step.innerJoin = vi.fn(() => step);
    step.where = vi.fn(() => step);
    step.orderBy = vi.fn(() => step);
    step.limit = vi.fn(() => (fromTable === organizationsTable ? orgQueryResult : emptyResult));
    return step;
  };

  return {
    db: {
      transaction: mockTransaction,
      select: vi.fn(() => chain()),
    },
    arLocalities: arLocalitiesTable,
    organizationMemberships: organizationMembershipsTable,
    organizations: organizationsTable,
    welfareReports: {},
    notifications: {},
  };
});

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
  sql: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: the rest of actions.ts's module graph — irrelevant to these tests
// since every case here refuses BEFORE any of it would be reached.
// ---------------------------------------------------------------------------
vi.mock("@/lib/infra/case-helpers", () => ({
  openCase: vi.fn(),
  closeCase: vi.fn(),
}));

vi.mock("@/lib/domain/authority", () => ({
  signalWelfareReport: vi.fn(),
}));

vi.mock("@/lib/utils/format", () => ({
  parseDateInput: vi.fn(),
}));

vi.mock("@/lib/infra/storage", () => ({
  welfareAttachmentSignedUrl: vi.fn(),
}));

vi.mock("@/lib/analytics/welfare-exports", () => ({
  MPF_EXPORT_SCHEMA_VERSION: "1",
  createSignedExportUrl: vi.fn(),
  generateWelfareMpfPdf: vi.fn(),
  uploadExportToStorage: vi.fn(),
  welfareReportToMpfDto: vi.fn(),
}));

vi.mock("@/lib/infra/welfare-moderation", () => ({
  computeFlagReasons: vi.fn().mockReturnValue([]),
}));

// NOTE: @/lib/infra/welfare-uploads is intentionally NOT mocked — this suite
// exists to prove that its REAL prepareWelfareEvidence gate runs (and
// refuses) before repo.insertReportWithRetry, which is the exact bug Fix A
// closes. Only `sharp`, several levels down, is mocked (to force the strip
// to fail deterministically).

vi.mock("@/src/modules/welfare/domain/reference-code", () => ({
  generateReferenceCode: vi.fn().mockReturnValue("REF-TEST"),
}));

vi.mock("@/src/modules/welfare/application/create-welfare-report", () => ({
  createWelfareReport: vi.fn(),
}));

vi.mock("@/src/modules/welfare/application/create-org-welfare-report", () => ({
  createOrgWelfareReport: vi.fn(),
}));

vi.mock("@/src/modules/welfare/application/triage-welfare-report", () => ({
  triageWelfareReport: vi.fn(),
}));

vi.mock("@/src/modules/welfare/application/start-welfare-report", () => ({
  startWelfareReport: vi.fn(),
}));

vi.mock("@/src/modules/welfare/application/close-welfare-report", () => ({
  closeWelfareReport: vi.fn(),
}));

vi.mock("@/src/modules/welfare/application/pass-welfare-to-triage", () => ({
  passWelfareToTriage: vi.fn(),
}));

vi.mock("@/src/modules/welfare/application/confirm-welfare-as-spam", () => ({
  confirmWelfareAsSpam: vi.fn(),
}));

vi.mock("@/src/modules/welfare/application/assign-welfare", () => ({
  assignWelfare: vi.fn(),
}));

vi.mock("@/src/modules/welfare/application/unassign-welfare", () => ({
  unassignWelfare: vi.fn(),
}));

vi.mock("@/src/modules/welfare/application/generate-mpf-export", () => ({
  generateMpfExport: vi.fn(),
}));

vi.mock("@/src/modules/welfare/application/add-intervention-note", () => ({
  addInterventionNote: vi.fn(),
}));

vi.mock("@/src/modules/welfare/application/add-reporter-comment", () => ({
  addReporterComment: vi.fn(),
}));

vi.mock("@/src/modules/welfare/application/take-derived-report", () => ({
  takeDerivedReport: vi.fn(),
}));

vi.mock("@/src/modules/welfare/application/return-derived-report", () => ({
  returnDerivedReport: vi.fn(),
}));

vi.mock("@/src/modules/welfare/infrastructure/welfare-repository", () => ({
  WelfareRepository: class {
    insertReportWithRetry = mockInsertReportWithRetry;
    findReportById = vi.fn().mockResolvedValue(null);
    findReportByIdempotencyKey = vi.fn().mockResolvedValue(null);
    findPetByToken = vi.fn().mockResolvedValue(null);
    findActiveOwnership = vi.fn().mockResolvedValue(null);
  },
}));

// ---------------------------------------------------------------------------
// Imports (after all mocks)
// ---------------------------------------------------------------------------

import {
  createOrgWelfareReportAction,
  createWelfareReportAction,
} from "@/src/modules/welfare/actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corruptJpegFile(name = "evidencia.jpg"): File {
  // Content doesn't matter — sharp is mocked to always reject, so ANY
  // declared image/jpeg attachment fails the strip. What matters is the
  // DECLARED type, which routes it through stripIfRaster.
  return new File([new Uint8Array(1024)], name, { type: "image/jpeg" });
}

function citizenFormData(): FormData {
  const fd = new FormData();
  fd.set("kind", "neglect");
  fd.set("severity", "medium");
  fd.set("description", "Descripción de prueba con al menos veinte caracteres.");
  fd.set("subjectKind", "unowned_animal");
  fd.set("subjectDescription", "Perro abandonado en la calle.");
  fd.set("locationAddress", "Av. Corrientes 1234, CABA");
  fd.set("locationLat", "-34.6037");
  fd.set("locationLng", "-58.3816");
  fd.append("attachment", corruptJpegFile());
  return fd;
}

function orgFormData(): FormData {
  const fd = new FormData();
  fd.set("kind", "neglect");
  fd.set(
    "description",
    "Descripción profesional con contexto operativo suficiente para superar el mínimo de cien caracteres exigido por la validación del formulario de la organización.",
  );
  fd.set("subjectKind", "unowned_animal");
  fd.set("subjectDescription", "Perro abandonado en la vía pública.");
  fd.set("locationAddress", "Av. Corrientes 1234, CABA");
  fd.append("attachment", corruptJpegFile());
  return fd;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Fix A — a strip failure must not leave a report row behind", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToBuffer.mockRejectedValue(new Error("sharp: unsupported format"));
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
    vi.mocked(mockInsertReportWithRetry).mockResolvedValue({
      id: "should-never-be-created",
      referenceCode: "DEN-SHOULD-NOT-EXIST",
    });
  });

  it("createWelfareReportAction (citizen): refuses before insertReportWithRetry runs", async () => {
    const result = await createWelfareReportAction({ error: null }, citizenFormData());

    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/no guardamos nada/);
    expect(result.error).toMatch(/lugar donde se sacó/);
    expect(mockInsertReportWithRetry).not.toHaveBeenCalled();
  });

  it("createOrgWelfareReportAction (org): refuses before insertReportWithRetry runs", async () => {
    const result = await createOrgWelfareReportAction(
      "org-token-evidence",
      { error: null },
      orgFormData(),
    );

    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/no guardamos nada/);
    expect(result.error).toMatch(/lugar donde se sacó/);
    expect(mockInsertReportWithRetry).not.toHaveBeenCalled();
  });
});
