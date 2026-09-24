// Unit test — public tag resolver page (/t/[serial]) 4-state matrix + rate limit.
//
// Mocks the lookup + rate limiter and verifies the page-level contract:
//   1. unknown serial → notFound()
//   2. active → redirect("/p/{publicToken}") (Next redirect = 307, design D7)
//   2b. active with NO destination (PO-4 — the pet was erased, so the lookup
//       returns no token) → honest neutral page, never a 307 into a 404 and
//       never the activation CTA
//   3. unactivated → neutral page with activation CTA, zero pet info
//   4. revoked → honest page, no reason, zero pet info (publicToken never
//      rendered even though the projection carries it)
//   5. rate-limited → ThrottleNotice, and the DB lookup NEVER runs

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === "x-real-ip" ? "198.51.100.7" : null),
  })),
}));

const { mockNotFound, mockRedirect } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: mockNotFound,
  redirect: mockRedirect,
}));

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

const { mockLookupTagBySerial } = vi.hoisted(() => ({
  mockLookupTagBySerial: vi.fn(),
}));

vi.mock("@/lib/infra/tag-lookup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/tag-lookup")>();
  return {
    ...actual,
    lookupTagBySerial: mockLookupTagBySerial,
  };
});

import TagResolverPage from "@/app/(public)/t/[serial]/page";

const params = (serial: string) => ({ params: Promise.resolve({ serial }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockEnforceRateLimit.mockResolvedValue(undefined);
});

describe("/t/[serial] — state matrix", () => {
  it("unknown serial → notFound()", async () => {
    mockLookupTagBySerial.mockResolvedValue(null);
    await expect(TagResolverPage(params("TAG-ZZZZ-ZZZZ"))).rejects.toThrow("NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });

  it("active → redirect to /p/[publicToken]", async () => {
    mockLookupTagBySerial.mockResolvedValue({ status: "active", publicToken: "DIM-ABCD-2345" });
    await expect(TagResolverPage(params("TAG-ABCD-2345"))).rejects.toThrow(
      "REDIRECT:/p/DIM-ABCD-2345",
    );
    expect(mockRedirect).toHaveBeenCalledWith("/p/DIM-ABCD-2345");
  });

  it("active with NO destination (erased pet, PO-4) → honest page, no redirect, no activation CTA", async () => {
    // The chapa IS activated: offering "activá esta chapa" would send its
    // owner into a flow that refuses them, and the old fall-through did
    // exactly that. The 307 it used to emit was worse — it walked a person
    // standing over an animal straight into a 404 with no explanation.
    mockLookupTagBySerial.mockResolvedValue({ status: "active", publicToken: null });
    const html = renderToStaticMarkup(await TagResolverPage(params("TAG-ABCD-2345")));

    expect(html).toContain("no tiene una credencial disponible");
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockNotFound).not.toHaveBeenCalled();
    // Not the unactivated screen: no activation copy, no activation link.
    expect(html).not.toContain("todavía no fue activada");
    expect(html).not.toContain("/cuenta/chapas/activar");
    // Zero pet info, same contract as every other non-redirect state.
    expect(html).not.toContain("DIM-");
  });

  it("normalizes the serial (lowercase/encoded input) before lookup", async () => {
    mockLookupTagBySerial.mockResolvedValue(null);
    await expect(TagResolverPage(params("tag-abcd-2345"))).rejects.toThrow("NOT_FOUND");
    expect(mockLookupTagBySerial).toHaveBeenCalledWith("TAG-ABCD-2345");
  });

  it("unactivated → neutral page with activation CTA and ZERO pet info", async () => {
    mockLookupTagBySerial.mockResolvedValue({ status: "unactivated", publicToken: null });
    const html = renderToStaticMarkup(await TagResolverPage(params("TAG-ABCD-2345")));
    expect(html).toContain("todavía no fue activada");
    expect(html).toContain("/cuenta/chapas/activar?serial=TAG-ABCD-2345");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("revoked → honest page, no reason, and the projection's publicToken is NOT rendered", async () => {
    // Even though the lookup projection carries the token for revoked rows,
    // the page must never render it (zero pet info on non-active states).
    mockLookupTagBySerial.mockResolvedValue({ status: "revoked", publicToken: "DIM-SECR-ET99" });
    const html = renderToStaticMarkup(await TagResolverPage(params("TAG-ABCD-2345")));
    expect(html).toContain("dada de baja");
    expect(html).not.toContain("DIM-SECR-ET99");
    // No reason vocabulary leaks (the enum values live in the owner's log).
    for (const reason of ["lost", "damaged", "transfer", "fraud", "robo", "fraude"]) {
      expect(html.toLowerCase()).not.toContain(reason);
    }
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

describe("/t/[serial] — rate limiting", () => {
  it("throttled IP gets the notice and the lookup NEVER runs", async () => {
    mockEnforceRateLimit.mockRejectedValue(new MockRateLimitError(new Date(), "tag_resolve"));
    const html = renderToStaticMarkup(await TagResolverPage(params("TAG-ABCD-2345")));
    expect(html).toContain("Demasiadas consultas");
    expect(mockLookupTagBySerial).not.toHaveBeenCalled();
  });

  it("keys the limiter as tag_resolve per caller IP at 100/min", async () => {
    mockLookupTagBySerial.mockResolvedValue(null);
    await expect(TagResolverPage(params("TAG-ABCD-2345"))).rejects.toThrow("NOT_FOUND");
    expect(mockEnforceRateLimit).toHaveBeenCalledWith("tag_resolve", "198.51.100.7", {
      maxPerMinute: 100,
    });
  });
});
