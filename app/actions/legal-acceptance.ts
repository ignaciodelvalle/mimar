"use server";

// legal-acceptance.ts — the web entry point for the re-acceptance of the
// current legal version (/aceptar-condiciones, 2026-10-07). Its own barrel and
// not app/actions/auth.ts, for app/actions/sessions.ts's reason: the action
// needs requireLiveUser, and that import chain must not ride into every
// consumer of the signup barrel.

import { acceptLegalTermsAction as _acceptLegalTermsAction } from "@/src/modules/auth/application/accept-legal-terms-action";

export type { LegalAcceptanceFormState } from "@/src/modules/auth/application/accept-legal-terms-action";

// @no-auth-required: authorization happens INSIDE the delegated action, whose
// first statement is requireLiveUser() and which refuses without a live session.
export async function acceptLegalTermsAction(...args: Parameters<typeof _acceptLegalTermsAction>) {
  return _acceptLegalTermsAction(...args);
}
