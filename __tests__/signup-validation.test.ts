// Unit tests for signupAction and completeIdentityAction validation gates.
//
// Every case here fails validation BEFORE the Supabase client is created, so
// no auth or DB interaction happens — same pattern as claim-gate.test.ts.
//
// completeIdentityAction requires an active session (supabase.auth.getUser) to
// proceed past validation. Tests that exercise pre-session guards are possible
// because the NAME presence check runs before the session lookup. (It used to
// say "the DNI format check"; that check was removed with the field on
// 2026-09-07, and the names are now the only gate standing before the session
// lookup.) Tests that require an authenticated user are skipped with a note.

import { describe, expect, it, vi } from "vitest";

// signupAction now derives callerIp from request headers for its per-IP
// rate-limit budget. Mock next/headers so the header read succeeds. Note the
// mock intentionally omits `cookies`, so a validation-passing test still throws
// downstream at createClient()'s cookies() call — preserving the original
// "reaches Supabase" assertion.
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === "x-real-ip" ? "10.0.0.1" : null),
  })),
}));

// Rate limiter: allow by default so validation-gate tests reach (or clear) it.
vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: vi.fn().mockResolvedValue(undefined),
  };
});

import { completeIdentityAction, signupAction } from "@/app/actions/auth";

function buildAuthForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("email", "ana@example.com");
  fd.set("password", "supersecreta");
  fd.set("confirmPassword", "supersecreta");
  fd.set("tosAccepted", "on");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

function buildIdentityForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("firstName", "Ana");
  fd.set("lastName", "Pérez");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

describe("signupAction — validation gates", () => {
  it("rejects when email is missing", async () => {
    const fd = buildAuthForm({ email: "" });
    const result = await signupAction({ error: null }, fd);
    expect(result.error).toMatch(/Faltan datos/);
  });

  it("rejects when password is missing", async () => {
    const fd = buildAuthForm({ password: "", confirmPassword: "" });
    const result = await signupAction({ error: null }, fd);
    expect(result.error).toMatch(/Faltan datos/);
  });

  it("rejects passwords under 8 characters", async () => {
    const fd = buildAuthForm({ password: "corta", confirmPassword: "corta" });
    const result = await signupAction({ error: null }, fd);
    expect(result.error).toMatch(/al menos 8 caracteres/);
  });

  it("rejects when passwords do not match", async () => {
    const fd = buildAuthForm({ confirmPassword: "otracontraseña" });
    const result = await signupAction({ error: null }, fd);
    expect(result.error).toMatch(/no coinciden/);
  });

  it("rejects when confirmPassword is absent entirely", async () => {
    const fd = buildAuthForm();
    fd.delete("confirmPassword");
    const result = await signupAction({ error: null }, fd);
    expect(result.error).toMatch(/no coinciden/);
  });

  it("rejects when the TOS checkbox is not accepted", async () => {
    const fd = buildAuthForm();
    fd.delete("tosAccepted");
    const result = await signupAction({ error: null }, fd);
    expect(result.error).toMatch(/Términos/);
  });

  it("does not require displayName — validation passes and action reaches Supabase", async () => {
    // Verifies that step 1 no longer validates displayName. A valid form
    // without displayName must pass all pre-Supabase guards and then throw at
    // the Next.js `cookies()` call (no request context in unit tests).
    // That throw confirms validation was cleared — it's NOT a "Faltan datos" error.
    const fd = buildAuthForm();
    // displayName is intentionally absent.
    await expect(signupAction({ error: null }, fd)).rejects.toThrow(/request scope|cookies/i);
  });
});

describe("completeIdentityAction — pre-session validation gates", () => {
  // These tests exercise guards that run before supabase.auth.getUser.
  //
  // CORRECTED 2026-08-01. The comment that used to sit here said:
  //
  //   "The action will redirect to /signup (NEXT_REDIRECT) when it reaches the
  //    session check and no session exists"
  //
  // That was false twice over. completeIdentityAction has not redirected since
  // the anti-loop fix — on a missing session it RETURNS an honest error, and
  // __tests__/signup-no-session-guard.test.ts fails loudly if redirect() is
  // ever called from it. So the comment documented, as expected behaviour, the
  // exact bug a sibling test file exists to prevent.
  //
  // What actually throws in these "valid input" cases is:
  //
  //   Error: `cookies` was called outside a request scope.
  //
  // — createClient() reaching for Next's request context, which unit tests do
  // not have. The old assertions were a bare `rejects.toThrow()`, which cannot
  // tell that throw apart from any other. Measured: with the DNI format check
  // replaced by `if (false)`, all three "accepts a valid DNI" tests still
  // passed. They asserted nothing about DNI acceptance.
  //
  // The matcher below fixes that. It still cannot reach the profile write, but
  // it is no longer vacuous: a REJECTED DNI would return a validation error
  // instead of throwing, so `rejects` fails. The specific pattern additionally
  // pins WHERE execution got to, so an unrelated throw can never be mistaken
  // for success.
  //
  // The three "accepts a valid DNI" tests that paragraph refers to no longer
  // exist — see the block below for why. The matcher outlived them because the
  // property it makes non-vacuous outlived them too: it is now what proves the
  // action walks PAST a DNI instead of validating one.
  const REACHED_REQUEST_BOUNDARY = /request scope|cookies/i;

  it("rejects when firstName is empty", async () => {
    const fd = buildIdentityForm({ firstName: "" });
    const result = await completeIdentityAction({ error: null }, fd);
    expect(result.error).toMatch(/nombre y apellido/);
  });

  it("rejects when lastName is empty", async () => {
    const fd = buildIdentityForm({ lastName: "" });
    const result = await completeIdentityAction({ error: null }, fd);
    expect(result.error).toMatch(/nombre y apellido/);
  });

  // -------------------------------------------------------------------------
  // THIS BLOCK USED TO BE SEVEN DNI-FORMAT TESTS, AND THE INVERSION IS THE POINT
  // -------------------------------------------------------------------------
  // They pinned `DNI_RE` — letters rejected, <7 rejected, >8 rejected, 7 and 8
  // accepted, absent accepted, dots stripped. All seven are gone with the field
  // they guarded (PO decision 2026-09-07, `SignupForm.tsx` carries the argument:
  // a DNI collected here left `dni_verified` false and unlocked nothing, while
  // still occupying `profiles_dni_hash_unique` — partial on `dni_hash IS NOT
  // NULL`, not on `dni_verified` — where it could lock a stranger out of
  // verifying their own).
  //
  // WHAT REPLACES THEM IS NOT NOTHING, and it is the assertion the old seven
  // could not make. Removing an <input> removes a suggestion, not a boundary: a
  // server action accepts whatever multipart body is posted to it. So the claim
  // worth pinning is no longer "a malformed DNI is rejected" but "a DNI is not
  // read AT ALL" — which is why this test posts a perfectly well-formed one and
  // requires the action to sail straight past it to the session boundary.
  //
  // Non-vacuity, checked the way the note above checks it: if the action still
  // read and validated `dni`, the malformed case below would RETURN a validation
  // error instead of throwing, and `rejects` would fail. Both directions are
  // therefore covered by two tests rather than seven.
  it("ignores a well-formed DNI in the posted form data — the field is not read", async () => {
    const fd = buildIdentityForm({ dni: "34567890" });
    await expect(completeIdentityAction({ error: null }, fd)).rejects.toThrow(
      REACHED_REQUEST_BOUNDARY,
    );
  });

  it("ignores a MALFORMED DNI too, rather than answering with the old format error", async () => {
    // The hand-crafted-POST case. `abc1234` would have produced "El DNI debe
    // tener 7 u 8 dígitos numéricos." from the removed validator; reaching the
    // session boundary instead proves the parse is gone and not merely the
    // input. If somebody restores the read, this test goes red — which is the
    // whole reason it is written from the attacker's side and not the form's.
    const fd = buildIdentityForm({ dni: "abc1234" });
    await expect(completeIdentityAction({ error: null }, fd)).rejects.toThrow(
      REACHED_REQUEST_BOUNDARY,
    );
  });

  it("still requires both names, with no DNI anywhere in the picture", async () => {
    const fd = buildIdentityForm();
    await expect(completeIdentityAction({ error: null }, fd)).rejects.toThrow(
      REACHED_REQUEST_BOUNDARY,
    );
  });
});
