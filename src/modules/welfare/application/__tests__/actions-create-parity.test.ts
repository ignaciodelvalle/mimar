// Parity tests for createWelfareReportAction + createOrgWelfareReportAction.
//
// Spec R1: anon rate-limit (welfare_anon bucket, 1/min + 3/hr) triggered for anon.
//          authenticated path SKIPS rate-limit entirely.
// Spec R2: org-create requires requireUserOrRedirect + org membership + verified + role gate
//          scoped to THIS org's publicToken (not any org — foster cross-org bypass lesson).
//          wrong-org / under-verified / wrong-role → rejected.
//
// These tests work at the action boundary. They mock auth-guards, rate-limit,
// supabase, and next/headers so they run without a server context.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mocks before any imports
// ---------------------------------------------------------------------------

vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: vi.fn(),
  requireAdminOrGovtOrRedirect: vi.fn(),
  requireAdminOrRedirect: vi.fn(),
}));

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: vi.fn(),
    RateLimitError: class RateLimitError extends Error {
      constructor(message = "Rate limit exceeded") {
        super(message);
        this.name = "RateLimitError";
      }
    },
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
  createClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
    },
    storage: {
      from: vi.fn().mockReturnValue({ remove: vi.fn().mockResolvedValue({}) }),
    },
  }),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Map([["x-forwarded-for", "1.2.3.4"]])),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import * as authGuards from "@/lib/infra/auth-guards";
import * as rateLimit from "@/lib/infra/rate-limit";

// ---------------------------------------------------------------------------
// Tests — createWelfareReportAction rate-limit (anon path)
// ---------------------------------------------------------------------------

describe("createWelfareReportAction — anon rate-limit gate", () => {
  // The dynamic import("../../actions") transitively pulls a large module graph;
  // under the full suite's load the default 5s timeout can be exceeded on first
  // compile (the test passes in isolation). Bump it — assertions are unchanged.
  vi.setConfig({ testTimeout: 20_000 });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("anon: RateLimitError → returns Spanish throttle message, NO insert", async () => {
    // User is null (anon)
    const { createClient } = await import("@/lib/supabase/server");
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
      },
      storage: { from: vi.fn() },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    // enforceRateLimit throws RateLimitError
    vi.mocked(rateLimit.enforceRateLimit).mockRejectedValue(
      new rateLimit.RateLimitError(new Date(Date.now() + 60000), "welfare_anon"),
    );

    const { createWelfareReportAction } = await import("../../actions");
    const fd = new FormData();
    fd.set("kind", "neglect");
    fd.set("severity", "medium");
    fd.set("description", "El animal parece estar desnutrido.");
    fd.set("subjectKind", "unowned_animal");
    fd.set("subjectDescription", "Perro callejero");

    const result = await createWelfareReportAction({ error: null }, fd);

    expect(result.error).toMatch(/demasiadas denuncias/i);
    expect(rateLimit.enforceRateLimit).toHaveBeenCalledWith(
      "welfare_anon",
      expect.any(String),
      expect.objectContaining({ maxPerMinute: 1, maxPerHour: 3 }),
    );
  });

  it("authenticated user: enforceRateLimit called with the per-user soft cap", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "user-123" } },
        }),
      },
      storage: { from: vi.fn() },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const { createWelfareReportAction } = await import("../../actions");
    const fd = new FormData();
    // Provide just enough to pass validation and fail gracefully elsewhere
    fd.set("kind", "INVALID_KIND_TO_FAIL_FAST");

    await createWelfareReportAction({ error: null }, fd);

    // Authenticated submissions now get a soft per-user rate limit (Track A
    // hardening — previously an unbounded bypass). It must use the per-user
    // key (user id), NOT the anonymous IP key.
    expect(rateLimit.enforceRateLimit).toHaveBeenCalledWith(
      "welfare_auth",
      "user-123",
      expect.objectContaining({ maxPerHour: 10 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — createOrgWelfareReportAction auth-scope rejection
// ---------------------------------------------------------------------------

describe("createOrgWelfareReportAction — auth-scope rejection (foster cross-org bypass lesson)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("unauthenticated caller: requireUserOrRedirect redirects", async () => {
    const redirectErr = new Error("NEXT_REDIRECT");
    vi.mocked(authGuards.requireUserOrRedirect).mockRejectedValue(redirectErr);

    const { createOrgWelfareReportAction } = await import("../../actions");
    const fd = new FormData();

    await expect(
      createOrgWelfareReportAction("some-org-token", { error: null }, fd),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(authGuards.requireUserOrRedirect).toHaveBeenCalled();
  });
});
