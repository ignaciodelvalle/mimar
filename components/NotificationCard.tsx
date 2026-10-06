import Link from "next/link";

import { archiveNotificationAction, markNotificationReadAction } from "@/app/actions/notifications";
import { NotificationQuickReply } from "@/components/NotificationQuickReply";
import { isQuickReplyEligible } from "@/components/notification-quick-reply-eligibility";
import type { Notification, Pet } from "@/db";
import { petLinkAvailable } from "@/lib/domain/notification-pet-link";
import { notificationSeverityLabel, notificationTypeLabel, relativeTime } from "@/lib/utils/format";
import { notificationOpenWebPath } from "@dim/contract/api";
import {
  isErasedNotification,
  isSafeExternalUrl,
  notificationKindSpec,
} from "@dim/contract/notifications";

// Shared notification card. Used by /notificaciones (full list) and
// /inicio (dashboard widget, top 5 unread). Server component because
// the action bindings happen via form action — no client hydration.
//
// Variants: unread vs read (colored border + bg vs neutral). Severity
// drives the left bar color (info/warning/urgent/success).
//
// Quick-reply island (capture-console surface #4): for an explicit
// allowlist of actionable types (isQuickReplyEligible), mounts the ONE
// client bit — NotificationQuickReply — below the existing CTA row. The
// full ctaUrl button above is untouched and stays as the direct fallback
// (works even if the owner's free text doesn't match anything).

/**
 * The denylist, RE-EXPORTED. It moved to `lib/domain/notification-pet-link.ts`
 * in WU-Q-1 because `app/api/v1/me/notifications` has to answer the same
 * question for the native inbox, and a route handler should not import a React
 * component to reach a constant. The reasoning — including the ownership check
 * that looked principled and was wrong — travelled with it.
 */
export { PET_LINK_DEAD_FOR_RECIPIENT } from "@/lib/domain/notification-pet-link";

export function NotificationCard({
  notification,
  relatedPet,
}: {
  notification: Notification;
  relatedPet: Pet | null;
}) {
  const petLinkTarget = petLinkAvailable({
    notificationType: notification.notificationType,
    hasRelatedPet: relatedPet !== null,
  })
    ? relatedPet
    : null;
  const unread = !notification.readAt;
  const tone = severityClasses(notification.severity);
  const markRead = markNotificationReadAction.bind(null, notification.id);
  const archive = archiveNotificationAction.bind(null, notification.id);
  const cta = notificationCta(notification);
  const showQuickReply = isQuickReplyEligible(
    notification.notificationType,
    notification.relatedPetId,
    Boolean(relatedPet),
  );

  return (
    <article
      className={`border rounded-xl p-4 flex gap-3 transition-colors ${
        unread ? `${tone.unreadBg} ${tone.unreadBorder}` : "bg-ln-card  border-ln-line "
      }`}
    >
      <div className={`w-1 self-stretch rounded-full ${tone.bar}`} aria-hidden />
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5 min-w-0">
            <h3 className={`text-sm ${unread ? "font-semibold" : "font-medium"} text-ln-ink `}>
              {notification.title}
            </h3>
            <p className="text-sm uppercase tracking-wider text-ln-mute ">
              {notificationSeverityLabel(notification.severity)} {"·"}
              {notificationTypeLabel(notification.notificationType)}
            </p>
          </div>
          <time className="text-xs text-ln-mute  shrink-0">
            {relativeTime(notification.createdAt)}
          </time>
        </div>

        {notification.body && (
          <p className="text-sm text-ln-ink-2  leading-relaxed">{notification.body}</p>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {cta && (
            <a
              href={cta.href}
              target={cta.external ? "_blank" : undefined}
              rel={cta.external ? "noopener noreferrer" : undefined}
              className="px-3 py-1.5 rounded-lg bg-ln-azul  text-white  text-xs font-medium hover:bg-ln-azul-700  transition-colors"
            >
              {cta.label}
              {cta.external && " ↗"}
            </a>
          )}
          {petLinkTarget && (
            <Link
              href={`/mis-mascotas/${petLinkTarget.publicToken}`}
              className="px-3 py-1.5 rounded-lg border border-ln-line-strong  text-xs text-ln-ink-2  hover:bg-ln-stripe  transition-colors"
            >
              Ver {petLinkTarget.name}
            </Link>
          )}
          {unread && (
            <form action={markRead}>
              <button
                type="submit"
                className="text-xs text-ln-ink-2  underline underline-offset-4 hover:text-ln-ink "
              >
                Marcar como leída
              </button>
            </form>
          )}
          <form action={archive}>
            <button
              type="submit"
              className="text-xs text-ln-mute  underline underline-offset-4 hover:text-ln-ink-2 "
            >
              Archivar
            </button>
          </form>
        </div>

        {showQuickReply && relatedPet && (
          <NotificationQuickReply
            petPublicToken={relatedPet.publicToken}
            reminderId={notification.relatedReminderId}
          />
        )}
      </div>
    </article>
  );
}

/**
 * The card's call to action (notificaciones-destinos, 2026-10).
 *
 * AN INTERNAL CTA GOES THROUGH `/notificaciones/{id}/abrir`, never straight to
 * the stored `cta_url`. That string was chosen when the notification was written
 * and is never re-read; the redirect asks the resolver where the reader can
 * actually go NOW — the case, the pet, a section, or the explanation page — so a
 * transfer accepted or a membership ended no longer turns the button into a
 * link to "no encontramos esta página".
 *
 * An EXTERNAL link keeps opening in a new tab: it is not ours to resolve.
 *
 * A row the writer gave NO CTA still gets "Ver detalle" when its kind leads
 * somewhere (the registry's `primaryDestination` is not `none`): the PO's rule
 * is that every notification takes its reader to the related case or pet.
 */
export function notificationCta(
  notification: Pick<Notification, "id" | "notificationType" | "title" | "ctaLabel" | "ctaUrl">,
): { href: string; label: string; external: boolean } | null {
  // An ERASED row (Ley 25.326 art. 16: `erase_subject_data` rewrites the title
  // to the sentinel and nulls both CTA columns) says nothing more: no button.
  if (isErasedNotification(notification)) return null;
  const { ctaLabel, ctaUrl } = notification;
  if (ctaLabel && ctaUrl) {
    // An outside link opens in a new tab as before — only a well-formed
    // http(s) one; anything else is not a link we hand out.
    if (!ctaUrl.startsWith("/")) {
      return isSafeExternalUrl(ctaUrl) ? { href: ctaUrl, label: ctaLabel, external: true } : null;
    }
    return { href: notificationOpenWebPath(notification.id), label: ctaLabel, external: false };
  }
  // Half a CTA is not a state a writer produces; it opens nothing.
  if (ctaLabel || ctaUrl) return null;
  const spec = notificationKindSpec(notification.notificationType);
  if (spec === null || spec.primaryDestination === "none") return null;
  return { href: notificationOpenWebPath(notification.id), label: "Ver detalle", external: false };
}

function severityClasses(severity: string) {
  switch (severity) {
    case "warning":
      return {
        bar: "bg-ln-warn",
        unreadBg: "bg-[var(--color-ln-warn-050)] ",
        unreadBorder: "border-ln-warn ",
      };
    case "urgent":
      return {
        bar: "bg-ln-err",
        unreadBg: "bg-[var(--color-ln-err-050)] ",
        unreadBorder: "border-ln-err ",
      };
    case "success":
      return {
        bar: "bg-ln-ok",
        unreadBg: "bg-[var(--color-ln-ok-050)] ",
        unreadBorder: "border-ln-ok ",
      };
    default:
      return {
        bar: "bg-ln-celeste",
        unreadBg: "bg-ln-celeste/10 ",
        unreadBorder: "border-ln-celeste ",
      };
  }
}
