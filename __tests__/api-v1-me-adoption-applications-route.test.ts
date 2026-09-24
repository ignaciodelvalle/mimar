// `/api/v1/me/adoption-applications` — mis postulaciones, over a bearer token.
//
// WHAT THIS FILE EXISTS TO STOP
// ---------------------------------------------------------------------------
// D17, WHICH IS A RULE ABOUT AN ABSENCE. The web page states it — "at no point
// do we expose how many other applications exist for the same pet, who else
// applied, or any queue position" — and an absence is the easiest thing in a
// codebase to lose, because losing it looks like adding a helpful field. The
// key-set assertion below is the whole point of the file.
//
// AND THE USER ID COMING FROM THE GUARD. The reader takes a `userId` and returns
// that person's applications. A handler that read it from a query parameter
// would hand anybody else's adoption letters to anybody who could type a UUID.
//
// AND `truncated` MEANING SOMETHING. The reader caps at 100 rows, the same cap
// the web page always had. A client that renders 100 rows as "todas tus
// postulaciones" is stating something the server did not check.
//
// Mocked at the reader, not at the database: what is pinned is the handler's
// contract with it, and a live version would need a seeded applicant with a
// hundred applications on a shared Supabase.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  cookieDoorTouched: false,
  limiterThrows: null as null | (() => never),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  live: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/adoption-applications read the COOKIE client — bearer only");
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/adoption-applications read cookies() — bearer only");
  },
  headers: () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/adoption-applications read next/headers headers()");
  },
}));

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.limits.push({ endpoint, identifier });
      control.limiterThrows?.();
    },
  };
});

// STUBBED SO THIS FILE DOES NOT BUILD A REAL SUPABASE CLIENT — see the same
// mock in `api-v1-adoptions-route.test.ts` for the full derivation. Short
// version: `createClientFromBearer` reads `NEXT_PUBLIC_SUPABASE_ANON_KEY`, which
// `__tests__/setup-env.ts` does not force, so a worktree with no `.env.local`
// turned this file red with `supabaseKey is required.` — a credential-shaped
// error on a route with no RLS policy anywhere near it.
//
// `{ ok: false, reason: "MISSING" }` for a null header keeps the `auth_required`
// case below running the handler's real branch.
vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

vi.mock("@/lib/infra/live-user", () => ({
  requireLiveUser: async () => control.live,
}));

const mockRead = vi.fn();
vi.mock("@/src/modules/adoption/infrastructure/my-applications-read", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/src/modules/adoption/infrastructure/my-applications-read")
    >();
  return {
    ...actual,
    readMyAdoptionApplications: (...args: unknown[]) => mockRead(...args),
  };
});

import { DbBudgetExceededError } from "@/lib/infra/db-budget";
import { RateLimitError } from "@/lib/infra/rate-limit";
import { MY_APPLICATIONS_LIMIT } from "@/src/modules/adoption/infrastructure/my-applications-read";

import { GET } from "@/app/api/v1/me/adoption-applications/route";

const SUBJECT = "0f3f2e4a-2222-4222-8222-abcdefabcdef";
const SOMEBODY_ELSE = "0f3f2e4a-3333-4333-8333-abcdefabcdef";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.fake.signature";

function request(url = "https://x.test/api/v1/me/adoption-applications"): Request {
  return new Request(url, { headers: { authorization: `Bearer ${TOKEN}` } });
}

function row(over: Record<string, unknown> = {}) {
  return {
    applicationId: "evt-1",
    petPublicToken: "DIM-ABCD-2345",
    petName: "Lola",
    petCurrentStatus: "active",
    orgDisplayName: "Refugio Patitas",
    orgPublicToken: "ORG-1234",
    submittedAt: new Date("2026-08-02T10:00:00.000Z"),
    status: "pending" as const,
    decisionAt: null,
    stillListed: true,
    ...over,
  };
}

beforeEach(() => {
  control.cookieDoorTouched = false;
  control.limiterThrows = null;
  control.limits = [];
  control.live = { ok: true, user: { id: SUBJECT } };
  mockRead.mockReset().mockResolvedValue([]);
});

describe("GET /api/v1/me/adoption-applications", () => {
  it("reads the applications of the user the GUARD resolved, never one from the URL", async () => {
    await GET(request(`https://x.test/api/v1/me/adoption-applications?userId=${SOMEBODY_ELSE}`));
    expect(mockRead).toHaveBeenCalledExactlyOnceWith(SUBJECT);
    expect(control.cookieDoorTouched).toBe(false);
  });

  it("carries nothing about anybody else's application (D17)", async () => {
    mockRead.mockResolvedValue([row()]);
    const res = await GET(request());
    const body = await res.json();
    expect(Object.keys(body.applications[0]).sort()).toEqual([
      "applicationId",
      "decisionAt",
      "orgName",
      "orgToken",
      "petName",
      "petToken",
      "status",
      "stillListed",
      "submittedAt",
    ]);
  });

  it("keeps the seven states distinct on the wire", async () => {
    // `auto_rejected` is NOT `rejected`: the first means the animal went to
    // somebody else. Collapsing them tells a person they were turned down.
    mockRead.mockResolvedValue([
      row({ applicationId: "a", status: "auto_rejected" }),
      row({ applicationId: "b", status: "rejected" }),
      row({ applicationId: "c", status: "info_requested" }),
    ]);
    const res = await GET(request());
    const body = await res.json();
    expect(body.applications.map((a: { status: string }) => a.status)).toEqual([
      "auto_rejected",
      "rejected",
      "info_requested",
    ]);
  });

  it("says the list is complete when it is", async () => {
    mockRead.mockResolvedValue([row()]);
    const res = await GET(request());
    expect((await res.json()).truncated).toBe(false);
  });

  it("says the list was capped when the reader returned a full page", async () => {
    // The cap is the web page's own. A client that rendered 100 rows as "todas
    // tus postulaciones" would state something the server did not check.
    mockRead.mockResolvedValue(
      Array.from({ length: MY_APPLICATIONS_LIMIT }, (_, i) => row({ applicationId: `evt-${i}` })),
    );
    const res = await GET(request());
    expect((await res.json()).truncated).toBe(true);
  });

  it("refuses a caller with no bearer before it reads anything", async () => {
    const res = await GET(new Request("https://x.test/api/v1/me/adoption-applications"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("spends its OWN bucket and not the public catalogue's", async () => {
    // Sharing a counter with `api_v1_adoptions_read_ip` would let a scraper of
    // the catalogue spend the budget of somebody checking whether a shelter
    // answered them.
    await GET(request());
    expect(control.limits.map((l) => l.endpoint)).toEqual([
      "api_v1_me_adoption_applications_ip",
      "api_v1_me_adoption_applications_user",
    ]);
  });

  it("answers 429 without reading when the budget is spent", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(Date.now() + 60_000), "api_v1_me_adoption_applications_ip");
    };
    const res = await GET(request());
    expect(res.status).toBe(429);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("answers 503 and NOT an empty list when the read times out", async () => {
    // "Todavía no te postulaste" over a pooler outage tells somebody waiting on
    // a shelter's answer that they never asked.
    mockRead.mockRejectedValue(new DbBudgetExceededError("api-v1-me-adoption-applications", 8000));
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
  });

  it("refuses a deactivated account", async () => {
    control.live = { ok: false, reason: "DEACTIVATED" };
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_deactivated" });
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("refuses an erased account", async () => {
    control.live = { ok: false, reason: "ACCOUNT_ERASED" };
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(mockRead).not.toHaveBeenCalled();
  });
});
