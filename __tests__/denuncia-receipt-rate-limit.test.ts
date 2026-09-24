// Unit test — public denuncia receipt page (/denuncias/codigo/[code]) per-IP
// rate limiting (pre-national security hardening 2026-07-10).
//
// The receipt discloses the full welfare report (description, approximate
// location, masked contact, evidence signed URLs) to any holder of the
// DEN-XXXX-XXXX code, so the page must rate-limit per IP before any data fetch
// — mirroring the /p/[publicToken] credential guard. This verifies:
//   1. enforceRateLimit is called with "denuncia_receipt" + caller IP, before
//      the report DB query is issued.
//   2. When enforceRateLimit throws RateLimitError, the page returns the soft
//      throttle notice WITHOUT issuing any DB query.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: next/headers — provides the trusted edge IP
// ---------------------------------------------------------------------------

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === "x-real-ip" ? "198.51.100.9" : null),
  })),
}));

// ---------------------------------------------------------------------------
// Mock: next/navigation — notFound throws so we can assert the early path
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/link", () => ({ default: () => null }));

// ---------------------------------------------------------------------------
// Mock: @/lib/infra/rate-limit — keep real callerIp, stub enforceRateLimit
// ---------------------------------------------------------------------------

const { MockRateLimitError, mockEnforceRateLimit } = vi.hoisted(() => {
  class MockRateLimitError extends Error {
    resetAt: Date;
    reason: string;
    constructor(resetAt: Date, reason: string) {
      super(`Rate limit exceeded: ${reason}`);
      this.name = "RateLimitError";
      this.resetAt = resetAt;
      this.reason = reason;
    }
  }
  return {
    MockRateLimitError,
    mockEnforceRateLimit: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: (endpoint: string, id: string, cfg: unknown) =>
      mockEnforceRateLimit(endpoint, id, cfg),
    RateLimitError: MockRateLimitError,
  };
});

// ---------------------------------------------------------------------------
// Mock: @/db — select chain; first call returns the report row (or empty)
// ---------------------------------------------------------------------------

const mockDbSelect = vi.fn();
const mockDb = { select: mockDbSelect };

vi.mock("@/db", () => ({
  db: mockDb,
  welfareReports: {},
  welfareReportAttachments: {},
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return actual as object;
});

// ---------------------------------------------------------------------------
// Mock: heavy lib deps not under test
// ---------------------------------------------------------------------------

vi.mock("@/lib/domain/location", () => ({
  coarsenPoint: vi.fn(() => null),
  readPoint: vi.fn(() => null),
}));
vi.mock("@/lib/infra/storage", () => ({ welfareAttachmentSignedUrl: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/utils/format", () => ({
  formatDate: vi.fn(() => ""),
  formatDateTime: vi.fn(() => ""),
}));
vi.mock("@/lib/utils/mask-contact", () => ({
  maskEmail: vi.fn(() => ""),
  maskPhone: vi.fn(() => ""),
}));
vi.mock("@/src/modules/welfare/domain/types", () => ({
  welfareReportKindLabel: vi.fn(() => ""),
  welfareReportSeverityLabel: vi.fn(() => ""),
  welfareReportStatusLabel: vi.fn(() => ""),
  welfareReportSubjectKindLabel: vi.fn(() => ""),
}));
vi.mock("@/components/LocationMap", () => ({ default: () => null }));
vi.mock("@/app/(public)/denuncias/codigo/[code]/CopyCodeButton", () => ({
  CopyCodeButton: () => null,
}));
vi.mock("@/app/(public)/denuncias/codigo/[code]/DescargarComprobante", () => ({
  DescargarComprobante: () => null,
}));

// ---------------------------------------------------------------------------
// Helper — a drizzle-like select chain
// ---------------------------------------------------------------------------

function buildSelectChain(firstResult: unknown[] = []) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => firstResult),
  };
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WelfareReportByCodePage — per-IP rate limiting", () => {
  const params = Promise.resolve({ code: "DEN-ABCD-EFGH" });
  const searchParams = Promise.resolve({});

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockDbSelect.mockImplementation(() => buildSelectChain([]));
  });

  it("calls enforceRateLimit with 'denuncia_receipt' and the caller IP", async () => {
    const { default: Page } = await import("@/app/(public)/denuncias/codigo/[code]/page");

    // Report-not-found path → notFound() throws; we only assert the guard ran.
    await Page({ params, searchParams }).catch(() => {});

    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      "denuncia_receipt",
      "198.51.100.9",
      expect.objectContaining({ maxPerMinute: 30, maxPerHour: 200 }),
    );
  });

  it("returns the throttle notice (no DB query) when the limit is exceeded", async () => {
    mockEnforceRateLimit.mockRejectedValue(
      new MockRateLimitError(new Date(Date.now() + 60_000), "denuncia_receipt:198.51.100.9:minute"),
    );

    const { default: Page } = await import("@/app/(public)/denuncias/codigo/[code]/page");

    const result = await Page({ params, searchParams });

    // A React element (throttle notice) is returned without throwing.
    expect(result).toBeTruthy();
    // No report query was issued.
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});
