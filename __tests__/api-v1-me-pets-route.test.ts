// GET /api/v1/me/pets — the first AUTHENTICATED READ on `/api/v1`.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE PROJECTION. The door returns the web index's card row — eight columns
//      plus a photo join plus an ownership role. What reaches the wire is five
//      fields, and the ones that do NOT are the point: no internal id, no breed,
//      no compliance state, nothing the credential endpoint owns. A payload test
//      that only checked the fields present would certify exactly the half
//      nobody gets wrong.
//   2. TRUNCATION IS DECLARED. A list that silently stops at 200 is a lie a
//      rescue network finds in production. `truncated` must be derived from the
//      real count, not from a client knowing the cap.
//   3. A FAILED READ IS NOT AN EMPTY LIST. A person with no pets and a pooler
//      outage are different facts, and a client that renders "todavía no
//      registraste ninguna mascota" over an outage tells an owner their animals
//      are gone.
//   4. The auth mapping matches `/me` exactly, and `cache-control: no-store` is
//      on every branch.
//
// The door itself (`listOwnerPets`) is mocked: its predicate and its cap
// arithmetic are proved without Postgres in
// src/modules/pets/application/read/list-owner-pets.test.ts. What is asserted
// here is what the ROUTE does with the answer.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  limiterThrows: null as null | (() => never),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  /** When set, replaces the door's answer; it may also throw. */
  list: null as null | (() => unknown),
}));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      control.live
        ? control.live()
        : { ok: true, supabase: {}, user: { id: OWNER_ID }, profile: null },
  };
});

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

vi.mock("@/src/modules/pets/application/read/list-owner-pets", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/src/modules/pets/application/read/list-owner-pets")>();
  return {
    ...actual,
    listOwnerPets: async () => (control.list ? control.list() : { rows: [], total: 0 }),
  };
});

import { RateLimitError } from "@/lib/infra/rate-limit";
import { MY_PETS_PAYLOAD_VERSION } from "@dim/contract/api";

import { GET } from "@/app/api/v1/me/pets/route";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";

function row(overrides: Record<string, unknown> = {}) {
  return {
    pet: {
      id: PET_ID,
      name: "Pampa",
      status: "active",
      species: "dog",
      breed: "Labrador",
      sex: "female",
      pregnancyStatus: null,
      publicToken: "DIM-PAMP-0001",
      ...(overrides.pet as object | undefined),
    },
    photo: overrides.photo === undefined ? { storagePath: "abc/pampa.jpg" } : overrides.photo,
    ownershipRole: "owner",
  };
}

function req(authorization?: string | null) {
  const headers: Record<string, string> = { "x-real-ip": "203.0.113.22" };
  const value = authorization === undefined ? "Bearer test-token" : authorization;
  if (value) headers.authorization = value;
  return new Request("http://localhost:3000/api/v1/me/pets", { headers });
}

beforeEach(() => {
  control.live = null;
  control.limiterThrows = null;
  control.limits = [];
  control.list = null;
});

// ---------------------------------------------------------------------------
// Authorization — identical to /me
// ---------------------------------------------------------------------------

describe("GET /api/v1/me/pets — authorization", () => {
  it("answers auth_required when there is no Authorization header at all", async () => {
    const res = await GET(req(null));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
  });

  it("answers auth_expired for a header that is not a usable bearer", async () => {
    const res = await GET(req("Basic abc"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_expired" });
  });

  it.each([
    ["NO_SESSION", 401, "auth_expired"],
    ["ACCOUNT_ERASED", 403, "account_erased"],
    ["DEACTIVATED", 403, "account_deactivated"],
    ["MAINTENANCE", 503, "temporarily_unavailable"],
  ] as const)("maps %s to %i %s, exactly as /me does", async (reason, status, code) => {
    control.live = () => ({ ok: false, reason, supabase: null, user: null, error: "" });
    const res = await GET(req());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
  });

  it("does not read the pet list for a refused caller", async () => {
    control.live = () => ({
      ok: false,
      reason: "ACCOUNT_ERASED",
      supabase: null,
      user: null,
      error: "",
    });
    control.list = () => {
      throw new Error("the door must not be reached for a refused caller");
    };
    expect((await GET(req())).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("GET /api/v1/me/pets — rate limiting", () => {
  it("spends the per-IP bucket, then the per-USER one once the caller is known", async () => {
    await GET(req());
    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_pets_ip", identifier: "203.0.113.22" },
      { endpoint: "api_v1_me_pets_user", identifier: OWNER_ID },
    ]);
  });

  it("answers 429 when a budget is exhausted", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "test");
    };
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("FAILS OPEN when the limiter itself is broken", async () => {
    // Refusing here would empty every user's pet list over an abuse control on
    // a read that discloses only the caller's own animals.
    control.limiterThrows = () => {
      throw new Error("rate_limit_buckets is on fire");
    };
    expect((await GET(req())).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

describe("GET /api/v1/me/pets — what a native client receives", () => {
  it("carries the three envelope fields §6 requires on every read", async () => {
    const res = await GET(req());
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.payloadVersion).toBe(MY_PETS_PAYLOAD_VERSION);
    expect(typeof body.issuedAt).toBe("string");
    expect(typeof body.staleAfter).toBe("string");
    // staleAfter is AFTER issuedAt, or the field means nothing.
    expect(Date.parse(body.staleAfter as string)).toBeGreaterThan(
      Date.parse(body.issuedAt as string),
    );
  });

  it("projects a row down to exactly five fields", async () => {
    control.list = () => ({ rows: [row()], total: 1 });

    const body = (await (await GET(req())).json()) as { pets: Array<Record<string, unknown>> };

    expect(body.pets).toHaveLength(1);
    expect(Object.keys(body.pets[0]).sort()).toEqual([
      "name",
      "photoUrl",
      "publicToken",
      "species",
      "status",
    ]);
  });

  it("carries NO internal id, and none of the fields the credential endpoint owns", async () => {
    control.list = () => ({ rows: [row()], total: 1 });

    const body = JSON.stringify(await (await GET(req())).json());

    // The pet's uuid is the app's primary key. `publicToken` is the identity a
    // client navigates and shares with; the uuid buys a client nothing and costs
    // a device's disk cache a database key.
    expect(body).not.toContain(PET_ID);
    // Breed, sex and pregnancy status are ON the projected row (the web index
    // renders them) and deliberately not on the wire: a list screen does not
    // draw them, and the credential is one tap away.
    expect(body).not.toContain("Labrador");
    expect(body).not.toContain("pregnancyStatus");
    expect(body).not.toContain("ownershipRole");
  });

  it("resolves the primary photo to a URL, and null when there is none", async () => {
    control.list = () => ({
      rows: [row(), row({ photo: null, pet: { publicToken: "DIM-NOPH-0001" } })],
      total: 2,
    });

    const body = (await (await GET(req())).json()) as { pets: Array<{ photoUrl: string | null }> };

    // A URL and not a storage path: the client wants something it can put in an
    // <Image>, and should not have to know the bucket layout to build one.
    expect(body.pets[0].photoUrl).toContain("/pet-photos/abc/pampa.jpg");
    expect(body.pets[1].photoUrl).toBeNull();
  });

  it("reports an empty list honestly for a person with no pets", async () => {
    const body = (await (await GET(req())).json()) as Record<string, unknown>;
    expect(body.pets).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.truncated).toBe(false);
  });

  it("declares truncation when the cap hid rows", async () => {
    // The number a client must NOT have to know is the cap. `truncated` is
    // derived from the real count so "showing 2 of 340" is answerable without it.
    control.list = () => ({ rows: [row(), row()], total: 340 });

    const body = (await (await GET(req())).json()) as Record<string, unknown>;

    expect(body.total).toBe(340);
    expect(body.truncated).toBe(true);
  });

  it("does NOT declare truncation when everything fit", async () => {
    control.list = () => ({ rows: [row()], total: 1 });
    const body = (await (await GET(req())).json()) as Record<string, unknown>;
    expect(body.truncated).toBe(false);
  });

  it("answers 503 — never an empty list — when the read fails", async () => {
    const { DbBudgetExceededError } = await import("@/lib/infra/db-budget");
    control.list = () => {
      throw new DbBudgetExceededError("api-v1-me-pets-list", 1);
    };

    const res = await GET(req());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
    // A genuine hint, not a limiter window: "the read failed, come back shortly".
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it.each([
    ["success", async () => GET(req())],
    ["no auth", async () => GET(req(null))],
    [
      "erased",
      async () => {
        control.live = () => ({
          ok: false,
          reason: "ACCOUNT_ERASED",
          supabase: null,
          user: null,
          error: "",
        });
        return GET(req());
      },
    ],
    [
      "throttled",
      async () => {
        control.limiterThrows = () => {
          throw new RateLimitError(new Date(), "test");
        };
        return GET(req());
      },
    ],
  ])("sets cache-control: no-store on the %s branch", async (_label, run) => {
    const res = await run();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });
});
