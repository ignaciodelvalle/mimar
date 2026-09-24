// Unit test — public case-detail page (/casos/[publicCode]) per-IP rate
// limiting (NIGHT-1 security sweep). Closes review 25 finding #4 (MED, open).
//
// CaseDetailView runs getCaseDetailByPublicCode — a multi-join read (pets +
// events + case_events + opener/closer display names) BEFORE any auth/role
// resolution — so the public route must rate-limit per IP before rendering it,
// mirroring the /p/[publicToken] credential guard. This verifies:
//   1. enforceRateLimit is called with "case_detail_public" + caller IP, before
//      CaseDetailView (and its DB read) is rendered.
//   2. When enforceRateLimit throws RateLimitError, the page returns the soft
//      throttle notice WITHOUT rendering CaseDetailView.
// Only the public route is guarded; the /gob operator route is unaffected.

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
// Mock: CaseDetailView — a stub with a stable displayName so we can identify it
// as the returned React element's `type` (JSX does not invoke the component;
// React would only call it at render time, so we inspect the element instead).
// ---------------------------------------------------------------------------

function MockCaseDetailView() {
  return null;
}
vi.mock("@/components/casos/CaseDetailView", () => ({
  CaseDetailView: MockCaseDetailView,
}));

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
// Tests
// ---------------------------------------------------------------------------

describe("CaseDetailPage — per-IP rate limiting", () => {
  const params = Promise.resolve({ publicCode: "CAS-ABCD-EFGH" });

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
  });

  it("calls enforceRateLimit with 'case_detail_public' and the caller IP", async () => {
    const { default: Page } = await import("@/app/(public)/casos/[publicCode]/page");

    await Page({ params });

    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      "case_detail_public",
      "198.51.100.9",
      expect.objectContaining({ maxPerMinute: 30, maxPerHour: 200 }),
    );
  });

  it("returns CaseDetailView (with the publicCode) when the limit is not exceeded", async () => {
    const { default: Page } = await import("@/app/(public)/casos/[publicCode]/page");

    const result = (await Page({ params })) as {
      type: unknown;
      props: { publicCode?: string };
    };

    expect(result.type).toBe(MockCaseDetailView);
    expect(result.props.publicCode).toBe("CAS-ABCD-EFGH");
  });

  it("returns the throttle notice (not CaseDetailView) when the limit is exceeded", async () => {
    mockEnforceRateLimit.mockRejectedValue(
      new MockRateLimitError(
        new Date(Date.now() + 60_000),
        "case_detail_public:198.51.100.9:minute",
      ),
    );

    const { default: Page } = await import("@/app/(public)/casos/[publicCode]/page");

    const result = (await Page({ params })) as { type: unknown; props: { publicCode?: string } };

    // A React element (throttle notice) is returned without throwing, and it is
    // NOT CaseDetailView — so the multi-join read is never reached.
    expect(result).toBeTruthy();
    expect(result.type).not.toBe(MockCaseDetailView);
    expect(result.props.publicCode).toBeUndefined();
  });
});
