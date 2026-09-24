// `POST /api/v1/me/identity` — signup step 2, over a bearer token.
//
// THE ONE THING THIS FILE EXISTS TO STOP
// ---------------------------------------------------------------------------
// SOMEBODY ADDING THE PENDING-IDENTITY GATE. Every neighbouring door refuses a
// caller whose identity is provisional — `/api/v1/pets` with `identity_pending`,
// `/api/v1/me/profile` with `not_found` on BOTH halves — and each of those
// refusals is documented at length as load-bearing. The obvious "consistency"
// edit to this route is to copy one of them, and it would produce an endpoint
// that refuses the only callers it exists for: the whole point is to END that
// state. The first case below is the pin, and it asserts the CONTRAST too, so
// the reason the omission is deliberate cannot be read off as an oversight.
//
// AND THE SECOND: THE USER ID COMES FROM THE GUARD. `completeIdentityForUser`
// takes a `userId` and renames that row. A caller-supplied one would let any
// client rename any account by UUID, which is the same property
// `app/actions/profile.ts` refuses to export a bare writer for. Asserted by
// handing the route a body that carries somebody else's id and checking which
// one reaches the writer.
//
// Mocked at the use-case, not at the database: what is pinned is the handler's
// contract with it, and a live version would need a seeded account per case on a
// shared Supabase. `__tests__/complete-identity-for-user.test.ts` is the other
// half — the use-case's own rules, over a mocked driver.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  cookieDoorTouched: false,
  limiterThrows: null as null | (() => never),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  live: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/identity read the COOKIE client — bearer only");
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/identity read cookies() — bearer only");
  },
  headers: () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/identity read next/headers headers()");
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

vi.mock("@/lib/infra/live-user", () => ({
  requireLiveUser: async () => control.live,
}));

const mockComplete = vi.fn();
vi.mock("@/src/modules/auth/application/complete-identity-for-user", () => ({
  completeIdentityForUser: (...args: unknown[]) => mockComplete(...args),
}));

import { RateLimitError } from "@/lib/infra/rate-limit";

import { POST } from "@/app/api/v1/me/identity/route";

const SUBJECT = "0f3f2e4a-2222-4222-8222-abcdefabcdef";
const SOMEBODY_ELSE = "0f3f2e4a-3333-4333-8333-abcdefabcdef";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.fake.signature";
const EMAIL = "ana.perez@example.com";

/** What a native screen sends. Two fields, and there is no third. */
const VALID_BODY = { firstName: "Ana", lastName: "Pérez" };

/**
 * The caller this endpoint is FOR: the `profiles` row exists — the
 * `handle_new_user` trigger always writes one — and carries the provisional name
 * it derives from the address (`split_part(email, '@', 1)`).
 */
const LIVE_PENDING = {
  ok: true,
  user: { id: SUBJECT, email: EMAIL },
  profile: { displayName: "ana.perez", role: "owner", accountType: "personal" },
};

/** The same account after the write — the state that redirects to Mis mascotas. */
const COMPLETED_USER = {
  profilePending: false,
  id: SUBJECT,
  displayName: "Ana Pérez",
  role: "owner",
  accountType: "personal",
};

/**
 * The SAME account once its identity is complete — a caller this door has
 * nothing left to do for, and the one the rename gate refuses.
 */
const LIVE_COMPLETE = {
  ok: true,
  user: { id: SUBJECT, email: EMAIL },
  profile: { displayName: "Ana Pérez", role: "owner", accountType: "personal" },
};

function postRequest(body: unknown, authorization: string | null = `Bearer ${TOKEN}`) {
  return new Request("http://localhost:3000/api/v1/me/identity", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": "203.0.113.55",
      ...(authorization ? { authorization } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  control.cookieDoorTouched = false;
  control.limiterThrows = null;
  control.limits = [];
  control.live = LIVE_PENDING;
  mockComplete.mockReset();
  mockComplete.mockResolvedValue({ ok: true, user: COMPLETED_USER });
});

afterEach(() => {
  // Every case: this endpoint resolves its caller from the header and nothing
  // else. A cookie fallback would answer 200 to a browser tab holding a session
  // while the bearer it was handed was garbage.
  expect(control.cookieDoorTouched).toBe(false);
});

describe("POST /api/v1/me/identity — a PENDING identity is the caller, not the refusal", () => {
  it("lets a provisional account through and answers with its completed user", async () => {
    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: COMPLETED_USER });
    expect(mockComplete).toHaveBeenCalledTimes(1);
    // The audit trail is the WRITER's, and `complete-identity-for-user.test.ts`
    // is where it is pinned. Named here so a reader of this file knows the rename
    // record exists and where to find it.
  });

  it("does NOT answer identity_pending, which would send the client back to this screen", async () => {
    const res = await POST(postRequest(VALID_BODY));
    const body = (await res.json()) as Record<string, unknown>;

    // The code exists and means "go and finish registering". This IS finishing.
    expect(body.error).toBeUndefined();
    expect(res.status).not.toBe(403);
  });

  it("does NOT answer not_found the way /me/profile does for the same account", async () => {
    // `/api/v1/me/profile` 404s exactly this `live` fixture, on both halves, and
    // is right to. Pinned here as a contrast so the divergence reads as a
    // decision rather than as a gate somebody forgot to copy.
    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).not.toBe(404);
  });

  it("still runs the writer for a pending account submitting a name of any shape", async () => {
    // The rename gate below must not leak into the state this door exists to
    // leave: a PENDING caller may store whatever the schema accepts.
    const res = await POST(postRequest({ firstName: "Otra", lastName: "Persona" }));

    expect(res.status).toBe(200);
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/v1/me/identity — the rename gate (security review, 2026-09-05)", () => {
  it("refuses a RENAME on an account whose identity is already complete", async () => {
    // THE GATE, INVERTED. `/me/profile` refuses a caller whose identity is
    // PENDING; this one refuses one that is already COMPLETE and submitting a
    // different name. Left open, this was a second writer onto
    // `profiles.display_name` addressable by any bearer token — and
    // `lib/infra/audit-history-query.ts` renders the operator labels in
    // /gob/historial from that column at READ time, so a rename through here
    // retroactively relabels every past row that person appears in.
    control.live = LIVE_COMPLETE;

    const res = await POST(postRequest({ firstName: "Otra", lastName: "Persona" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "identity_already_complete" });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("answers 200 to the SAME names on a complete account, writing nothing", async () => {
    // The lost-response retry the endpoint promises, and the reason the gate is
    // not a blanket refusal: the first call landed, the answer never arrived, the
    // client re-sends the same body. Answered from the guard's own profile — no
    // write, and no audit row claiming a change that did not happen.
    control.live = LIVE_COMPLETE;

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: COMPLETED_USER });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("treats a differently-cased name as a rename, not as a retry", async () => {
    // `display_name` is stored and rendered verbatim, so "ana pérez" is a
    // different label from "Ana Pérez" everywhere it appears. On an ambiguous
    // retry the safe direction is to refuse rather than to silently relabel.
    control.live = LIVE_COMPLETE;

    const res = await POST(postRequest({ firstName: "ana", lastName: "pérez" }));

    expect(res.status).toBe(409);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("compares the JOINED name, so surrounding whitespace is still a retry", async () => {
    control.live = LIVE_COMPLETE;

    const res = await POST(postRequest({ firstName: "  Ana ", lastName: " Pérez  " }));

    expect(res.status).toBe(200);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("refuses a rename BEFORE spending the write budget, but AFTER the limiters", async () => {
    control.live = LIVE_COMPLETE;

    await POST(postRequest({ firstName: "Otra", lastName: "Persona" }));

    // The limiters still ran: a caller hammering this door with renames must not
    // get a free counter by being refused.
    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_identity_ip", identifier: "203.0.113.55" },
      { endpoint: "api_v1_me_identity_user", identifier: SUBJECT },
    ]);
  });

  it("carries the completed user, never a still-pending one", async () => {
    const body = (await (await POST(postRequest(VALID_BODY))).json()) as {
      user: { profilePending: boolean };
    };
    expect(body.user.profilePending).toBe(false);
  });

  it("refuses to serve a 200 whose user is somehow still pending", async () => {
    // The writer already forbids this, so reaching it means the projection and
    // the predicate disagree — a server bug, and not one a client should absorb
    // by flipping its gate off on a payload that says the gate still applies.
    mockComplete.mockResolvedValue({
      ok: true,
      user: { profilePending: true, id: SUBJECT },
    });

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "identity_failed" });
  });
});

describe("POST /api/v1/me/identity — the id comes from the guard", () => {
  it("writes the GUARD's user, never a userId carried in the body", async () => {
    await POST(postRequest({ ...VALID_BODY, userId: SOMEBODY_ELSE, id: SOMEBODY_ELSE }));

    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({ userId: SUBJECT, email: EMAIL }),
    );
    const [[arg]] = mockComplete.mock.calls as [[Record<string, unknown>]];
    expect(JSON.stringify(arg)).not.toContain(SOMEBODY_ELSE);
  });

  it("forwards no DNI, because the schema has no field for one", async () => {
    await POST(postRequest({ ...VALID_BODY, dni: "30123456" }));

    const [[arg]] = mockComplete.mock.calls as [[Record<string, unknown>]];
    expect(arg.dni).toBeUndefined();
    // The DNI stays on the web step (PO 2026-09-05): hashed, uniqueness-claimed,
    // and the half Mi Argentina federation will replace.
    expect(JSON.stringify(arg)).not.toContain("30123456");
  });

  it("hands the writer the TRIMMED names the shared schema produces", async () => {
    await POST(postRequest({ firstName: "  Ana  ", lastName: " Pérez " }));

    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "Ana", lastName: "Pérez" }),
    );
  });
});

describe("POST /api/v1/me/identity — the body", () => {
  it("answers 400 invalid_request for a body that is not JSON", async () => {
    const res = await POST(postRequest("{not json"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing surname", { firstName: "Ana" }],
    ["a blank name", { firstName: "   ", lastName: "Pérez" }],
    ["a name past the shared display-name bound", { firstName: "A".repeat(200), lastName: "P" }],
    ["a non-string field", { firstName: 7, lastName: "Pérez" }],
  ])("answers 400 invalid_request for %s, and writes nothing", async (_label, body) => {
    const res = await POST(postRequest(body));

    // NOT 422. The envelope is a single key (§2), so a client gets its field
    // detail by running `completeIdentityInputSchema` locally — which the screen
    // does before spending a request. Reaching this branch means the build is out
    // of step with the contract.
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/me/identity — the writer's refusals", () => {
  it("answers 422 identity_name_provisional when the name would not end the pending state", async () => {
    mockComplete.mockResolvedValue({ ok: false, error: "STILL_PROVISIONAL" });

    const res = await POST(postRequest(VALID_BODY));

    // 422 and not 400: the request is well-formed and the server understood it.
    // What it cannot do is store a value that leaves the caller in the exact
    // state the call was made to leave.
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "identity_name_provisional" });
  });

  it("answers 500 identity_failed when the write did not land", async () => {
    mockComplete.mockResolvedValue({ ok: false, error: "WRITE_FAILED" });

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "identity_failed" });
  });

  it("answers 400 when the writer and the route's own parse disagree", async () => {
    mockComplete.mockResolvedValue({ ok: false, error: "VALIDATION", field: "lastName" });

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("answers 503 with a retry-after when the write blows its budget", async () => {
    const { DbBudgetExceededError } = await import("@/lib/infra/db-budget");
    mockComplete.mockImplementation(() => {
      throw new DbBudgetExceededError("api-v1-me-identity-write", 1);
    });

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
    expect(res.headers.get("retry-after")).toBe("5");
  });
});

describe("POST /api/v1/me/identity — the guard's refusals", () => {
  it("answers 401 auth_required with no header at all — a client BUG, not an expiry", async () => {
    const res = await POST(postRequest(VALID_BODY, null));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
    // Free: a regex over one header, before any counter is written.
    expect(control.limits).toEqual([]);
  });

  it("answers 401 auth_expired for a header the bearer factory cannot use", async () => {
    const res = await POST(postRequest(VALID_BODY, "Basic abc"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_expired" });
  });

  it.each([
    ["NO_SESSION", 401, "auth_expired"],
    ["ACCOUNT_ERASED", 403, "account_erased"],
    ["DEACTIVATED", 403, "account_deactivated"],
    ["SHIFT_EXPIRED", 401, "session_shift_expired"],
    ["MAINTENANCE", 503, "temporarily_unavailable"],
  ])("maps %s to %i %s", async (reason, status, code) => {
    control.live = { ok: false, reason };

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/me/identity — the limiters", () => {
  it("spends the IP bucket before the guard and the USER bucket after it", async () => {
    await POST(postRequest(VALID_BODY));

    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_identity_ip", identifier: "203.0.113.55" },
      { endpoint: "api_v1_me_identity_user", identifier: SUBJECT },
    ]);
  });

  it("answers 429 with no retry-after when a bucket is spent", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "maxPerMinute");
    };

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    // §10: the two rate-limit branches carry no retry-after, so the response
    // never says WHICH budget ran out.
    expect(res.headers.get("retry-after")).toBeNull();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("FAILS OPEN when the limiter itself is unavailable", async () => {
    // The limiter is a DB write. Refusing here would strand a half-registered
    // account on the gate screen with no way out, over an abuse control — while
    // the authorization boundary above stays intact and fails CLOSED.
    control.limiterThrows = () => {
      throw new Error("rate_limit_buckets unavailable");
    };

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(200);
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/v1/me/identity — the envelope", () => {
  it.each([
    ["success", async () => POST(postRequest(VALID_BODY))],
    ["no auth", async () => POST(postRequest(VALID_BODY, null))],
    ["bad body", async () => POST(postRequest("{"))],
  ])("sets cache-control: no-store on %s", async (_label, run) => {
    const res = await run();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });
});
