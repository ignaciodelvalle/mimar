"use server";

// change-password.ts — the web entry point for changing the password from
// /cuenta (A04-1). A file of its own, NOT appended to ./password-reset.ts, for
// the reason ./sessions.ts gives at length: the use-case needs requireLiveUser,
// and that import chain must not ride into the recovery form's module graph.
//
// CRITICAL: every runtime export in a "use server" file must be an async
// function.
import { changePasswordAction as _changePasswordAction } from "@/src/modules/auth/application/password-reset/change-password";

// @no-auth-required: auth enforced inside the delegated use-case (requireLiveUser() resolves the live account, and the current password is re-proven against GoTrue before anything changes)
export async function changePasswordAction(...args: Parameters<typeof _changePasswordAction>) {
  return _changePasswordAction(...args);
}
