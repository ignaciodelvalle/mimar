// `/api/v1/me/privacy` — the two Ley 25.326 rights over a bearer token.
//
// WHY THIS FILE IS MOCKED WHERE `api-v1-me-route.test.ts` IS LIVE
// ---------------------------------------------------------------------------
// That file runs against real GoTrue with real tokens, and it should: what it
// proves is that a bearer request resolves at all, which a mocked `getUser`
// cannot show. This one cannot take the same shape, and the reason is the
// subject rather than the technique: the POST here ERASES AN ACCOUNT. An
// end-to-end version would soft-delete profiles, delete `auth.users` rows and
// sweep Storage in the shared local Supabase every time anybody ran the suite —
// on a database the whole team's gates read.
//
// So the guard's own resolution is left to the file that already proves it, and
// what is pinned here is the half that is this route's alone and that nothing
// else can catch: THE MAPPING. Six refusals, four statuses, and one code per
// arm. A destructive endpoint that answers 503 to a throttle tells a person the
// platform is broken when it is working exactly as designed; one that answers
// 429 to a broken RPC tells them to wait for something that will never start
// working. Neither is visible from either side of the boundary — only here.
//
// THE THREE THINGS IT REFUSES TO LET SLIDE
// ---------------------------------------------------------------------------
//   1. NO COOKIE FALLBACK. Both cookie doors throw, loudly, for the whole file.
//   2. NO `signOut()` ON THE BEARER CLIENT. `revoke-sessions.ts` measured that
//      it revokes nothing and reports success on a `persistSession: false`
//      client; a line that looks like session teardown and is not one is worse
//      than no line. The fake client's `signOut` is a spy that must stay unused.
//   3. THE REASON GETS ITS OWN 400. `invalid_request` on a short motivo would
//      point a person at "your request was malformed" when they can fix exactly
//      one field.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  /** Set by either cookie door. Must stay false for the whole file. */
  cookieDoorTouched: false,
  /** When set, the limiter throws it. */
  limiterThrows: null as null | (() => never),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  /** What `requireLiveUser` answers. */
  live: { ok: true, user: { id: "" }, profile: null } as unknown,
  /** The spy that must never fire — see the header. */
  signOut: null as null | ReturnType<typeof vi.fn>,
  /** The client handed to whichever use-case ran. */
  clientSeenByUseCase: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/privacy read the COOKIE client — bearer only");
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/privacy read cookies() — bearer only");
  },
  headers: () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/privacy read next/headers headers() — read the REQUEST's own");
  },
}));

// The REAL parse (so MISSING vs MALFORMED stays this route's own behaviour),
// with a fake client whose `auth.signOut` is the spy assertion 2 needs.
vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null | undefined) => {
      const parsed = actual.parseBearerToken(header);
      if (!parsed.ok) return parsed;
      control.signOut = vi.fn();
      return {
        ok: true,
        token: parsed.token,
        supabase: { auth: { signOut: control.signOut } },
      };
    },
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

vi.mock("@/lib/infra/live-user", () => ({
  requireLiveUser: async () => control.live,
}));

const mockExport = vi.fn();
vi.mock("@/src/modules/auth/application/subject-rights/export-subject-data", () => ({
  exportSubjectDataFor: (input: { supabase: unknown }) => {
    control.clientSeenByUseCase = input.supabase;
    return mockExport(input);
  },
}));

const mockErase = vi.fn();
vi.mock("@/src/modules/auth/application/subject-rights/erase-subject-data", () => ({
  eraseSubjectDataFor: (input: { supabase: unknown }) => {
    control.clientSeenByUseCase = input.supabase;
    return mockErase(input);
  },
}));

import { RateLimitError } from "@/lib/infra/rate-limit";

import { GET, POST } from "@/app/api/v1/me/privacy/route";

const SUBJECT = "0f3f2e4a-1111-4111-8111-abcdefabcdef";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.fake.signature";

function getRequest(authorization?: string | null) {
  return new Request("http://localhost:3000/api/v1/me/privacy", {
    headers: {
      "x-real-ip": "203.0.113.44",
      ...(authorization ? { authorization } : {}),
    },
  });
}

function postRequest(body: unknown, authorization: string | null = `Bearer ${TOKEN}`) {
  return new Request("http://localhost:3000/api/v1/me/privacy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": "203.0.113.44",
      ...(authorization ? { authorization } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  control.limiterThrows = null;
  control.limits = [];
  control.live = { ok: true, user: { id: SUBJECT }, profile: null };
  control.signOut = null;
  control.clientSeenByUseCase = null;
  mockExport.mockReset();
  mockErase.mockReset();
});

afterEach(() => {
  // Runs after EVERY case, so no case can quietly open a cookie door.
  expect(control.cookieDoorTouched).toBe(false);
});

describe("GET — derecho de acceso (art. 14)", () => {
  it("hands back the RPC's file under an envelope that is already stale", async () => {
    // `staleAfter === issuedAt` is the whole caching policy for a PII dump, and
    // it is expressed as a VALUE (MY_PRIVACY_STALE_AFTER_MS = 0) rather than as
    // a new rule, so every client's existing freshness check answers "re-fetch"
    // the first time it asks. The mutation this catches: giving this payload a
    // shelf life like its siblings have.
    mockExport.mockResolvedValue({ ok: true, data: { schema_version: 5, profile: {} } });

    const res = await GET(getRequest(`Bearer ${TOKEN}`));
    const body = (await res.json()) as {
      issuedAt: string;
      staleAfter: string;
      subject: Record<string, unknown>;
    };

    expect(res.status).toBe(200);
    expect(body.subject).toEqual({ schema_version: 5, profile: {} });
    expect(body.staleAfter).toBe(body.issuedAt);
  });

  it("passes the BEARER client to the use-case, never a cookie one", async () => {
    mockExport.mockResolvedValue({ ok: true, data: {} });

    await GET(getRequest(`Bearer ${TOKEN}`));

    expect(mockExport).toHaveBeenCalledWith(
      expect.objectContaining({ userId: SUBJECT, supabase: expect.anything() }),
    );
    // The IDENTITY of the client, not a shape that looks like it: the object the
    // use-case received must be the one `createClientFromBearer` built for THIS
    // request, which the spy pins by reference.
    expect((control.clientSeenByUseCase as { auth: { signOut: unknown } }).auth.signOut).toBe(
      control.signOut,
    );
  });

  it("answers 429 — not 503 — when the per-user export budget is spent", async () => {
    // The mutation this catches: folding `rate_limited` into the 500/503 arm. A
    // throttle is not an outage, and this is the endpoint where the difference
    // decides whether a person waits or files a complaint.
    mockExport.mockResolvedValue({ ok: false, reason: "rate_limited", error: "esperá" });

    const res = await GET(getRequest(`Bearer ${TOKEN}`));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("answers 500 `export_failed` when the RPC refused", async () => {
    mockExport.mockResolvedValue({ ok: false, reason: "failed", error: "no autorizado" });

    const res = await GET(getRequest(`Bearer ${TOKEN}`));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "export_failed" });
  });

  it("never reaches the export when the account is erased", async () => {
    control.live = { ok: false, reason: "ACCOUNT_ERASED" };

    const res = await GET(getRequest(`Bearer ${TOKEN}`));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_erased" });
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("refuses a DEACTIVATED account rather than minting its file", async () => {
    // The read half of the liveness rule is a DECISION on this route and not the
    // repo's default ("reads stay open so the user can see why"). This read does
    // not show somebody their situation; it hands them a copy of their PII.
    control.live = { ok: false, reason: "DEACTIVATED" };

    const res = await GET(getRequest(`Bearer ${TOKEN}`));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_deactivated" });
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("distinguishes a missing header from an unusable one", async () => {
    expect((await GET(getRequest(null))).status).toBe(401);
    expect(await (await GET(getRequest(null))).json()).toEqual({ error: "auth_required" });
    expect(await (await GET(getRequest("Token abc"))).json()).toEqual({ error: "auth_expired" });
  });

  it("spends the READ ip bucket, keyed on the request's own IP", async () => {
    mockExport.mockResolvedValue({ ok: true, data: {} });

    await GET(getRequest(`Bearer ${TOKEN}`));

    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_privacy_read_ip", identifier: "203.0.113.44" },
    ]);
  });

  it("refuses over the ip ceiling before the guard runs", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "maxPerMinute");
    };

    const res = await GET(getRequest(`Bearer ${TOKEN}`));

    expect(res.status).toBe(429);
    expect(mockExport).not.toHaveBeenCalled();
  });
});

describe("POST — derecho de supresión (art. 16)", () => {
  it("erases and answers a bare `{ erased: true }`", async () => {
    mockErase.mockResolvedValue({ ok: true });

    const res = await POST(postRequest({ command: "erase_account", reason: "ya no uso miMAR" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ erased: true });
    expect(mockErase).toHaveBeenCalledWith(
      expect.objectContaining({ userId: SUBJECT, reason: "ya no uso miMAR" }),
    );
  });

  it("does NOT call signOut() on the bearer client", async () => {
    // The mutation this catches: adding `await client.supabase.auth.signOut()`
    // before the 200, which reads like session teardown and revokes nothing —
    // auth-js loads the session from STORAGE and this client never stored one.
    // The real teardown is `auth.users` being deleted inside the erasure.
    mockErase.mockResolvedValue({ ok: true });

    await POST(postRequest({ command: "erase_account", reason: "ya no uso miMAR" }));

    expect(control.signOut).not.toBeNull();
    expect(control.signOut).not.toHaveBeenCalled();
  });

  it("gives a short motivo its OWN 400 and never reaches the use-case", async () => {
    // The mutation this catches: collapsing it into `invalid_request`. That code
    // says "your client sent nonsense" to a person who can fix one field.
    const res = await POST(postRequest({ command: "erase_account", reason: "no" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "erasure_reason_required" });
    expect(mockErase).not.toHaveBeenCalled();
  });

  it("refuses a motivo over the contract's ceiling with the same code", async () => {
    const res = await POST(postRequest({ command: "erase_account", reason: "x".repeat(501) }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "erasure_reason_required" });
  });

  it("keeps `invalid_request` for a body with no command in it", async () => {
    // The other half of the split above: a client that sent no verb has a BUG,
    // and there is no field for a person to fix.
    const res = await POST(postRequest({ reason: "ya no uso miMAR" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(mockErase).not.toHaveBeenCalled();
  });

  it("answers `invalid_request` to a body that is not JSON at all", async () => {
    const res = await POST(postRequest("{not json"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("passes the TRIMMED motivo through, so the audit row has no padding", async () => {
    mockErase.mockResolvedValue({ ok: true });

    await POST(postRequest({ command: "erase_account", reason: "   me mudo de app   " }));

    expect(mockErase).toHaveBeenCalledWith(expect.objectContaining({ reason: "me mudo de app" }));
  });

  it("answers 429 — not 503 — when the per-user erasure budget is spent", async () => {
    mockErase.mockResolvedValue({ ok: false, reason: "rate_limited", error: "esperá" });

    const res = await POST(postRequest({ command: "erase_account", reason: "ya no uso miMAR" }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("answers 500 `erasure_failed` when the RPC refused", async () => {
    mockErase.mockResolvedValue({ ok: false, reason: "failed", error: "no autorizado" });

    const res = await POST(postRequest({ command: "erase_account", reason: "ya no uso miMAR" }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "erasure_failed" });
  });

  it("maps the use-case's own reason guard back to the 400, not to the 500", async () => {
    // Unreachable through this route (the schema refuses first) and mapped
    // anyway: the day the two guards disagree, the endpoint must not start
    // reporting a validation refusal as "the platform is broken".
    mockErase.mockResolvedValue({ ok: false, reason: "reason_required", error: "corto" });

    const res = await POST(postRequest({ command: "erase_account", reason: "ya no uso miMAR" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "erasure_reason_required" });
  });

  it("spends the ACCOUNT-SECURITY ip bucket, not the write family's", async () => {
    mockErase.mockResolvedValue({ ok: true });

    await POST(postRequest({ command: "erase_account", reason: "ya no uso miMAR" }));

    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_privacy_write_ip", identifier: "203.0.113.44" },
    ]);
  });

  it("refuses an ERASED caller before the use-case runs", async () => {
    control.live = { ok: false, reason: "ACCOUNT_ERASED" };

    const erased = await POST(postRequest({ command: "erase_account", reason: "de nuevo no" }));

    expect(erased.status).toBe(403);
    expect(mockErase).not.toHaveBeenCalled();
  });

  it("ERASES for a DEACTIVATED caller — art. 16 outranks a deactivation", async () => {
    // PO decision, 2026-08-31. The organisation closed the account; the right to
    // be erased is the PERSON'S. Refusing here would let an employer stand
    // between a data subject and Ley 25.326 art. 16 by flipping one column, and
    // the web has always granted it (`requireUserOrRedirect`: DEACTIVATED
    // PASSES), so the phone refusing it was an unargued divergence.
    //
    // The mutation this catches is the one that was live until today: routing
    // this reason to `liveUserRefusal` with the read half. It is not enough to
    // assert the 200 — a handler that answered 200 and erased NOBODY would pass
    // that. The subject id is what proves the erasure was actually reached.
    mockErase.mockResolvedValue({ ok: true });
    control.live = { ok: false, reason: "DEACTIVATED", user: { id: SUBJECT } };

    const res = await POST(postRequest({ command: "erase_account", reason: "cierro mi cuenta" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ erased: true });
    expect(mockErase).toHaveBeenCalledWith(
      expect.objectContaining({ userId: SUBJECT, reason: "cierro mi cuenta" }),
    );
  });

  it("still refuses a DEACTIVATED caller it cannot identify", async () => {
    // The null check at the call site is NOT decorative. `requireLiveUser`
    // carries the id on this branch by construction today; this is the case that
    // goes red if that ever stops being true, instead of the route erasing on an
    // id it does not have.
    control.live = { ok: false, reason: "DEACTIVATED", user: null };

    const res = await POST(postRequest({ command: "erase_account", reason: "cierro mi cuenta" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_deactivated" });
    expect(mockErase).not.toHaveBeenCalled();
  });

  it("diverges from the export ON PURPOSE — same account, both doors", async () => {
    // The asymmetry IS the decision, so it is pinned in one case rather than
    // inferred from two describes. Read refused, write granted, one caller.
    // A future change that makes them symmetric again has to delete this.
    mockErase.mockResolvedValue({ ok: true });
    control.live = { ok: false, reason: "DEACTIVATED", user: { id: SUBJECT } };

    const read = await GET(getRequest(`Bearer ${TOKEN}`));
    const write = await POST(postRequest({ command: "erase_account", reason: "cierro mi cuenta" }));

    expect(read.status).toBe(403);
    expect(await read.json()).toEqual({ error: "account_deactivated" });
    expect(mockExport).not.toHaveBeenCalled();

    expect(write.status).toBe(200);
    expect(mockErase).toHaveBeenCalledTimes(1);
  });
});
