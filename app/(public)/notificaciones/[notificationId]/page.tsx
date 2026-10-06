// /notificaciones/{notificationId} — the explanation state (notificaciones-
// destinos, 2026-10).
//
// Where a notification lands when its case or pet is no longer something the
// reader can open: the transfer was accepted, the membership ended, the custody
// episode closed, or the notice simply has nothing behind it. Before this page
// those taps ended on `notFound()` — "información no disponible" with no reason
// and no next step. Here the reader gets the notification itself, the reason in
// words, and — when something is still pending — who has to act.
//
// LIVES IN `(public)` and not `(app)` (code review R2): the `(app)` layout
// bounces admin and govt accounts to their portals, and operators receive
// notifications too. The session check is this page's own.
//
// The sentences come from the server resolver (`resolveNotificationTarget`),
// built from `@dim/contract/notifications`' copy table, so the app's explanation
// screen prints exactly the same words.

import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { notificationTargetPorts } from "@/app/_composition/notification-target-ports";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { caseViewerFromProfile } from "@/lib/infra/case-read";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { NOTIFICATION_DOOR_READ_LIMIT } from "@/lib/infra/public-browse-limits";
import { isPublicTokenReadThrottled } from "@/lib/infra/public-token-throttle";
import { getProfileCached } from "@/lib/infra/request-cache";
import { resolveOwnNotificationTarget } from "@/src/modules/notifications/infrastructure/notification-target-probes";
import { notificationExplanationWebPath } from "@dim/contract/api";
import { isSafeExternalUrl, isSafeInternalPath } from "@dim/contract/notifications";

export const dynamic = "force-dynamic";

const RESOLVE_BUDGET_MS = 8_000;

const LINK_CLASS =
  "inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium transition-colors";

export default async function NotificationExplanationPage({
  params,
}: {
  params: Promise<{ notificationId: string }>;
}) {
  const { notificationId } = await params;
  // The limiter BEFORE the session read: the URL carries an identifier and this
  // page sits in `(public)`, so anybody can reach it, and `getUser()` is a
  // GoTrue round-trip. Number and derivation: lib/infra/public-browse-limits.ts.
  if (await isPublicTokenReadThrottled("notification_explanation", NOTIFICATION_DOOR_READ_LIMIT)) {
    return (
      <Shell>
        <p className="text-md text-[var(--color-ln-ink-2)]" data-section="notification-throttled">
          Recibimos muchas consultas desde tu conexión en poco tiempo. Esperá un minuto y volvé a
          intentarlo.
        </p>
      </Shell>
    );
  }
  const { user } = await requireUserOrRedirect(notificationExplanationWebPath(notificationId));
  const profile = await getProfileCached(user.id);
  if (!profile) redirect("/notificaciones");

  let target: Awaited<ReturnType<typeof resolveOwnNotificationTarget>>;
  try {
    target = await withDbBudgetOrThrow(
      (async () => {
        const viewer = await caseViewerFromProfile(profile);
        return viewer
          ? resolveOwnNotificationTarget(notificationId, viewer, notificationTargetPorts)
          : null;
      })(),
      RESOLVE_BUDGET_MS,
      "notification-explanation-resolve",
    );
  } catch (err) {
    if (!(err instanceof DbBudgetExceededError)) throw err;
    return (
      <Shell>
        <p className="text-md text-[var(--color-ln-ink-2)]">
          No pudimos cargar esta notificación ahora. Probá de nuevo en unos segundos.
        </p>
      </Shell>
    );
  }

  // Not the caller's notification: the inbox, never a 404.
  if (target === null) redirect("/notificaciones");

  // SAME ORIGIN OR NO LINK (security review S1): the resolver builds
  // same-origin paths, and this re-checks before anything becomes an href.
  const internalHref =
    target.outcome !== "explain" &&
    target.outcome !== "external" &&
    isSafeInternalPath(target.webHref)
      ? target.webHref
      : null;
  const externalHref =
    target.outcome === "external" && target.externalUrl && isSafeExternalUrl(target.externalUrl)
      ? target.externalUrl
      : null;

  return (
    <Shell>
      <article
        className="space-y-4 rounded-xl border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-5"
        data-section="notification-explanation"
        data-reason={target.reason}
      >
        <header className="space-y-1">
          <h1 className="m-0 font-ln-serif text-2xl font-semibold leading-tight text-[var(--color-ln-ink)]">
            {target.title}
          </h1>
          {target.body ? (
            <p className="text-md leading-relaxed text-[var(--color-ln-ink-2)]">{target.body}</p>
          ) : null}
        </header>

        {target.reasonCopy ? (
          <p className="text-md leading-relaxed text-[var(--color-ln-ink)]">{target.reasonCopy}</p>
        ) : null}

        {target.actorCopy ? (
          <p
            className="rounded-lg bg-[var(--color-ln-stripe)] px-3 py-2 text-md font-medium text-[var(--color-ln-ink)]"
            data-section="notification-actor"
          >
            {target.actorCopy}
          </p>
        ) : null}

        {internalHref ? (
          <Link
            href={internalHref}
            className={`${LINK_CLASS} bg-ln-azul text-white hover:bg-ln-azul-700`}
          >
            Abrir
          </Link>
        ) : null}

        {externalHref ? (
          <a
            href={externalHref}
            target="_blank"
            rel="noopener noreferrer"
            className={`${LINK_CLASS} bg-ln-azul text-white hover:bg-ln-azul-700`}
          >
            {target.externalLabel ?? "Abrir enlace"} ↗
          </a>
        ) : null}
      </article>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-8 py-7 pb-12">
      <Link
        href="/notificaciones"
        className="inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-mute)] no-underline hover:text-[var(--color-ln-ink-2)]"
      >
        ← Notificaciones
      </Link>
      {children}
    </div>
  );
}
