"use server";

// password-reset.ts — thin shim (strangler migration 48/61).
//
// Business logic lives in `src/modules/auth/`: `requestPasswordResetAction` at
// the action EDGE (actions.ts) since WU-R-1, when `/api/v1/auth/password-reset`
// became a second caller of its use-case and `FormData` + `headers()` stopped
// being things that use-case may read; `updatePasswordAction` still in
// `application/password-reset/` and still coupled, because the recovery session
// it re-verifies is a cookie session and a phone changes its password through
// GoTrue directly (apps/mobile/src/auth/session-store.ts). Both are re-exported
// here with identical signatures so every caller keeps working unchanged.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function — bare `export { x } from "..."` re-exports are rejected by the
// Next.js compiler. Types are re-exported with `export type` (erased at runtime).
import { requestPasswordResetAction as _requestPasswordResetAction } from "@/src/modules/auth/actions";
import { updatePasswordAction as _updatePasswordAction } from "@/src/modules/auth/application/password-reset/update-password";

export type {
  PasswordResetRequestState,
  UpdatePasswordState,
} from "@/src/modules/auth/application/password-reset/types";

// @no-auth-required: anonymous password-reset request — user is locked out and requesting a recovery email
export async function requestPasswordResetAction(
  ...args: Parameters<typeof _requestPasswordResetAction>
) {
  return _requestPasswordResetAction(...args);
}

// @no-auth-required: auth enforced inside the delegated use-case (supabase.auth.getUser() validates the recovery session before updating the password)
export async function updatePasswordAction(...args: Parameters<typeof _updatePasswordAction>) {
  return _updatePasswordAction(...args);
}
