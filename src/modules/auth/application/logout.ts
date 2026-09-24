// Use-cases: logoutAction + logoutAndReturnAction (strangler migration 26/61).
//
// @no-auth-required: logout invalidates whatever session exists (or none).
//
// A FAILED SIGN-OUT DOES NOT REDIRECT (A04-2). auth-js answers a GoTrue 5xx or
// a dropped connection with `{ error }` and WITHOUT clearing the local session
// (only 401/403/404/session-missing reach `_removeSession()`), so the SSR
// cookies survive. Redirecting anyway tells a person on a shared or borrowed
// phone that they left when they did not — the finder flow on
// `/p/{token}/encontre` exists precisely for that phone. The failure arm is
// therefore terminal, mirroring `/turno-vencido`: no redirect, the page they
// pressed the button on stays, and it still shows the open session, which is
// the truth.

import { safeReturnTo } from "@/lib/infra/role-landing";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export async function logoutAction() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) return;
  redirect("/");
}

// Variant of logoutAction that redirects back to a caller-supplied path
// instead of home. Used by public finder flows so the visitor can continue
// anonymously on the same page after signing out.
//
// @no-auth-required: logout invalidates whatever session exists (or none);
// no user identity is needed to call signOut.
export async function logoutAndReturnAction(returnTo: string) {
  const safePath = safeReturnTo(returnTo);
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) return;
  redirect(safePath ?? "/");
}
