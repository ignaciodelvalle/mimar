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
// GET WITHOUT SIDE EFFECTS. It does not mark the row read: a link prefetch or a
// crawler following it must not change somebody's inbox.

import { NextResponse } from "next/server";

import { caseViewerFromProfile } from "@/lib/infra/case-read";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { requireLiveUser } from "@/lib/infra/live-user";
import { reportError } from "@/lib/infra/report-error";
import { resolveOwnNotificationTarget } from "@/src/modules/notifications/infrastructure/notification-target-probes";
import { notificationExplanationWebPath, notificationOpenWebPath } from "@dim/contract/api";

export const dynamic = "force-dynamic";

const RESOLVE_BUDGET_MS = 8_000;

function to(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url));
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ notificationId: string }> },
) {
  const { notificationId } = await params;

  const live = await requireLiveUser();
  if (!live.ok) {
    switch (live.reason) {
      case "MAINTENANCE":
        return to(request, "/mantenimiento");
      case "SHIFT_EXPIRED":
        return to(request, "/turno-vencido");
      case "NO_SESSION":
        return to(
          request,
          `/iniciar-sesion?returnTo=${encodeURIComponent(notificationOpenWebPath(notificationId))}`,
        );
      case "DEACTIVATED":
        // Reads stay open for a deactivated account (auth-guards.ts); the
        // explanation page is a read and resolves through the tolerant guard.
        return to(request, notificationExplanationWebPath(notificationId));
      default:
        return to(request, "/iniciar-sesion");
    }
  }
  if (!live.profile) return to(request, "/notificaciones");
  const profile = live.profile;

  let target: Awaited<ReturnType<typeof resolveOwnNotificationTarget>> = null;
  try {
    target = await withDbBudgetOrThrow(
      (async () => {
        const viewer = await caseViewerFromProfile(profile);
        return viewer ? resolveOwnNotificationTarget(notificationId, viewer) : null;
      })(),
      RESOLVE_BUDGET_MS,
      "notification-open-resolve",
    );
  } catch (err) {
    // A degraded pooler (or a defect): the explanation page retries the same
    // resolution and renders its own degraded state, which is still not a 404.
    if (!(err instanceof DbBudgetExceededError)) reportError("notification-open", err);
    return to(request, notificationExplanationWebPath(notificationId));
  }

  // Not the caller's notification (or not one at all): the inbox, not a 404.
  if (target === null) return to(request, "/notificaciones");
  return to(request, target.webHref);
}
