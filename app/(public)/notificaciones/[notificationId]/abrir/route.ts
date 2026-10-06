// GET /notificaciones/{notificationId}/abrir — the door every web notification
// CTA goes through (notificaciones-destinos, 2026-10).
//
// The card used to link the stored `cta_url` straight. That string was chosen
// by the writer at send time and never re-read, so a transfer accepted, a
// membership ended or a custody episode closed turned it into a link to
// `notFound()`. This route asks `resolveNotificationTarget` — the same rule
// `GET /api/v1/me/notifications/{id}/target` answers the app with — and
// redirects to wherever the viewer can actually go: the case, the pet, a
// section, or `/notificaciones/{id}`, which explains why the destination is
// gone and who has to act. It never redirects to a 404.
//
// SAME ORIGIN, ALWAYS (security review S1): every redirect goes through
// `sameOriginRedirect`, so a stored `/\t/evil.com` or `/\evil.com` lands on the
// explanation page. An `external` outcome is never a redirect either: the
// explanation page shows the outside link as a link.
//
// LIVES IN `(public)`, not `(app)`: the `(app)` layout bounces admin and govt
// accounts to their portals, and operators receive notifications too. The
// session check is this file's own.
//
// GET WITHOUT SIDE EFFECTS. It does not mark the row read: a link prefetch or a
// crawler following it must not change somebody's inbox.

import { notificationTargetPorts } from "@/app/_composition/notification-target-ports";
import { caseViewerFromProfile } from "@/lib/infra/case-read";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserResult, requireLiveUser } from "@/lib/infra/live-user";
import { reportError } from "@/lib/infra/report-error";
import { sameOriginRedirect } from "@/lib/infra/same-origin-redirect";
import { FIRST_ACCESS_PATH } from "@/src/modules/auth/domain/first-access";
import { MFA_CHALLENGE_PATH, MFA_ENROL_PATH } from "@/src/modules/auth/domain/mfa-policy";
import { resolveOwnNotificationTarget } from "@/src/modules/notifications/infrastructure/notification-target-probes";
import { notificationExplanationWebPath, notificationOpenWebPath } from "@dim/contract/api";

export const dynamic = "force-dynamic";

const RESOLVE_BUDGET_MS = 8_000;

/**
 * Where a refused session goes, mirroring `requireUserOrRedirect`
 * (lib/infra/auth-guards.ts) branch for branch — first access and the second
 * factor BEFORE the login bounce, or the login page sends the person straight
 * back here in a loop (code review R1). Not imported from auth-guards: that
 * module reads a middleware-stamped header, which a route handler may not reach
 * (check-api-guard-headers).
 */
function refusalPath(live: Extract<LiveUserResult, { ok: false }>, notificationId: string): string {
  const returnTo = notificationOpenWebPath(notificationId);
  if (live.reason === "MAINTENANCE") return "/mantenimiento";
  if (live.passwordSetupPending) return FIRST_ACCESS_PATH;
  if (live.mfaPending) {
    const base = live.mfaPending === "enrol" ? MFA_ENROL_PATH : MFA_CHALLENGE_PATH;
    return `${base}?returnTo=${encodeURIComponent(returnTo)}`;
  }
  switch (live.reason) {
    case "NO_SESSION":
      return `/iniciar-sesion?returnTo=${encodeURIComponent(returnTo)}`;
    case "SHIFT_EXPIRED":
      return "/turno-vencido";
    case "DEACTIVATED":
      // Reads stay open for a deactivated account (auth-guards.ts); the
      // explanation page is a read and resolves through the tolerant guard.
      return notificationExplanationWebPath(notificationId);
    default:
      return "/iniciar-sesion";
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ notificationId: string }> },
) {
  const { notificationId } = await params;
  const explanation = notificationExplanationWebPath(notificationId);

  const live = await requireLiveUser();
  if (!live.ok) {
    return sameOriginRedirect(request, refusalPath(live, notificationId), "/iniciar-sesion");
  }
  if (!live.profile) return sameOriginRedirect(request, "/notificaciones", "/notificaciones");
  const profile = live.profile;

  let target: Awaited<ReturnType<typeof resolveOwnNotificationTarget>> = null;
  try {
    target = await withDbBudgetOrThrow(
      (async () => {
        const viewer = await caseViewerFromProfile(profile);
        return viewer
          ? resolveOwnNotificationTarget(notificationId, viewer, notificationTargetPorts)
          : null;
      })(),
      RESOLVE_BUDGET_MS,
      "notification-open-resolve",
    );
  } catch (err) {
    // A degraded pooler (or a defect): the explanation page retries the same
    // resolution and renders its own degraded state, which is still not a 404.
    if (!(err instanceof DbBudgetExceededError)) reportError("notification-open", err);
    return sameOriginRedirect(request, explanation, "/notificaciones");
  }

  // Not the caller's notification (or not one at all): the inbox, not a 404.
  if (target === null) return sameOriginRedirect(request, "/notificaciones", "/notificaciones");
  // An outside link is shown on the explanation page, never redirected to.
  if (target.outcome === "external") {
    return sameOriginRedirect(request, explanation, "/notificaciones");
  }
  return sameOriginRedirect(request, target.webHref, explanation);
}
