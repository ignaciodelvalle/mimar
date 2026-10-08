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

import {
  type MyNotificationV1,
  type MyNotificationsV1,
  type NotificationCategoryV1,
  notificationExplanationAppRoute,
} from "@dim/contract/api";
import type { NotificationCommandInput, NotificationCommandInputCode } from "@dim/contract/input";
import {
  firstNotificationCommandInputCode,
  notificationCommandInputSchema,
} from "@dim/contract/input";
import {
  type NotificationGroup,
  groupForDisplay,
  isErasedNotification,
  notificationKindSpec,
  sortForDisplay,
  wireNotificationFacts,
} from "@dim/contract/notifications";

export type NotificationEntry = NotificationGroup<MyNotificationV1>;

/**
 * The row's "open" button (notificaciones-destinos, 2026-10): its label, and the
 * route it pushes — ALWAYS `aviso/{id}`, never the stored `cta.route`.
 *
 * `cta.route` was the stored web path matched against this build's deep-link
 * table, which answered two questions badly: whether the app has a screen (only
 * as well as the table bundled into THIS build) and whether the reader may still
 * open it (not at all — a transfer accepted since then is a 404). `aviso/{id}`
 * asks the server both, at tap time, and replaces itself with the answer.
 *
 * A row the writer gave no CTA still gets "Ver detalle" when its kind leads
 * somewhere; an informational kind (`primaryDestination: "none"`) with no CTA
 * gets nothing — its body is already everything it has to say.
 */
export function notificationOpenAction(
  notification: Pick<MyNotificationV1, "id" | "notificationType" | "cta" | "title">,
): { label: string; route: string } | null {
  // An ERASED row (Ley 25.326 art. 16) says nothing more: no button (R11).
  if (isErasedNotification(notification)) return null;
  // An outside CTA goes through `aviso` too: the server answers `external` with
  // the validated address and the screen opens it with Linking (R5).
  const route = notificationExplanationAppRoute(notification.id);
  if (notification.cta !== null) return { label: notification.cta.label, route };
  const spec = notificationKindSpec(notification.notificationType);
  if (spec === null || spec.primaryDestination === "none") return null;
  return { label: "Ver detalle", route };
}

/** The `origen` value that turns `aviso/{id}` into the inbox's detail screen. */
export const INBOX_DETAIL_ORIGIN = "bandeja";

/**
 * The route a ROW opens (pulido-avisos, 2026-10): the same `aviso/{id}` screen,
 * told it was opened from the inbox so it shows the notification instead of
 * jumping past it.
 *
 * THE ROW IS NOT THE CTA ANY MORE. A card carried the full body and four
 * buttons, so one and a half notifications fitted on a phone and, at font scale
 * 1.3, the first card's buttons fell below the fold. The row now reads; the
 * detail acts. Without `origen=bandeja` the screen keeps its push-tap behaviour
 * (resolve and replace itself), which is what a notification opened from the
 * lock screen wants.
 *
 * WHAT THE DETAIL CANNOT ASK THE SERVER FOR rides along as query parameters:
 * the CTA's label (the target read has no label of its own) and the pet link,
 * which `petLinkAvailable` decided server-side on the INBOX read. Query
 * parameters, not a module-level hand-off: they survive the process being
 * restored onto this screen, and the navigation breadcrumb records the PATH
 * only (`telemetryPath(pathname)`), so the pet's name never reaches telemetry.
 */
export function notificationDetailRoute(
  notification: Pick<
    MyNotificationV1,
    "id" | "notificationType" | "cta" | "title" | "pet" | "petLinkAvailable"
  >,
): string {
  const params: Array<[string, string]> = [["origen", INBOX_DETAIL_ORIGIN]];
  const open = notificationOpenAction(notification);
  if (open !== null) params.push(["accion", open.label]);
  if (notification.petLinkAvailable && notification.pet !== null) {
    params.push(["mascota", notification.pet.publicToken], ["nombre", notification.pet.name]);
  }
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `${notificationExplanationAppRoute(notification.id)}?${query}`;
}

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
 * When it arrived, as a date. Kept for the screen reader's label, where an
 * unambiguous date beats a relative one read out of context.
 */
export function notificationDateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "fecha desconocida";
  return date.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Argentina has kept UTC−3 all year since 2009; a calendar day is computed on it. */
const AR_OFFSET_MS = 3 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function arDayNumber(ms: number): number {
  return Math.floor((ms - AR_OFFSET_MS) / DAY_MS);
}

/**
 * When it arrived, relative to `now` — the compact row's date (PO, pulido-avisos
 * 2026-10: "la fecha relativa").
 *
 * THE WEB'S SHAPES (`relativeTime` in `lib/utils/format.ts`): "ahora",
 * "hace 12 min", "hace 3 h", "ayer", "hace 4 días", and the date itself past a
 * week — a "hace 5 sem" on an inbox is a number nobody acts on. The day steps
 * are ARGENTINE CALENDAR days, like the web's: 20:00 yesterday read at 10:00
 * today is "ayer", not "hace 14 h".
 *
 * A future instant (a phone whose clock runs behind the server) reads "ahora"
 * rather than "hace -3 min". `now` is a parameter so the rule is testable
 * without a fake clock.
 */
export function notificationRelativeDateLabel(iso: string, now: Date): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "fecha desconocida";
  const elapsed = now.getTime() - at;
  if (elapsed < MINUTE_MS) return "ahora";
  if (elapsed < HOUR_MS) return `hace ${Math.floor(elapsed / MINUTE_MS)} min`;
  const days = arDayNumber(now.getTime()) - arDayNumber(at);
  if (days <= 0) return `hace ${Math.floor(elapsed / HOUR_MS)} h`;
  if (days === 1) return "ayer";
  if (days < 7) return `hace ${days} días`;
  return notificationDateLabel(iso);
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
 * D5 — one page appended onto what is already on screen. `notifications` is
 * concatenated; every aggregate (`categories`, `unreadCount`, `total`,
 * `truncated`, `nextCursor`) comes from the NEW page, because those describe
 * the whole inbox (or whole category), not this page's own slice — summing
 * them across pages would double-count what the first page already reported.
 */
export function appendNotificationsPage(
  current: MyNotificationsV1,
  next: MyNotificationsV1,
): MyNotificationsV1 {
  return { ...next, notifications: [...current.notifications, ...next.notifications] };
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
