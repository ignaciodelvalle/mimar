// POST /api/v1/auth/password-reset — the adapter that lets a locked-out phone
// ask for a way back in (WU-R-1).
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE ENVELOPE. 202 on success, the single-key `{ error }` body on every
//      refusal, and `cache-control: no-store` on ALL of them. §4: no-store is NOT
//      inherited — middleware stamps it from a path-prefix allowlist `/api/…` is
//      not on — so a test that checked only the happy path would certify exactly
//      the branch nobody forgets.
//   2. NON-ENUMERATION AS EQUALITY. An address with an account and one without
//      must produce the same status, the same body AND the same headers. Asserted
//      as ONE equality over a fingerprint rather than as two "looks generic
//      enough" checks — the failure this guards against is a later edit adding an
//      honest-looking field, and a shape assertion would not see it.
//   3. THE SHARED BUDGET. The buckets and keys this route spends are the web
//      form's, keyed the same way. If they ever diverge, an attacker gets a fresh
//      recovery budget by switching transport and nothing else in the suite would
//      notice.
//   4. THE CEILING'S DERIVATION, as a relationship rather than as two numbers.
//      Pinning `12` and `60` would pass forever while somebody raised the
//      per-email anchor and left the per-IP ceiling where it was — which puts the
//      IP bucket back in front of the email one and inverts the whole derivation.
//
// HOW THE MOCKING WORKS — the sibling file's arrangement, for the sibling's
// reasons. GoTrue is replaced (there is no mail server here and the point is the
// mapping); the limiter is a no-op by default and the cases that are ABOUT the
// limiter drive it explicitly. Everything else — the real schema, the real
// use-case, the real key derivation — is real.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  /** Every collaborator the route reached, in order. */
  calls: [] as string[],
  /** The arguments `resetPasswordForEmail` was called with, in order. */
  mails: [] as Array<{ email: string; redirectTo: string | undefined }>,
  /** GoTrue's answer for the next call — which the use-case must ignore. */
  answer: { data: {}, error: null } as Record<string, unknown>,
  /** Buckets + keys handed to the limiter, in order. */
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  /** When set, the limiter throws it. */
  limiterThrows: null as null | (() => never),
}));

vi.mock("@/lib/supabase/anon", () => ({
  createAnonClient: () => {
    control.calls.push("anon-client");
    return {
      auth: {
        resetPasswordForEmail: async (email: string, options?: { redirectTo?: string }) => {
          control.calls.push("resetPasswordForEmail");
          control.mails.push({ email, redirectTo: options?.redirectTo });
          return control.answer;
        },
      },
    };
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

import { RateLimitError, emailRateLimitKey } from "@/lib/infra/rate-limit";
import {
  PASSWORD_RESET_EMAIL_LIMIT,
  PASSWORD_RESET_IP_LIMIT,
  PASSWORD_RESET_REQUESTS_PER_CALLER_PER_MINUTE,
  PASSWORD_RESET_SIMULTANEOUS_CALLERS,
} from "@/src/modules/auth/application/password-reset/limits";

import { POST as passwordResetRoute } from "@/app/api/v1/auth/password-reset/route";

const IP = "203.0.113.7";

function post(body: unknown, init?: { raw?: string }) {
  return new Request("http://localhost:3000/api/v1/auth/password-reset", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": IP },
    body: init?.raw ?? JSON.stringify(body),
  });
}

/** Status + body + the headers a client can observe, as one comparable value. */
async function fingerprint(res: Response) {
  return {
    status: res.status,
    body: await res.json(),
    cacheControl: res.headers.get("cache-control"),
    contentType: res.headers.get("content-type"),
    retryAfter: res.headers.get("retry-after"),
  };
}

beforeEach(() => {
  control.calls = [];
  control.mails = [];
  control.answer = { data: {}, error: null };
  control.limits = [];
  control.limiterThrows = null;
});

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/password-reset — the envelope", () => {
  it("answers 202 with the constant payload on success", async () => {
    const res = await passwordResetRoute(post({ email: "ana@mimar.ar" }));

    // 202 and not 200: what happened is that the request was ACCEPTED. Whether a
    // token was minted or a mail handed to a provider is information this
    // endpoint declines to have.
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ requested: true });
  });

  it("sets cache-control: no-store on a REFUSAL as well as a success", async () => {
    const success = await passwordResetRoute(post({ email: "ana@mimar.ar" }));
    expect(success.headers.get("cache-control")).toBe("no-store");
    expect(success.headers.get("content-type")).toBe("application/json; charset=utf-8");

    const refusal = await passwordResetRoute(post({}));
    expect(refusal.headers.get("cache-control")).toBe("no-store");
  });

  it("answers invalid_request for a body that is not JSON at all", async () => {
    const res = await passwordResetRoute(post(null, { raw: "not json{" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    // A malformed body costs the platform no counter and reveals nothing — and
    // it is the one 400 a correct client cannot provoke.
    expect(control.limits).toEqual([]);
    expect(control.calls).toEqual([]);
  });

  it("answers invalid_request when the email is missing or blank", async () => {
    for (const body of [{}, { email: "" }, { email: "   " }]) {
      const res = await passwordResetRoute(post(body));
      expect(res.status).toBe(400);
      // Single-key envelope (§2): no field detail. The client validated with the
      // same schema before sending and already has the code locally.
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    // None of the three reached GoTrue, and none spent a counter.
    expect(control.calls).toEqual([]);
    expect(control.limits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Non-enumeration
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/password-reset — the response is not an oracle", () => {
  it("answers an address WITH an account and one WITHOUT it identically", async () => {
    // GoTrue answers differently for the two — it is allowed to. The use-case
    // never binds that answer to a name, so the two must be indistinguishable
    // all the way out to the wire: same status, same bytes, same headers.
    control.answer = { data: {}, error: null };
    const known = await fingerprint(await passwordResetRoute(post({ email: "ana@mimar.ar" })));

    control.answer = { data: {}, error: { message: "User not found" } };
    const unknown = await fingerprint(await passwordResetRoute(post({ email: "nadie@mimar.ar" })));

    expect(known).toEqual(unknown);
    expect(known.status).toBe(202);
    expect(known.body).toEqual({ requested: true });
  });

  it("never leaks the submitted email back in the body", async () => {
    // The web action echoes nothing either. A body that repeated the address
    // would make a 202 quotable as proof somebody asked to reset that account.
    const res = await passwordResetRoute(post({ email: "secreto@example.com" }));
    expect(JSON.stringify(await res.json())).not.toContain("secreto@example.com");
  });

  it("carries NO retry-after on the 429 — only one branch could be honest", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "auth_password_reset_ip");
    };
    const res = await passwordResetRoute(post({ email: "ana@mimar.ar" }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    // A header on the per-IP branch and not the per-email one would make the two
    // 429s distinguishable, and the per-email one is the branch that could
    // otherwise answer "this account is being hammered" (api-invariants.md §10).
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("answers the two rate-limit branches identically", async () => {
    // The per-EMAIL bucket running out is the one that would otherwise be a
    // statement about an account existing. Asserted as an equality for the same
    // reason the enumeration check above is.
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "auth_password_reset_ip");
    };
    const perIp = await fingerprint(await passwordResetRoute(post({ email: "ana@mimar.ar" })));

    control.limits = [];
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "auth_password_reset_email");
    };
    const perEmail = await fingerprint(await passwordResetRoute(post({ email: "ana@mimar.ar" })));

    expect(perIp).toEqual(perEmail);
  });

  it("sends NO mail once a budget is spent — fail closed", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "auth_password_reset_ip");
    };
    await passwordResetRoute(post({ email: "ana@mimar.ar" }));
    // Not even the client was built: the budgets run before `deps.auth()`.
    expect(control.calls).toEqual([]);
    expect(control.mails).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The shared budget
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/password-reset — the budget is the web form's", () => {
  it("spends auth_password_reset_ip then auth_password_reset_email, keyed on IP and the HASHED email", async () => {
    await passwordResetRoute(post({ email: "  ANA@Mimar.ar " }));

    // Identical buckets and identical keys to `/recuperar`'s. This is what stops
    // somebody getting a fresh recovery budget by switching transport, and it is
    // the only place in the suite where that equivalence is checked from the API
    // side.
    expect(control.limits).toEqual([
      { endpoint: "auth_password_reset_ip", identifier: IP },
      { endpoint: "auth_password_reset_email", identifier: emailRateLimitKey("ana@mimar.ar") },
    ]);
    // The raw address never becomes a bucket key: rate_limit_buckets is readable
    // by every worker and an email is PII (Ley 25.326).
    expect(control.limits[1]?.identifier).not.toContain("ana@mimar.ar");
  });

  it("keys the per-IP budget on the trusted edge IP, not a spoofable one", async () => {
    const req = new Request("http://localhost:3000/api/v1/auth/password-reset", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The FIRST x-forwarded-for segment is client-controlled. callerIp takes
        // the LAST hop, and x-real-ip outranks both.
        "x-forwarded-for": "1.2.3.4, 198.51.100.9",
      },
      body: JSON.stringify({ email: "ana@mimar.ar" }),
    });
    await passwordResetRoute(req);
    expect(control.limits[0]).toEqual({
      endpoint: "auth_password_reset_ip",
      identifier: "198.51.100.9",
    });
  });

  it("mails the WEB's recovery callback and never a mimar:// scheme", async () => {
    await passwordResetRoute(post({ email: "ana@mimar.ar" }));

    const sent = control.mails[0];
    expect(sent?.email).toBe("ana@mimar.ar");
    expect(sent?.redirectTo).toContain("/recuperar/actualizar");
    // THE ASSERTION THAT MATTERS. A `mimar://` redirect would mail a recovery
    // credential to an UNVERIFIED custom scheme any installed app may claim,
    // which is strictly worse than the browser it would be trying to avoid. The
    // native client redeems the six-digit code instead and never reads this url.
    expect(sent?.redirectTo).not.toContain("mimar://");
  });
});

// ---------------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------------

describe("password-reset ceilings — the relationship, not the numbers", () => {
  it("keeps the per-IP hourly ceiling at N mailboxes at their full rate", async () => {
    // The load-bearing relationship: the per-EMAIL bucket is the one that bounds
    // a PERSON and the one carrier NAT cannot dilute, so the per-IP ceiling's job
    // is to stay far enough above it that the EMAIL bucket is the binding
    // constraint. Raising the anchor without raising the ceiling would invert
    // that silently — the IP bucket would start refusing the legitimate caller,
    // on the one endpoint whose failure mode is "you cannot get back in".
    expect(PASSWORD_RESET_IP_LIMIT.maxPerHour).toBe(
      (PASSWORD_RESET_EMAIL_LIMIT.maxPerHour ?? 0) * PASSWORD_RESET_SIMULTANEOUS_CALLERS,
    );
  });

  it("keeps the per-IP per-minute ceiling at N callers asking ONCE each", async () => {
    // PINNED SEPARATELY, and with its own anchor spelled out, because the two
    // windows do NOT multiply the same number — the same shape `api-v1-limits.ts`
    // got wrong in prose for the write family and had to correct. A reader who
    // sees 12 and 60 and assumes one factor would "tidy" this to 60/min.
    expect(PASSWORD_RESET_IP_LIMIT.maxPerMinute).toBe(
      PASSWORD_RESET_SIMULTANEOUS_CALLERS * PASSWORD_RESET_REQUESTS_PER_CALLER_PER_MINUTE,
    );
  });

  it("leaves the per-email bucket without a per-minute window, on purpose", async () => {
    // GoTrue's own `max_frequency` bounds two mails to one address inside a
    // minute (supabase/config.toml). A second counter here would be a weaker copy
    // of a rule that is not ours, and this assertion is what stops one being
    // added without the paragraph that would justify it.
    expect(PASSWORD_RESET_EMAIL_LIMIT.maxPerMinute).toBeUndefined();
  });

  it("keeps the per-email ceiling strictly below the per-IP one", async () => {
    // If this ever inverts, the per-IP bucket is the binding constraint again and
    // the family stopped meaning what its derivation says it means.
    expect(PASSWORD_RESET_EMAIL_LIMIT.maxPerHour ?? 0).toBeLessThan(
      PASSWORD_RESET_IP_LIMIT.maxPerHour ?? 0,
    );
  });
});
