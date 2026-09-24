// `/api/v1/me/profile` — the person's own data over a bearer token.
//
// THE ONE THING THIS FILE EXISTS TO STOP
// ---------------------------------------------------------------------------
// A SEVENTH FIELD. `GET /api/v1/me` deliberately carries no phone, no email, no
// DNI and no jurisdiction, and calls that "the whole defence for what a stolen
// access token buys". This route carries a phone, and the argument that makes
// that acceptable is narrow: the payload returns EXACTLY the six fields the same
// URL writes back, so it discloses nothing a caller could not obtain by writing.
// That argument dies the moment somebody adds `email` "because the form could
// show it" — and nothing else in the repo would notice, because the addition
// compiles, the fence tests pass, and the screen looks better.
//
// So the first case below asserts the KEY SET, both ways: nothing missing that
// the writer takes, and nothing present that it does not.
//
// AND THE SECOND: THE USER ID COMES FROM THE GUARD. `updateProfileForUser` takes
// a `userId` and writes that row. `app/actions/profile.ts` refuses to export it
// as a server action for exactly this reason — "a bare writer taking a
// caller-supplied userId would let any client update ANY user's profile by
// UUID". This route is the second door onto the same writer, so the same
// property has to hold here, and it is asserted by handing the route a body
// carrying somebody else's id and checking which one reaches the writer.
//
// Mocked at the writer, not at the database: what is being pinned is the
// handler's contract with the use-case, and a live version would need a seeded
// account per case on a shared Supabase.

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
    throw new Error("/api/v1/me/profile read the COOKIE client — bearer only");
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/profile read cookies() — bearer only");
  },
  headers: () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/profile read next/headers headers()");
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

const mockRead = vi.fn();
vi.mock("@/src/modules/pets/application/profile/read-my-profile", () => ({
  readMyEditableProfile: (...args: unknown[]) => mockRead(...args),
}));

const mockUpdate = vi.fn();
vi.mock("@/src/modules/pets/application/profile/update-profile", () => ({
  updateProfileForUser: (...args: unknown[]) => mockUpdate(...args),
}));

import { RateLimitError } from "@/lib/infra/rate-limit";

import { GET, POST } from "@/app/api/v1/me/profile/route";

const SUBJECT = "0f3f2e4a-2222-4222-8222-abcdefabcdef";
const SOMEBODY_ELSE = "0f3f2e4a-3333-4333-8333-abcdefabcdef";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.fake.signature";

/** Every column the writer takes, as the DB holds them. */
const STORED = {
  displayName: "Lucía",
  phone: "+54 9 294 123-4567",
  preferredVetName: "Vet Bariloche",
  preferredVetPhone: null,
  emergencyContactName: null,
  emergencyContactPhone: "+54 9 11 5555-5555",
};

/** The minimum a client must send: the one required field. */
const VALID_EDIT = { displayName: "Lucía Belén" };

function getRequest(authorization: string | null = `Bearer ${TOKEN}`) {
  return new Request("http://localhost:3000/api/v1/me/profile", {
    headers: {
      "x-real-ip": "203.0.113.55",
      ...(authorization ? { authorization } : {}),
    },
  });
}

function postRequest(body: unknown, authorization: string | null = `Bearer ${TOKEN}`) {
  return new Request("http://localhost:3000/api/v1/me/profile", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": "203.0.113.55",
      ...(authorization ? { authorization } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * A caller whose identity is COMPLETE — the display name is not the local part
 * of the address, so `isIdentityPending` is false and both handlers proceed.
 *
 * It has to be spelled out now that the route reads the profile the guard
 * already resolved: `profile: {}` (what this fixture used to be) IS the pending
 * state, because a blank display name is exactly what the predicate refuses.
 */
const LIVE_COMPLETE = {
  ok: true,
  user: { id: SUBJECT, email: "lucia.belen@example.com" },
  profile: { displayName: "Lucía Belén" },
};

/**
 * The same account before signup step 2: the `profiles` row EXISTS — the
 * `handle_new_user` trigger always writes one — and carries the provisional name
 * it derives from the address (`split_part(email, '@', 1)`).
 */
const LIVE_PENDING = {
  ok: true,
  user: { id: SUBJECT, email: "lucia.belen@example.com" },
  profile: { displayName: "lucia.belen" },
};

beforeEach(() => {
  control.limiterThrows = null;
  control.limits = [];
  control.live = LIVE_COMPLETE;
  mockRead.mockReset();
  mockUpdate.mockReset();
});

afterEach(() => {
  expect(control.cookieDoorTouched).toBe(false);
});

describe("GET — the form pre-fill", () => {
  it("carries the writer's six fields and NOT ONE MORE", async () => {
    // THE ASSERTION THIS FILE IS FOR. See the header: the whole argument for
    // this route carrying a phone at all is that its field list equals the
    // writer's. `toEqual` on the key set fails in both directions — a field
    // dropped (the form silently clears it) and a field added (the argument
    // dies).
    mockRead.mockResolvedValue(STORED);

    const res = await GET(getRequest());
    const body = (await res.json()) as { profile: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(Object.keys(body.profile).sort()).toEqual([
      "displayName",
      "emergencyContactName",
      "emergencyContactPhone",
      "phone",
      "preferredVetName",
      "preferredVetPhone",
    ]);
  });

  it("flattens `null` to the empty string, once, on the way out", async () => {
    // The mutation this catches: passing the DB row through untouched. A form
    // bound to `null` renders the string "null" in React Native's TextInput on
    // some paths and blanks the field on others — and a client that mapped it
    // itself would be re-deriving the writer's clearing semantics on the far end
    // of the wire.
    mockRead.mockResolvedValue(STORED);

    const res = await GET(getRequest());
    const body = (await res.json()) as { profile: Record<string, unknown> };

    expect(body.profile.preferredVetPhone).toBe("");
    expect(body.profile.emergencyContactName).toBe("");
    expect(body.profile.phone).toBe("+54 9 294 123-4567");
  });

  it("reads the CALLER's profile, resolved by the guard", async () => {
    mockRead.mockResolvedValue(STORED);

    await GET(getRequest());

    expect(mockRead).toHaveBeenCalledWith(SUBJECT);
  });

  it("answers 404 for a half-registered account rather than an empty form", async () => {
    // Six empty strings would be an edit form whose save is guaranteed to fail —
    // the writer answers NOT_FOUND — instead of the identity flow the person
    // actually needs.
    mockRead.mockResolvedValue(null);

    const res = await GET(getRequest());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("answers 404 for a PENDING identity — the row exists and is still provisional", async () => {
    // THE STATE THE OLD CHECK MISSED. `handle_new_user` inserts a `profiles` row
    // in the same transaction that creates the account, so `readMyEditableProfile`
    // returns a real row for a brand-new signup and the `profile === null` branch
    // never fired. This route then served 200 with the trigger's email-derived
    // name pre-filled into an identity form the person never completed.
    control.live = LIVE_PENDING;
    mockRead.mockResolvedValue({ ...STORED, displayName: "lucia.belen" });

    const res = await GET(getRequest());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    // And it refuses BEFORE the read: the answer is about the account, so there
    // is nothing to fetch.
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("refuses an erased or deactivated caller before reading anything", async () => {
    control.live = { ok: false, reason: "ACCOUNT_ERASED" };
    expect((await GET(getRequest())).status).toBe(403);

    control.live = { ok: false, reason: "DEACTIVATED" };
    expect((await GET(getRequest())).status).toBe(403);

    expect(mockRead).not.toHaveBeenCalled();
  });

  it("spends the read family's two buckets — ip before the guard, user after", async () => {
    mockRead.mockResolvedValue(STORED);

    await GET(getRequest());

    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_profile_read_ip", identifier: "203.0.113.55" },
      { endpoint: "api_v1_me_profile_read_user", identifier: SUBJECT },
    ]);
  });

  it("distinguishes a missing header from an unusable one", async () => {
    expect(await (await GET(getRequest(null))).json()).toEqual({ error: "auth_required" });
    expect(await (await GET(getRequest("Token abc"))).json()).toEqual({ error: "auth_expired" });
  });

  it("refuses over the ip ceiling before the guard runs", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "maxPerMinute");
    };

    expect((await GET(getRequest())).status).toBe(429);
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe("POST — saving it", () => {
  it("writes the GUARD's user id, never one from the body", async () => {
    // The mutation this catches: `updateProfileForUser(body.userId, …)`, or any
    // shape that lets the request name whose profile is written. That is the
    // exact defect `app/actions/profile.ts` refuses to expose the bare writer
    // for, and this route is the second door onto it.
    mockUpdate.mockResolvedValue({ ok: true });

    await POST(postRequest({ ...VALID_EDIT, userId: SOMEBODY_ELSE, id: SOMEBODY_ELSE }));

    expect(mockUpdate).toHaveBeenCalledWith(SUBJECT, expect.anything());
  });

  it("passes the parsed body through, and nothing the schema stripped", async () => {
    mockUpdate.mockResolvedValue({ ok: true });

    await POST(postRequest({ ...VALID_EDIT, userId: SOMEBODY_ELSE, phone: "" }));

    expect(mockUpdate).toHaveBeenCalledWith(SUBJECT, {
      displayName: "Lucía Belén",
      phone: "",
    });
  });

  it('keeps `undefined` and `""` apart — the writer\'s three-way rule', async () => {
    // `""` CLEARS a column and an absent key LEAVES IT ALONE. The mutation this
    // catches: a schema `.default("")` on the optional fields, which would make
    // every save from a form that does not show the vet fields silently erase
    // them.
    mockUpdate.mockResolvedValue({ ok: true });

    await POST(postRequest({ displayName: "Lucía", preferredVetName: "" }));

    const [, input] = mockUpdate.mock.calls[0] as [string, Record<string, unknown>];
    expect(input.preferredVetName).toBe("");
    expect("preferredVetPhone" in input).toBe(false);
  });

  it("answers a bare `{ saved: true }` with no envelope fields", async () => {
    mockUpdate.mockResolvedValue({ ok: true });

    const res = await POST(postRequest(VALID_EDIT));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true });
  });

  it("refuses a display name under the writer's minimum, without calling it", async () => {
    const res = await POST(postRequest({ displayName: "L" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("maps the writer's NOT_FOUND to 404, not to the 500", async () => {
    mockUpdate.mockResolvedValue({ error: "NOT_FOUND" });

    const res = await POST(postRequest(VALID_EDIT));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("maps the writer's VALIDATION_ERROR to 400, not to the 500", async () => {
    // Reached only when the schema and the writer disagree. It is a fact about
    // the BODY either way, so answering 503/500 would tell a client the platform
    // is broken over a request it can fix.
    mockUpdate.mockResolvedValue({ error: "VALIDATION_ERROR: Máximo 80 caracteres" });

    const res = await POST(postRequest(VALID_EDIT));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("maps anything else to 500 `profile_failed`", async () => {
    mockUpdate.mockResolvedValue({ error: "boom" });

    const res = await POST(postRequest(VALID_EDIT));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "profile_failed" });
  });

  it("spends the WRITE family's two buckets, not the read's", async () => {
    mockUpdate.mockResolvedValue({ ok: true });

    await POST(postRequest(VALID_EDIT));

    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_profile_write_ip", identifier: "203.0.113.55" },
      { endpoint: "api_v1_me_profile_write_user", identifier: SUBJECT },
    ]);
  });

  it("refuses an erased or deactivated caller before the writer runs", async () => {
    control.live = { ok: false, reason: "ACCOUNT_ERASED" };
    expect((await POST(postRequest(VALID_EDIT))).status).toBe(403);

    control.live = { ok: false, reason: "DEACTIVATED" };
    expect((await POST(postRequest(VALID_EDIT))).status).toBe(403);

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("answers `invalid_request` to a body that is not JSON at all", async () => {
    const res = await POST(postRequest("{not json"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("refuses a PENDING identity — a save here is not signup step 2", async () => {
    // THE HOLE THIS CLOSES, and it is the write half rather than the read half.
    // `myProfileEditInputSchema` accepts `displayName`, so a provisional account
    // could POST a real-looking name, flip `isIdentityPending` to false, and be
    // treated as a completed identity everywhere — without the first name, last
    // name and DNI that `completeIdentityAction` collects. The gates that stop
    // somebody REACHING this are a native screen and a web layout; a bearer
    // token addresses the URL directly.
    control.live = LIVE_PENDING;

    const res = await POST(postRequest({ displayName: "Nombre Inventado" }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses the pending identity before the body is even read", async () => {
    // The refusal is about the CALLER, not the payload: a pending account must
    // not learn whether its JSON would have been accepted. An unparseable body
    // therefore still answers 404 here, not the 400 a complete account gets.
    control.live = LIVE_PENDING;

    const res = await POST(postRequest("{not json"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
