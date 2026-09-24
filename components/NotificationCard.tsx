import Link from "next/link";

import { archiveNotificationAction, markNotificationReadAction } from "@/app/actions/notifications";
import { NotificationQuickReply } from "@/components/NotificationQuickReply";
import { isQuickReplyEligible } from "@/components/notification-quick-reply-eligibility";
import type { Notification, Pet } from "@/db";
import { petLinkAvailable } from "@/lib/domain/notification-pet-link";
import { notificationSeverityLabel, notificationTypeLabel, relativeTime } from "@/lib/utils/format";

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
          {notification.ctaLabel && notification.ctaUrl && (
            <a
              href={notification.ctaUrl}
              target={notification.ctaUrl.startsWith("http") ? "_blank" : undefined}
              rel={notification.ctaUrl.startsWith("http") ? "noopener noreferrer" : undefined}
              className="px-3 py-1.5 rounded-lg bg-ln-azul  text-white  text-xs font-medium hover:bg-ln-azul-700  transition-colors"
            >
              {notification.ctaLabel}
              {notification.ctaUrl.startsWith("http") && " ↗"}
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
