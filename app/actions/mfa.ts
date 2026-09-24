"use server";

// mfa.ts — web entry points for the institutional second factor (T2-S6).
// Logic lives in src/modules/auth/application/mfa/; this layer builds the cookie
// client and hands it in. Every runtime export of a "use server" file must be an
// async function; types go out with `export type`.

import { createClient } from "@/lib/supabase/server";
import {
  type MfaStepState,
  confirmMfaEnrolmentAction as _confirmMfaEnrolment,
  startMfaEnrolmentAction as _startMfaEnrolment,
  verifyMfaChallengeAction as _verifyMfaChallenge,
} from "@/src/modules/auth/application/mfa/mfa-actions";

export type {
  MfaEnrolmentStart,
  MfaStepState,
} from "@/src/modules/auth/application/mfa/mfa-actions";

// @no-auth-required: auth enforced inside the delegated use-case (loadMfaSession() validates the session with GoTrue and admits only active institutional accounts; it cannot use requireLiveUser, which refuses exactly the session this step completes)
export async function verifyMfaChallengeAction(previous: MfaStepState, formData: FormData) {
  return _verifyMfaChallenge(await createClient(), previous, formData);
}

// @no-auth-required: auth enforced inside the delegated use-case (loadMfaSession() validates the session with GoTrue and admits only active institutional accounts without a verified factor)
export async function startMfaEnrolmentAction() {
  return _startMfaEnrolment(await createClient());
}

// @no-auth-required: auth enforced inside the delegated use-case (loadMfaSession() validates the session with GoTrue; GoTrue scopes the factor to the session's own user)
export async function confirmMfaEnrolmentAction(previous: MfaStepState, formData: FormData) {
  return _confirmMfaEnrolment(await createClient(), previous, formData);
}
