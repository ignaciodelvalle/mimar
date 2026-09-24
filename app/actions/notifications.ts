"use server";

// notifications.ts — thin shim (strangler migration 59/61, 2026-06-30).
//
// Business logic lives in src/modules/notifications/application/notification-actions.ts.
// Each wrapper calls requireLiveUser() in its OWN body (the authz fence reads
// the export body, not its callees) and hands the use-case the userId.
//
// Until 2026-08-22 this file defined a local `requireUser()` — a bare
// auth.getUser() whose NAME was on the recognised-guard list, so the fence
// counted three unguarded writes as guarded. The marks are UPDATEs on the
// caller's own rows, so the write policy applies (lib/infra/auth-guards.ts:60-70):
// MAINTENANCE, NO_SESSION, ACCOUNT_ERASED and DEACTIVATED all refuse; a
// deactivated account keeps READING /notificaciones. Proof:
// __tests__/notifications-actions-liveness.test.ts; the fence now refuses any
// file that defines a guard's name (findShadowedGuardDefinitions).
//
// CRITICAL: Every runtime export in a "use server" file must be an async function.
//
// The three wrappers `await` their use-case and return `void` while the use-cases
// now return a changed-row count. That is not a value dropped by accident: these
// are FORM actions, React types one as `(formData) => void | Promise<void>`, and
// forwarding `Promise<{changed:number}>` would not be assignable. The count is
// for `POST /api/v1/me/notifications`; a browser has nowhere to put it.

import { requireLiveUser } from "@/lib/infra/live-user";
import {
  archiveNotification as _archiveNotification,
  markAllNotificationsRead as _markAllNotificationsRead,
  markNotificationRead as _markNotificationRead,
} from "@/src/modules/notifications/application/notification-actions";

export async function markNotificationReadAction(notificationId: string): Promise<void> {
  const live = await requireLiveUser();
  if (!live.ok) throw new Error(live.error);
  await _markNotificationRead(live.user.id, notificationId);
}

export async function archiveNotificationAction(notificationId: string): Promise<void> {
  const live = await requireLiveUser();
  if (!live.ok) throw new Error(live.error);
  await _archiveNotification(live.user.id, notificationId);
}

export async function markAllNotificationsReadAction(): Promise<void> {
  const live = await requireLiveUser();
  if (!live.ok) throw new Error(live.error);
  await _markAllNotificationsRead(live.user.id);
}
