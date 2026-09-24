"use server";

// first-access.ts — thin action edge for the institutional first-access step
// (/primer-acceso). Business logic lives in
// src/modules/auth/application/first-access/set-initial-password.ts; this edge
// only builds the cookie-bound session client and reads the form.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).
import { createClient } from "@/lib/supabase/server";
import {
  type SetInitialPasswordState,
  setInitialPassword,
} from "@/src/modules/auth/application/first-access/set-initial-password";

export type { SetInitialPasswordState } from "@/src/modules/auth/application/first-access/set-initial-password";

// @no-auth-required: auth enforced inside the delegated use-case (supabase.auth.getUser() validates the session the first-access link minted, and the service-role-only password_setup_pending flag must be set)
export async function setInitialPasswordAction(
  _previous: SetInitialPasswordState,
  formData: FormData,
): Promise<SetInitialPasswordState> {
  const supabase = await createClient();
  return setInitialPassword(supabase, {
    password: String(formData.get("password") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  });
}
