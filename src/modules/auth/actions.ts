"use server";

// Thin action controllers for the auth domain — the WEB edge of the
// pre-authentication use-cases (native-readiness WU-A; `requestPasswordReset`
// joined in WU-R-1, when the phone became the second transport for it too).
//
// WHY THIS FILE EXISTS AT ALL
// ---------------------------------------------------------------------------
// Those use-cases used to do this work themselves: read `FormData`, call
// `headers()` for the caller IP, and build a cookie-backed Supabase client.
// That is a web request living inside a use-case, and it is what kept each of
// them on the application-fence exemption list. Everything web-shaped moved
// HERE, which is the layer whose job it is (ADR 2026-07-18, Decision 1;
// docs/architecture/hexagonal-lite.md). What is left in `application/` is
// callable from `/api/v1`, from a script, and from a native client's request.
//
// Each action does ONLY:
//   1. Parse the form encoding (including `"on"` → boolean for the checkbox).
//   2. Resolve request context — the trusted edge IP.
//   3. Inject the GoTrue port, LAZILY (see below), and call the use-case.
//   4. Map the coded result back to AuthFormState.
//
// WHY THE CLIENT FACTORY IS LAZY AND NOT AN AWAITED CLIENT
// ---------------------------------------------------------------------------
// `createClient()` reads `cookies()`. Building it here, eagerly, would run a
// request-bound side effect BEFORE the use-case's validation and rate-limit
// gates — reordering the two things this flow is most careful about. Handing
// over a factory keeps "nothing touches GoTrue until the budgets pass" a
// property of the use-case rather than of this file's statement order.
//
// The email echo (bug #46 — React 19 resets an uncontrolled form once the
// action resolves, wiping the DOM-owned email) is added HERE, on refusals only,
// from the input this layer already holds. The signup success masquerade never
// echoes, and cannot: it returns the success arm, which has no field for one.

import { headers } from "next/headers";

import { callerIp } from "@/lib/infra/rate-limit";
import { createClient } from "@/lib/supabase/server";

import { login } from "./application/login";
import { requestPasswordReset } from "./application/password-reset/request-password-reset";
import type { PasswordResetRequestState } from "./application/password-reset/types";
import { signup } from "./application/signup";
import type { AuthFormState } from "./application/types";

/** The cookie-backed GoTrue surface, built on first use. */
async function cookieAuth() {
  return (await createClient()).auth;
}

// @no-auth-required: pre-authentication entrypoint — login by definition requires no existing session
export async function loginAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();

  const result = await login(
    {
      email,
      password: String(formData.get("password") ?? ""),
      returnTo: String(formData.get("returnTo") ?? ""),
      // The trusted edge IP: x-real-ip / last XFF hop, never the spoofable
      // first XFF segment. Resolved here because only this layer has a request.
      callerIp: callerIp(await headers()),
    },
    { auth: cookieAuth },
  );

  if (!result.ok) return { error: result.error.message, email };

  // NAV CONTRACT N3: return the destination, never call redirect(). That
  // response resolves while the App Router silently drops the transition —
  // lib/ui/full-page-action-nav.ts has the evidence, lint:action-redirect keeps
  // it that way, and the login screen is where it was first observed.
  return { error: null, redirectTo: result.value.landingPath };
}

// @no-auth-required: pre-authentication entrypoint — signup by definition requires no existing session
export async function signupAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();

  const result = await signup(
    {
      email,
      password: String(formData.get("password") ?? ""),
      confirmPassword: String(formData.get("confirmPassword") ?? ""),
      // The HTML checkbox encoding. Translating it is this layer's job — the
      // contract package describes a boolean, because a native client has no
      // checkboxes to encode.
      tosAccepted: formData.get("tosAccepted") === "on",
      callerIp: callerIp(await headers()),
    },
    { auth: cookieAuth },
  );

  if (!result.ok) return { error: result.error.message, email };

  // Do NOT redirect. The inline signup flow uses `ok` to transition the same
  // page to the identity-collection step (step 2). The session the use-case
  // returns is deliberately dropped: the cookie client already persisted it,
  // and a form has nowhere to put a token. `/api/v1` is where it is read.
  return { error: null, ok: true };
}

// @no-auth-required: pre-authentication entrypoint — a person asking for a recovery credential is by definition unable to sign in
export async function requestPasswordResetAction(
  _previous: PasswordResetRequestState,
  formData: FormData,
): Promise<PasswordResetRequestState> {
  const email = String(formData.get("email") ?? "").trim();
  const result = await requestPasswordReset(
    {
      email,
      callerIp: callerIp(await headers()),
    },
    { auth: cookieAuth },
  );

  if (!result.ok) return { message: null, error: result.error.message, email };

  // ONE SENTENCE FOR EVERY SUCCESS, and it is the enumeration defence rather
  // than vague copy. The use-case cannot tell this layer whether a mail went out
  // — its success arm has no field for it, on purpose — so there is nothing here
  // to condition on even if a future edit wanted to. The email IS echoed, and on
  // every success alike: the code step that replaces this form sends it back with
  // the code, because `verifyOtp` needs both. It is what the person typed.
  return {
    message:
      "Si existe una cuenta con ese correo, te enviamos un código de 6 dígitos. Revisá también tu carpeta de spam.",
    error: null,
    email,
  };
}

// THE REDEMPTION HALF IS NOT HERE, on purpose. Exchanging the six-digit code for
// a recovery session happens in the BROWSER (`app/(auth)/recuperar/ResetCodeStep.tsx`)
// so that GoTrue keys its per-IP `token_verifications` ceiling on the real
// person's address instead of on this deployment's single egress address — the
// same way the phone already redeems. The comment at the top of that file has
// the full reasoning, including why the buckets it used to spend were not
// protecting anybody.
