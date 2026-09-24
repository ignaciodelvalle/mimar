// OAuth / email confirmation callback. When a user clicks the magic link in
// their signup confirmation email (or returns from a future OAuth provider),
// they land here. We exchange the one-time `code` for a real session, then
// redirect them onward.
//
// Landing resolution (UX 0.5 fix):
//   - Explicit ?next=<path>  → honor it unchanged (deep-link preservation).
//   - No ?next= (or bare "/") → resolveUserLanding picks the best default:
//       owner with exactly 1 org → /org/<token>
//       owner with 0 or >1 orgs → /inicio
//       vet/govt/admin          → their role home (via resolveUserLanding)
//
// FAILURE FALLBACK is currently flow-specific: today the ONLY producer of this
// route is the password-recovery email (request-password-reset.ts), so a failed
// exchange lands on /recuperar. If a signup-confirmation or OAuth flow is ever
// wired here, branch the fallback on the flow (e.g. a `next`/`type` param) so a
// failed OAuth login does not show a password-reset message + form.

import { resolveUserLanding, safeReturnTo } from "@/lib/infra/role-landing";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

// @no-auth-required: this route IS the authentication boundary. It runs before
// any session exists, and its job is to create one by exchanging the one-time
// `code` for a Supabase session; a guard here would reject every legitimate
// caller. The authorization check is `exchangeCodeForSession`, which fails
// closed on a bad or replayed code, and the only caller-supplied value that
// steers anything afterwards (`next`) is sanitized through safeReturnTo().
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const nextParam = searchParams.get("next");

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Honor an explicit deep-link (e.g. from an invite flow), but ONLY after
      // sanitizing it through the same safeReturnTo() guard login/logout use —
      // defense-in-depth against an open redirect (audit 28-#LOW-7). safeReturnTo
      // rejects protocol-relative ("//evil.com"), backslash tricks, and absolute
      // URLs, returning null; a bare "/" is treated the same as absent — both
      // fall through to org-aware resolution.
      const safeNext = safeReturnTo(nextParam);
      const hasExplicitNext = safeNext !== null && safeNext !== "/";
      const landing = hasExplicitNext ? safeNext : await resolveUserLanding(data.user.id);

      return NextResponse.redirect(`${origin}${landing}`);
    }
  }

  // Anything that lands here without a valid code is a failed exchange — most
  // commonly a password-recovery link opened on a DIFFERENT device than the one
  // that requested it (the PKCE code verifier lives in the requesting device's
  // cookie jar, so the exchange cannot complete cross-device). This used to
  // bounce to `/?auth_error=1` — a flag NOTHING in the app reads, so the user
  // landed on the marketing home with no explanation (native-readiness RN-2 F2).
  // Land on the recovery page with an error the page renders, so the person
  // knows to request a fresh link from THIS device.
  return NextResponse.redirect(`${origin}/recuperar?error=enlace_invalido`);
}
