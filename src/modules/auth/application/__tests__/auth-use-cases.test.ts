// The two pre-authentication use-cases, tested WITHOUT a web request
// (native-readiness WU-A).
//
// WHAT THIS FILE PROVES THAT NOTHING ELSE CAN
// ---------------------------------------------------------------------------
// `__tests__/auth-actions.test.ts` already drives these flows end-to-end
// through the web action against a real local database, and it stays the owner
// of the landing decision and the deactivation path. What it cannot see is the
// property that made this refactor worth doing:
//
//   1. ORDER. The limiter fires BEFORE GoTrue and before any user lookup. The
//      old test asserted the limiter was CONSULTED and that Supabase was not
//      called when it refused — both true of code that consults it afterwards
//      and discards the answer. This file pins the SEQUENCE, so a future edit
//      that moves the credential check one line up fails here.
//   2. NON-ENUMERATION AS EQUALITY. "Wrong password" and "no such account" must
//      produce the same object, not merely two objects that each look generic.
//      Two hand-written generic messages drift; one assertion on equality does
//      not.
//   3. That the same call bounds BOTH transports. There is one `login`, one set
//      of buckets and one set of keys, so an attacker cannot get a fresh budget
//      by switching from the form to `/api/v1`. The bucket names are asserted
//      as literals here for the same reason the throttle fence demands literals
//      elsewhere: a computed key is how one surface starts spending another's.
//
// NO DATABASE IS REACHED. Every case stops at or before GoTrue: signup never
// queries at all, and the login cases here are the three gates that return
// before the profile lookup. The success and deactivation paths need real rows
// and are tested where the rows are.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep RateLimitError REAL — the use-cases branch on `instanceof`, and a mocked
// class would make the fail-closed test pass for the wrong reason.
const { limiter } = vi.hoisted(() => ({
  limiter: {
    calls: [] as Array<{ endpoint: string; identifier: string }>,
    /** Replaces the limiter's answer. Return/throw per endpoint. */
    behaviour: null as null | ((endpoint: string) => void),
  },
}));

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      limiter.calls.push({ endpoint, identifier });
      limiter.behaviour?.(endpoint);
    },
  };
});

import { RateLimitError, emailRateLimitKey } from "@/lib/infra/rate-limit";

import { toAuthSessionV1 } from "../gotrue-port";
import { login } from "../login";
import { signup } from "../signup";

const IP = "10.0.0.1";

const GOTRUE_SESSION = {
  access_token: "at",
  refresh_token: "rt",
  expires_in: 3600,
  expires_at: 1_800_000_000,
  token_type: "bearer",
};

/** Every collaborator the use-case reached, in the order it reached them. */
let trace: string[] = [];

function loginPort(answer: {
  user?: { id: string } | null;
  session?: typeof GOTRUE_SESSION | null;
  error?: { message: string } | null;
}) {
  return {
    signInWithPassword: async () => {
      trace.push("gotrue:signInWithPassword");
      return {
        data: { user: answer.user ?? null, session: answer.session ?? null },
        error: answer.error ?? null,
      };
    },
    signOut: async () => {
      trace.push("gotrue:signOut");
      return { error: null };
    },
  };
}

function signupPort(answer: {
  user?: { id: string } | null;
  session?: typeof GOTRUE_SESSION | null;
  /** `code` is GoTrue's typed `ErrorCode`; see the note on `GoTrueAuthResponse`. */
  error?: { message: string; code?: string } | null;
}) {
  return {
    signUp: async () => {
      trace.push("gotrue:signUp");
      return {
        data: { user: answer.user ?? null, session: answer.session ?? null },
        error: answer.error ?? null,
      };
    },
  };
}

/** Records the moment the client is BUILT, which is a separate event to using it. */
function deps<T>(port: T) {
  return {
    auth: async () => {
      trace.push("build:auth-client");
      return port;
    },
  };
}

beforeEach(() => {
  limiter.calls = [];
  limiter.behaviour = null;
  trace = [];
});

// ---------------------------------------------------------------------------
// login — order
// ---------------------------------------------------------------------------

describe("login — the limiter runs before anything expensive", () => {
  it("consults BOTH budgets, in order, before the GoTrue client is even built", async () => {
    await login(
      { email: "ana@example.com", password: "x", callerIp: IP },
      deps(loginPort({ error: { message: "Invalid login credentials" } })),
    );

    // The client is built lazily by the use-case, AFTER the budgets. Building
    // it earlier is not a style question: the web edge's factory reads cookies,
    // so an eager build moves a request-bound side effect ahead of the gates.
    expect(trace).toEqual(["build:auth-client", "gotrue:signInWithPassword"]);
    expect(limiter.calls.map((c) => c.endpoint)).toEqual(["auth_login_ip", "auth_login_email"]);
  });

  it("keys the two budgets on the trusted edge IP and the HASHED email", async () => {
    // The raw email never reaches rate_limit_buckets.bucket_key: that table is
    // readable by every worker and an email is PII (Ley 25.326). The hash is
    // also what makes the per-email budget shared across transports — the same
    // account is the same key whether the request came from a form or a phone.
    await login(
      { email: "  ANA@example.com ", password: "x", callerIp: IP },
      deps(loginPort({ error: { message: "Invalid login credentials" } })),
    );

    expect(limiter.calls[0]).toEqual({ endpoint: "auth_login_ip", identifier: IP });
    expect(limiter.calls[1]).toEqual({
      endpoint: "auth_login_email",
      identifier: emailRateLimitKey("ana@example.com"),
    });
    expect(limiter.calls[1]?.identifier).not.toContain("ana@example.com");
  });

  it("never reaches GoTrue when a budget refuses", async () => {
    limiter.behaviour = () => {
      throw new RateLimitError(new Date(), "auth_login_ip");
    };

    const result = await login(
      { email: "ana@example.com", password: "x", callerIp: IP },
      deps(loginPort({ user: { id: "u1" }, session: GOTRUE_SESSION })),
    );

    expect(result.ok).toBe(false);
    // Not "signInWithPassword was not called" — NOTHING was, not even the
    // client construction. A refused request costs the platform one counter.
    expect(trace).toEqual([]);
  });

  it("validates before it spends a budget — a blank field costs no counter", async () => {
    const result = await login({ email: "", password: "", callerIp: IP }, deps(loginPort({})));

    expect(result).toEqual({
      ok: false,
      error: { code: "missing_fields", message: "Faltan datos." },
    });
    expect(limiter.calls).toEqual([]);
    expect(trace).toEqual([]);
  });

  it("FAILS CLOSED when the limiter itself breaks", async () => {
    // A limiter that cannot answer must not be read as "allow". This is the
    // one branch where the use-case deliberately throws instead of refusing:
    // an infrastructure failure is not a domain outcome, and swallowing it here
    // would turn a broken counter into an unbounded login endpoint.
    limiter.behaviour = () => {
      throw new Error("rate_limit_buckets is unreachable");
    };

    await expect(
      login({ email: "ana@example.com", password: "x", callerIp: IP }, deps(loginPort({}))),
    ).rejects.toThrow(/unreachable/);
    expect(trace).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// login — non-enumeration
// ---------------------------------------------------------------------------

describe("login — refusals are not an oracle", () => {
  it("answers IDENTICALLY for a wrong password and an unknown email", async () => {
    // GoTrue returns the same "Invalid login credentials" for both, but that is
    // the provider's promise, not ours. What this pins is that the use-case
    // does not add a distinguishing detail of its own on either side.
    const wrongPassword = await login(
      { email: "existe@example.com", password: "mala", callerIp: IP },
      deps(loginPort({ error: { message: "Invalid login credentials" } })),
    );
    const unknownEmail = await login(
      { email: "nadie@example.com", password: "loquesea", callerIp: IP },
      deps(loginPort({ error: { message: "Invalid login credentials" } })),
    );

    expect(wrongPassword).toEqual(unknownEmail);
    expect(wrongPassword).toEqual({
      ok: false,
      error: { code: "invalid_credentials", message: "Correo o contraseña incorrectos." },
    });
  });

  it("answers IDENTICALLY whichever budget ran out", async () => {
    limiter.behaviour = (endpoint) => {
      if (endpoint === "auth_login_ip") throw new RateLimitError(new Date(), endpoint);
    };
    const perIp = await login(
      { email: "ana@example.com", password: "x", callerIp: IP },
      deps(loginPort({})),
    );

    limiter.calls = [];
    limiter.behaviour = (endpoint) => {
      if (endpoint === "auth_login_email") throw new RateLimitError(new Date(), endpoint);
    };
    const perEmail = await login(
      { email: "ana@example.com", password: "x", callerIp: IP },
      deps(loginPort({})),
    );

    // The per-email budget is the one that could say "this account is under
    // attack", which is a statement about an account existing. The two
    // refusals are the same object so it cannot.
    expect(perIp).toEqual(perEmail);
    expect(perIp).toEqual({
      ok: false,
      error: {
        code: "rate_limited",
        message: "Demasiados intentos. Esperá un momento y volvé a probar.",
      },
    });
  });

  it("refuses rather than throwing when GoTrue reports success with no user", async () => {
    const result = await login(
      { email: "ana@example.com", password: "x", callerIp: IP },
      deps(loginPort({ user: null, session: null, error: null })),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_credentials", message: "Correo o contraseña incorrectos." },
    });
  });
});

// ---------------------------------------------------------------------------
// signup
// ---------------------------------------------------------------------------

describe("signup — gates, in order", () => {
  const VALID = {
    email: "nueva@example.com",
    password: "supersecreta",
    confirmPassword: "supersecreta",
    tosAccepted: true,
    callerIp: IP,
  };

  it("spends its single per-IP budget before building anything", async () => {
    await signup(VALID, deps(signupPort({ user: { id: "u1" }, session: GOTRUE_SESSION })));

    expect(limiter.calls).toEqual([{ endpoint: "auth_signup_ip", identifier: IP }]);
    expect(trace).toEqual(["build:auth-client", "gotrue:signUp"]);
  });

  it.each([
    [{ email: "" }, "missing_fields"],
    [{ password: "corta12" }, "password_too_short"],
    [{ confirmPassword: "otracosaentera" }, "password_mismatch"],
    [{ tosAccepted: false }, "tos_not_accepted"],
  ])("refuses %o with the coded branch and spends no counter", async (patch, code) => {
    const result = await signup({ ...VALID, ...patch }, deps(signupPort({})));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
    // Every message stays es-AR prose for the form; the CODE is what a native
    // client branches on. Both travel together, from one place.
    if (!result.ok) expect(result.error.message).not.toBe("");
    expect(limiter.calls).toEqual([]);
    expect(trace).toEqual([]);
  });

  it("never reaches GoTrue when the budget refuses", async () => {
    limiter.behaviour = () => {
      throw new RateLimitError(new Date(), "auth_signup_ip");
    };
    const result = await signup(VALID, deps(signupPort({})));

    expect(result).toEqual({
      ok: false,
      error: {
        code: "rate_limited",
        message: "Demasiados intentos. Esperá un momento y volvé a probar.",
      },
    });
    expect(trace).toEqual([]);
  });
});

describe("signup — the enumeration masquerade", () => {
  const VALID = {
    email: "existe@example.com",
    password: "supersecreta",
    confirmPassword: "supersecreta",
    tosAccepted: true,
    callerIp: IP,
  };

  it("reports SUCCESS with no session when the email is already registered", async () => {
    const result = await signup(
      VALID,
      deps(signupPort({ error: { message: "User already registered" } })),
    );
    // Success, so no client can branch on "this email exists". The missing
    // session is the documented residual, identical to the web's missing
    // cookie — see SignupV1 in the contract package.
    expect(result).toEqual({ ok: true, value: { session: null } });
  });

  it("says WHY when the provider refused the password, in our own words", async () => {
    // THIS TEST USED TO ASSERT THE GENERIC REFUSAL, and the fixture is the same
    // one it always used — a provider message about a weak password. The
    // product owner hit it on a real device on 2026-09-11: "estaba poniendo una
    // pass muy fácil, pero fallaba diciéndome nada útil". A person who can fix
    // the problem in three seconds was being told to try again later.
    //
    // THE LEAK GUARD THIS FILE EXISTS FOR IS UNTOUCHED. The provider's own
    // string never reaches the caller — the branch reads it and answers with a
    // sentence written here. That is why the assertion is on OUR text, and why
    // the case below still exists for everything else.
    const result = await signup(
      VALID,
      deps(
        signupPort({
          error: {
            message:
              "Password is known to be weak and easy to guess, please choose a different one.",
          },
        }),
      ),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "weak_password",
        message:
          "Esa contraseña es muy fácil de adivinar. Elegí otra, con palabras o números que no uses en otro lado.",
      },
    });
    // The proof that nothing leaked: no fragment of the provider's message.
    expect(result.ok === false && result.error.message).not.toContain("entropy");
  });

  it("classifies by the provider's CODE, even when the message says nothing", async () => {
    // The instrument that replaced two rounds of substring matching.
    // `weak_password` is a member of `@supabase/auth-js`'s typed `ErrorCode`
    // union and was confirmed on the wire against the live project. A message
    // this build has never seen must still be classified correctly.
    const result = await signup(
      VALID,
      deps(signupPort({ error: { message: "una redacción futura", code: "weak_password" } })),
    );
    expect(result.ok === false && result.error.code).toBe("weak_password");
  });

  it("does NOT call a 73-character passphrase easy to guess", async () => {
    // THE BUG THE FIRST VERSION SHIPPED. The branch matched `includes("password")`,
    // and GoTrue also answers "Password cannot be longer than 72 characters" —
    // which contains the word. Nothing upstream stops a long value from getting
    // there: `signup` checks empty, minimum, mismatch and TOS, and no maximum.
    // So the one person using a password manager properly was told their
    // passphrase was "muy fácil de adivinar". The branch now matches the
    // VERDICT, not the noun.
    const result = await signup(
      VALID,
      deps(signupPort({ error: { message: "Password cannot be longer than 72 characters" } })),
    );
    expect(result.ok === false && result.error.code).toBe("signup_failed");
  });

  it("never surfaces the provider's text on any OTHER failure", async () => {
    // The generic arm, pinned with a message that has nothing to do with a
    // password — otherwise the branch above would swallow this case too and the
    // leak guard would be testing itself.
    const result = await signup(
      VALID,
      deps(signupPort({ error: { message: "smtp relay refused: 550 mailbox unavailable" } })),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "signup_failed",
        message: "No pudimos completar el registro. Revisá tus datos e intentá de nuevo.",
      },
    });
  });

  it("hands back the session GoTrue minted for a genuine new account", async () => {
    const result = await signup(
      VALID,
      deps(signupPort({ user: { id: "u1" }, session: GOTRUE_SESSION })),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        session: {
          accessToken: "at",
          refreshToken: "rt",
          expiresIn: 3600,
          expiresAt: 1_800_000_000,
          tokenType: "bearer",
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// The session mapper
// ---------------------------------------------------------------------------

describe("toAuthSessionV1", () => {
  it("keeps expiresAt in SECONDS, GoTrue's unit", () => {
    // A silent unit change between two fields called the same thing is a bug
    // that only shows up at the moment a session should have been refreshed.
    const mapped = toAuthSessionV1(GOTRUE_SESSION);
    expect(mapped?.expiresAt).toBe(1_800_000_000);
    expect(mapped?.expiresIn).toBe(3600);
  });

  it("reports a MISSING absolute expiry as null rather than fabricating one", () => {
    const { expires_at: _dropped, ...withoutAbsolute } = GOTRUE_SESSION;
    expect(toAuthSessionV1(withoutAbsolute)?.expiresAt).toBeNull();
  });

  it("maps a null session to null", () => {
    expect(toAuthSessionV1(null)).toBeNull();
  });
});
