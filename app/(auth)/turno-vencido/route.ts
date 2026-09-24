// Where an operator whose 8-hour shift ran out is sent to actually LEAVE (B9).
//
// WHY A ROUTE HANDLER AND NOT A REDIRECT STRAIGHT TO /iniciar-sesion
// ---------------------------------------------------------------------------
// Because the session is still VALID as far as GoTrue is concerned. The shift is
// our policy, not the token's expiry, so at the moment `requireLiveUser` refuses
// a SHIFT_EXPIRED operator the cookie in their browser still authenticates them
// perfectly well.
//
// `/iniciar-sesion` redirects an already-authenticated visitor onward by role
// (see its `pathForRole` call). So bouncing a shift-expired operator there would
// send them to the login page, which would send them back into the portal, which
// would refuse them again — the exact ERR_TOO_MANY_REDIRECTS shape recorded on
// 2026-07-04 and warned about in lib/infra/auth-guards.ts. A guard that refuses
// without ending the session does not end the session.
//
// It also would not do the job even if it worked. The whole point of B9 is a
// shared municipal desk: leaving a live operator session in the browser and
// merely declining to render is precisely the state the control exists to
// prevent. The shift ending has to mean signed out.
//
// A Route Handler is the only place that can do it: cookies are writable here
// and not during a Server Component render, and `redirect()` inside a Server
// Action resolves and is then dropped by the client router (contract N3, and the
// reason the denuncia logout is a handler too).
//
// WHY GET, AND WHY THAT IS NOT A LOGOUT-ANYONE LINK
// ---------------------------------------------------------------------------
// It has to answer GET: `redirect()` from a page guard issues one, and there is
// no form to POST from mid-render.
//
// A GET that ends sessions is normally a CSRF gift — any cross-site page, or a
// prefetch, can force a victim's logout. This one is safe for a structural
// reason rather than a hopeful one: IT RE-DERIVES THE POLICY ITSELF and signs
// out ONLY a session THE SAME POLICY THAT REFUSED THE OPERATOR independently
// reports as over. A session inside its shift is redirected home with its
// cookies untouched. So the worst an attacker can force is the logout of a
// session that our own policy has already refused — which is the state this
// endpoint exists to produce.
//
// That check is not defence-in-depth decoration. It is what makes the URL
// harmless to hand out.
//
// AND `requireLiveUser` ALONE IS NOT THAT POLICY — IT IS HALF OF IT (2026-08-25)
// ---------------------------------------------------------------------------
// The re-derivation used to be one call to `requireLiveUser`, and that call can
// only ever refuse an INSTITUTIONAL principal for the shift: its check sits
// behind `isInstitutionalPrincipal`, i.e. an `institutional` accountType or a
// `govt`/`admin`/`national` role (lib/infra/live-user.ts). The single largest group of
// operators under B9 does not match it. A clinic vet holds `role: "vet"` /
// `accountType: "personal"` and their operator-ness lives in
// `organization_memberships`, a table `requireLiveUser` never reads — which is
// exactly why the org capability path re-applies the shift for them
// (`resolveLiveActor` in src/modules/organizations/infrastructure/authz-resolver.ts).
//
// So the org vet was refused at /org/{token}/atender, redirected here by the
// page — and THIS ROUTE saw `ok: true`, redirected to `/`, and touched nothing.
// No sign-out, no card, no explanation: the operator went round the loop and
// landed on the home page still authenticated on the clinic's shared desk. The
// commit that shipped the redirect said "UN TURNO VENCIDO ES UN CIERRE DE
// SESION, NO UN CARTEL" and then, for that principal, produced neither.
//
// The fix is to re-derive the WHOLE policy rather than the institutional half:
// on an `ok` result, ask the second predicate — does this caller hold an ACTIVE
// ORG MEMBERSHIP, and is their session past `isOperatorShiftExpired`? Both legs
// reuse the plumbing that already exists (`getActiveMemberships`, and the
// `sessionStartedAt` requireLiveUser resolves for every caller precisely so this
// principal can be judged); nothing here re-implements the `amr` decode.
//
// THE MEMBERSHIP LEG IS WHAT KEEPS THE CSRF ARGUMENT TRUE, and it is not
// incidental. B9 gives CITIZENS long-lived sessions on purpose, so "session
// older than 8 hours" describes an ordinary, healthy citizen session — a
// shift-only test would have made this URL a working cross-site logout link for
// most of the userbase. Membership is the predicate that says "this session
// belongs to an operator", which is the only population whose sessions policy
// wants ended.

import { redirect } from "next/navigation";

import { type LiveUserResult, requireLiveUser } from "@/lib/infra/live-user";
import { isOperatorShiftExpired } from "@/lib/infra/operator-shift";
import { createClient } from "@/lib/supabase/server";
import { getActiveMemberships } from "@/src/modules/organizations/infrastructure/authz-resolver";

export const dynamic = "force-dynamic";

// @no-auth-required: this is a LOGOUT destination. Requiring a live session to
// reach it would strand the only caller it is for — an operator whose session
// the liveness guard has just refused. It authorizes nothing and discloses
// nothing: every branch either redirects or renders its own terminal answer,
// and the only side effect is ending the caller's OWN session, and only when
// policy already says it is over.
export async function GET() {
  const live = await requireLiveUser();

  // Not a shift problem — do not touch the session. Covers the prefetch, the
  // cross-site auto-navigation, and the citizen who simply typed the URL.
  // MAINTENANCE and the account-state refusals have their own destinations and
  // must not be laundered into "your shift ended".
  if (!(await isShiftOver(live))) {
    redirect("/");
  }

  // Global scope so the shift ends everywhere, not just in this browser. An
  // operator's 8 hours are a property of the PERSON, and a shift that ends on
  // the desktop while the same login stays live on a tablet in the same office
  // is the shared-terminal hole with an extra step.
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "global" });

  // THE RESULT IS CHECKED, AND THAT IS THE WHOLE POINT OF THIS ROUTE.
  // ---------------------------------------------------------------------------
  // This handler used to discard it and redirect unconditionally, which rebuilt
  // the exact loop the header above claims it was designed to prevent. Read
  // auth-js 2.105.4, GoTrueClient `_signOut`: it calls the admin sign-out and
  // then, on error, returns `{ error }` WITHOUT reaching `_removeSession()`
  // unless the GoTrue failure is 401, 403, 404 or session-missing. A 5xx or a
  // network blip therefore leaves the cookies intact — and an intact cookie is
  // a session that still authenticates:
  //
  //   /turno-vencido → /iniciar-sesion?motivo=turno → that page's getUser
  //   succeeds → redirect(pathForRole(role)) → the portal layout guard →
  //   SHIFT_EXPIRED → /turno-vencido → …  ERR_TOO_MANY_REDIRECTS
  //
  // which is the 2026-07-04 incident, reconstructed out of the failure mode of
  // the fix for it. A guard that refuses without ending the session does not end
  // the session — including when it TRIED to end the session and could not.
  //
  // So the failure arm is TERMINAL: this response, no redirect, nothing further
  // to route. And the copy says what is true — the session is still open — since
  // an operator who walks away from a shared desk believing they are signed out
  // is a worse outcome than a page that admits it failed.
  if (error) {
    return shiftSignOutFailedResponse();
  }

  redirect("/iniciar-sesion?motivo=turno");
}

/**
 * Is this caller's operator shift over — by EITHER of the two predicates the
 * product applies?
 *
 * This is the re-derivation the header's CSRF argument rests on, and it has to
 * cover both halves or the argument protects a route that cannot serve the
 * caller it was written for.
 *
 *   · REFUSED CALLER — `requireLiveUser` already said SHIFT_EXPIRED. That is the
 *     institutional principal (accountType `institutional`, or role `govt` /
 *     `admin`), and its refusal is taken verbatim. MAINTENANCE, NO_SESSION,
 *     ACCOUNT_ERASED and DEACTIVATED are NOT shifts and answer `false`: each has
 *     its own destination and its own copy, and none of them is fixed by signing
 *     in again.
 *
 *   · LIVE CALLER, ORG STAFF — the principal `requireLiveUser` structurally
 *     cannot refuse. An org staffer may hold a PERSONAL profile, so the
 *     institutional predicate never fires for them; the org capability path
 *     applies the shift to them instead. Membership is checked FIRST: it is what
 *     narrows "an old session" to "an OPERATOR's old session" (see the header),
 *     and asking `isOperatorShiftExpired` first would fire its fail-open report
 *     for every citizen who ever loads this URL, filling an operator log with
 *     anomalies about people who are not operators.
 *
 * NARROWER THAN `resolveLiveActor` ON PURPOSE, and the gap is not a hole. That
 * function applies the shift to any live caller of an org surface, membership or
 * not, so a NON-MEMBER with an old session can be told SHIFT_EXPIRED there and
 * arrive here to be bounced to `/` with cookies intact. That is the right
 * outcome twice over: the org path refuses them for NO_MEMBERSHIP regardless, so
 * there is no operator session to end — and widening this predicate to match
 * would hand every long-lived citizen session back to the cross-site logout the
 * membership leg exists to prevent.
 */
async function isShiftOver(live: LiveUserResult): Promise<boolean> {
  if (!live.ok) return live.reason === "SHIFT_EXPIRED";

  const memberships = await getActiveMemberships(live.user.id);
  if (memberships.length === 0) return false;

  return isOperatorShiftExpired({
    sessionStartedAt: live.sessionStartedAt,
    context: "turno-vencido",
  });
}

/**
 * The terminal answer when GoTrue would not end the session.
 *
 * Hand-written HTML rather than a page, because a page is a destination and a
 * destination is a redirect: every additional hop is another layout guard that
 * can bounce this caller, and bouncing this caller is the defect. 503 because
 * that is what happened — an upstream we depend on did not answer — and
 * `no-store` so a shared browser cannot show this to the next person at the desk.
 *
 * The retry link points back HERE. That is safe for the same structural reason
 * the GET itself is: the handler re-derives the policy — both predicates, see
 * `isShiftOver` — and signs out only a session that policy independently reports
 * as past its shift.
 */
function shiftSignOutFailedResponse(): Response {
  const html = `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>No pudimos cerrar tu sesión</title>
</head>
<body style="font-family:system-ui,sans-serif;margin:0;padding:2rem;line-height:1.5;color:#111827;background:#f7f7f5">
<main style="max-width:34rem;margin:0 auto">
<h1 style="font-size:1.25rem;margin:0 0 .75rem">No pudimos cerrar tu sesión</h1>
<p style="margin:0 0 .75rem">Tu turno de trabajo terminó, pero el servidor de autenticación no respondió, así que <strong>tu sesión sigue abierta</strong>.</p>
<p style="margin:0 0 1.25rem">No dejes la computadora así. Volvé a intentar en unos segundos; si sigue fallando, avisá a la persona a cargo del equipo.</p>
<p style="margin:0"><a href="/turno-vencido" style="color:#1d4ed8">Volver a intentar</a></p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
