// Notificaciones — turning the server's page into what a person reads, and what
// they tapped into what the contract accepts.
//
// PURE, like every other view-model in this app. It owns the es-AR sentence for
// every state and the mapping from a tap to a `NotificationCommandInput`.
// Nothing here touches the network.
//
// THE ORDER IS NOT DECIDED HERE, AND THAT IS THE POINT OF THIS WHOLE UNIT.
// `sortForDisplay` and `groupForDisplay` come from `@dim/contract/notifications`
// and are the SAME functions `app/(app)/notificaciones/page.tsx` calls. This file
// does not even hold a projection: the contract knows how to read its own wire
// row (`wireNotificationFacts`), so there is exactly one hand-written projection
// in the system — the web's, over its Drizzle row — and
// `__tests__/notification-ordering-parity.test.ts` pins the two together.
//
// A LIST THAT SORTED ITSELF WOULD BE THE FAILURE THIS EXISTS TO PREVENT: not a
// crash, not a wrong pixel, but the phone showing the same eight notifications in
// a different order from the browser — which nobody notices in review because
// each list reads perfectly well on its own.
//
// THE AFFORDANCES ARE THE SERVER'S TOO. `petLinkAvailable` and `cta.route` are
// both decided server-side and neither is derivable here: the first folds in a
// denylist of notification TYPES whose recipient no longer holds the animal (a
// screen that derived it from "is there a pet on this row" would offer a link to
// "No encontramos esta página"), and the second is a web path matched back
// through the deep-link table, which knows which destinations the app has screens
// for and which it does not.

import type {
  MyNotificationV1,
  MyNotificationsV1,
  NotificationCategoryV1,
} from "@dim/contract/api";
import type { NotificationCommandInput, NotificationCommandInputCode } from "@dim/contract/input";
import {
  firstNotificationCommandInputCode,
  notificationCommandInputSchema,
} from "@dim/contract/input";
import {
  type NotificationGroup,
  groupForDisplay,
  sortForDisplay,
  wireNotificationFacts,
} from "@dim/contract/notifications";

export type NotificationEntry = NotificationGroup<MyNotificationV1>;

/**
 * The page, in the order a person reads it, collapsed the way the web collapses
 * it.
 *
 * TWO CALLS AND NO THIRD STEP. The sort has to run BEFORE the grouping — the
 * group leader is the first row of its bucket in the incoming order, which is
 * what makes the collapsed card the highest-priority one rather than an arbitrary
 * one. The web does the same two calls in the same order on the same page size.
 */
export function notificationsForDisplay(payload: MyNotificationsV1): NotificationEntry[] {
  return groupForDisplay(
    sortForDisplay(payload.notifications, wireNotificationFacts),
    wireNotificationFacts,
  );
}

/** Every row of an entry, leader first — for "marcar como leídas" over a group. */
export function rowsOf(entry: NotificationEntry): MyNotificationV1[] {
  return entry.kind === "single" ? [entry.row] : [entry.leader, ...entry.rest];
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** The web's own six tab labels (`CATEGORY_LABELS`), minus the `all` pseudo-tab. */
const CATEGORY_LABELS: Record<NotificationCategoryV1, string> = {
  perdidas: "Pérdidas",
  custody: "Custodia",
  health: "Salud",
  adoption: "Adopciones",
  welfare: "Denuncias",
  admin: "Sistema",
};

export function categoryLabel(category: NotificationCategoryV1): string {
  return CATEGORY_LABELS[category];
}

/** The label of the unfiltered view. The web calls it "Todas". */
export const ALL_CATEGORIES_LABEL = "Todas";

/**
 * The web's four severity words (`notificationSeverityLabel`).
 *
 * A severity this build does not know falls through to the neutral word rather
 * than printing the raw enum at somebody. The rule that ORDERS it already has the
 * same posture — an unknown severity ranks as `info` — so the two agree.
 */
export function severityLabel(severity: string): string {
  switch (severity) {
    case "urgent":
      return "Urgente";
    case "warning":
      return "Atención";
    case "success":
      return "Listo";
    default:
      return "Info";
  }
}

/**
 * When it arrived, as a date.
 *
 * NOT THE WEB'S `relativeTime` ("hace 3 h"), and the difference is deliberate
 * rather than a shortfall. That helper lives in `lib/utils/format.ts` next to
 * `notificationTypeLabel`, a 50-odd entry map from notification type to Spanish;
 * neither is in the contract, and copying either into this app would be a second
 * list to keep in step — the exact failure `endpoints.ts` has two paragraphs
 * about. A date is a fact this file can compute correctly from the wire with
 * nothing borrowed, and the ROW ORDER already carries the recency that "hace 3 h"
 * is really communicating. If relative time earns its cost, it belongs in the
 * contract beside the ordering rule, where both clients would read one copy.
 *
 * THE TYPE LABEL IS SIMPLY NOT RENDERED HERE for the same reason. The card shows
 * severity and the title; the title is written by the notification's own writer
 * and already says what happened.
 */
export function notificationDateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "fecha desconocida";
  return date.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * The header line: how many are unread, out of how many.
 *
 * THE WEB'S THREE SHAPES, kept because they are three different facts: an empty
 * inbox, an inbox with unread rows, and an inbox that is fully read.
 */
export function inboxSummary(payload: MyNotificationsV1): string {
  if (payload.total === 0) return "Sin notificaciones.";
  if (payload.unreadCount > 0) return `${payload.unreadCount} sin leer · ${payload.total} en total`;
  return `${payload.total} en total`;
}

/**
 * What the list says when it is empty, per tab.
 *
 * THE WEB'S OWN SENTENCES (`EMPTY_CATEGORY_TITLES`). Seven of them rather than
 * one "no hay nada", because "you have no notifications at all" and "nobody has
 * reported seeing your lost dog" are different facts and the second is the one
 * somebody is on this screen for.
 */
export function emptyTitle(category: NotificationCategoryV1 | null): string {
  if (category === null) return "Sin notificaciones";
  switch (category) {
    case "perdidas":
      return "Sin avistajes ni reportes de mascotas perdidas";
    case "health":
      return "Sin notificaciones de salud";
    case "custody":
      return "Sin notificaciones de custodia";
    case "adoption":
      return "Sin notificaciones de adopciones";
    case "welfare":
      return "Sin notificaciones de denuncias";
    case "admin":
      return "Sin notificaciones de sistema";
  }
}

/**
 * The sentence UNDER the headline, and it may not repeat it (S-4).
 *
 * "Tu bandeja está vacía" was printed under every headline including
 * "Sin notificaciones de salud", which is the same claim twice — and on a
 * FILTERED tab it is also false: the inbox is not empty, this category is. A
 * person reading "sin notificaciones de salud / tu bandeja está vacía" with
 * eleven unread custody rows one tab away is being told something they can see
 * is untrue, on the screen whose whole job is telling them what happened.
 *
 * So the body says what the HEADLINE cannot: what will arrive here, and — on a
 * filter — that the other tabs are a different question.
 */
export function emptyBody(category: NotificationCategoryV1 | null): string {
  if (category === "perdidas") {
    return "Te avisamos acá cuando alguien reporte un avistaje de tus mascotas perdidas.";
  }
  if (category === null) return "Te avisamos por acá cuando haya algo nuevo.";
  return "Te avisamos por acá cuando haya algo nuevo en esta categoría. Las otras pueden tener novedades.";
}

/**
 * The note under a capped list.
 *
 * SAYS HOW MANY ARE MISSING AND WHERE THEY ARE. There is no cursor on this
 * surface and the web has one, so a phone that drew a complete-looking list would
 * be hiding the shortfall rather than having none — the shape `MyPetsV1` settled
 * on for the same gap.
 */
export function truncationNote(payload: MyNotificationsV1): string | null {
  if (!payload.truncated) return null;
  return `Estamos mostrando ${payload.notifications.length} de ${payload.total}. Todavía no hay paginado en la app: para ver el resto entrá desde la web.`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type CommandResult =
  | { ok: true; input: NotificationCommandInput }
  | { ok: false; message: string; code: NotificationCommandInputCode | null };

function validated(wire: unknown): CommandResult {
  const parsed = notificationCommandInputSchema.safeParse(wire);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstNotificationCommandInputCode(parsed.error);
  return { ok: false, code, message: notificationInputCodeMessage(code) };
}

/**
 * MARK ROWS READ. One or many — a group's rows go in one call.
 *
 * THE BATCH IS WHY THIS ENDPOINT HAS ITS OWN RATE-LIMIT FAMILY. Marking a
 * screenful one row at a time would spend one round trip per tap against a
 * per-user limiter, on the screen whose whole purpose is to be tapped through.
 */
export function buildMarkRead(notificationIds: readonly string[]): CommandResult {
  return validated({ command: "mark_read", notificationIds: [...notificationIds] });
}

/** MARK THE WHOLE INBOX READ. Not scoped to the visible tab — the web's is not either. */
export function buildMarkAllRead(): CommandResult {
  return validated({ command: "mark_all_read" });
}

/**
 * ARCHIVE ONE ROW. Singular on purpose: this is how a notification leaves the
 * inbox for good and there is no undo anywhere in this product.
 */
export function buildArchive(notificationId: string): CommandResult {
  return validated({ command: "archive", notificationId });
}

/** es-AR copy for each input code. Exhaustive: every code has a sentence. */
export function notificationInputCodeMessage(code: NotificationCommandInputCode | null): string {
  if (code === null) {
    // The parse failed on something the contract does not name — a client and a
    // contract out of step. Honest about being unable to say more.
    return "La app no pudo interpretar esa acción. Actualizá la pantalla y volvé a intentar.";
  }
  switch (code) {
    case "COMMAND_REQUIRED":
      return "La app no pudo armar la acción. Volvé a intentar.";
    case "NOTIFICATION_ID_REQUIRED":
    case "NOTIFICATION_IDS_REQUIRED":
      return "No pudimos identificar la notificación. Actualizá la pantalla y volvé a intentar.";
    case "TOO_MANY_NOTIFICATION_IDS":
      return "Son demasiadas de una vez. Actualizá la pantalla y volvé a intentar.";
  }
}
