// Notificaciones — Libreta Nacional redesign.
// Presentation only; all data fetching, grouping logic, and actions unchanged.
// Category tabs use Link-based server navigation (no client Tabs component).

import Link from "next/link";
import { Suspense } from "react";

import { markAllNotificationsReadAction } from "@/app/actions/notifications";
import { NotificationCard } from "@/components/NotificationCard";
import { LnButton } from "@/components/ui/Button";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { type UrlTabItem, UrlTabs } from "@/components/ui/UrlTabs";
import {
  fetchNotificationCategoryCounts,
  fetchUnreadNotificationCount,
} from "@/lib/analytics/owner-dashboard";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { decodeCursor, newerHref, olderHref } from "@/lib/utils/keyset-pagination";
import { listNotificationsForUser } from "@/src/modules/notifications/application/read/list-notifications-for-user";
import { MY_NOTIFICATIONS_PAGE_LIMIT } from "@dim/contract/api";

import { groupNotifications, sortNotificationsForDisplay } from "./notification-ordering";

// Ordering + grouping logic lives in ./notification-ordering (pure + unit
// tested): severity-first display sort, then same-pet+type collapse.

// ---------------------------------------------------------------------------
// Category definitions
// ---------------------------------------------------------------------------

type Category = "all" | "perdidas" | "health" | "custody" | "adoption" | "welfare" | "admin";

const CATEGORY_LABELS: Record<Category, string> = {
  all: "Todas",
  perdidas: "Pérdidas",
  health: "Salud",
  custody: "Custodia",
  adoption: "Adopciones",
  welfare: "Denuncias",
  admin: "Sistema",
};

const EMPTY_CATEGORY_TITLES: Record<Category, string> = {
  all: "Sin notificaciones",
  perdidas: "Sin avistajes ni reportes de mascotas perdidas",
  health: "Sin notificaciones de salud",
  custody: "Sin notificaciones de custodia",
  adoption: "Sin notificaciones de adopciones",
  welfare: "Sin notificaciones de denuncias",
  admin: "Sin notificaciones de sistema",
};

const EMPTY_CATEGORY_DESCRIPTIONS: Partial<Record<Category, string>> = {
  perdidas: "Te avisamos acá cuando alguien reporte un avistaje de tus mascotas perdidas.",
};

const CATEGORY_ORDER: Category[] = [
  "all",
  "perdidas",
  "custody",
  "health",
  "adoption",
  "welfare",
  "admin",
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function NotificacionesPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; cursor?: string }>;
}) {
  const { user } = await requireUserOrRedirect();
  const { cat, cursor: rawCursor } = await searchParams;

  const activeCat: Category =
    cat && ["all", "perdidas", "health", "custody", "adoption", "welfare", "admin"].includes(cat)
      ? (cat as Category)
      : "all";

  // Keyset cursor — null means first page.
  const cursor = decodeCursor(rawCursor);

  const counts = await fetchNotificationCategoryCounts(user.id);

  const countByCategory: Record<Category, number> = {
    all: counts.all,
    perdidas: counts.perdidas,
    health: counts.health,
    custody: counts.custody,
    adoption: counts.adoption,
    welfare: counts.welfare,
    admin: counts.admin,
  };

  const visibleCategories = CATEGORY_ORDER.filter((c) => c === "all" || countByCategory[c] > 0);

  // THE QUERY IS NOT HERE ANY MORE. `listNotificationsForUser` owns the four
  // clauses that decide what "in the inbox" means (own rows, not archived, minus
  // the two read-time reconciliations, optionally one category) and it is the
  // same function `GET /api/v1/me/notifications` calls. It moved out of this page
  // in WU-Q-1 for the reason `listOwnerPets` moved out of /mis-mascotas: a route
  // handler with its own copy of that predicate is how the native list eventually
  // shows a row this one does not.
  const { rows, hasMore } = await listNotificationsForUser({
    userId: user.id,
    category: activeCat === "all" ? null : activeCat,
    // Maximum notifications rendered per page (PERF-5 keyset pagination); the
    // reader fetches LIMIT+1 to detect hasMore and renders only LIMIT rows.
    //
    // IMPORTED, not re-declared. Grouping is PAGE-SCOPED — a group is only
    // correct over the rows its reader can see — so the moment this page and
    // `/api/v1/me/notifications` size their pages differently, a run of three
    // straddling a boundary collapses on one client and stays three singles on
    // the other. The two literals agreed by inspection until now, under a
    // comment in the contract asserting they were the same number.
    limit: MY_NOTIFICATIONS_PAGE_LIMIT,
    cursor,
  });

  // Build filter params map (cursor excluded — it's managed by pagination links).
  const filterParams: Record<string, string | undefined> =
    activeCat !== "all" ? { cat: activeCat } : {};

  // Last row drives the "older" cursor.
  const lastRow = rows.at(-1);
  const olderLink =
    hasMore && lastRow
      ? olderHref("/notificaciones", filterParams, {
          ts: lastRow.notification.createdAt,
          id: lastRow.notification.id,
        })
      : null;
  // "Back to page 1" link — only shown when we're not already on page 1.
  const newerLink = rawCursor ? newerHref("/notificaciones", filterParams) : null;

  // Unread count MUST span ALL non-archived rows for the active view, not just
  // the current page (review C.3). The old `rows.filter(...)` counted over the
  // ≤100-row page, so an owner with more than a page of unread notifications
  // (e.g. an org admin after a lost-pet broadcast fan-out) saw an understated
  // "N sin leer" — a first-hand "notifications say fewer than there are"
  // symptom. The helper aggregates with the same predicate the category counts
  // use.
  const unreadCount = await fetchUnreadNotificationCount(
    user.id,
    activeCat !== "all" ? activeCat : undefined,
  );
  // "en total" pairs with the unread figure, so it must also be the view-wide
  // total (not the current page's row count) or the two would be incoherent.
  const totalCount = activeCat === "all" ? counts.all : countByCategory[activeCat];
  // Severity-first display order (urgent → warning → success → info), then
  // recency — applied to the fetched page, then grouped. The keyset cursor is
  // still derived from the SQL (chronological) order's last row above, so this
  // reordering must NOT mutate `rows` (sortNotificationsForDisplay returns a
  // copy). Trade-off: page composition stays chronological (an urgent item on a
  // later page does not jump to page 1); within a page, urgent floats to top.
  const groups = groupNotifications(sortNotificationsForDisplay(rows));

  const tabItems: UrlTabItem[] = visibleCategories.map((c) => ({
    value: c,
    label: CATEGORY_LABELS[c],
    badge: countByCategory[c],
    badgeTone: "neutral",
  }));

  // List + pagination — rendered once, then shown either inside the category
  // tab bar (UrlTabs) or bare when there is only one populated category.
  const listBody = (
    <>
      {rows.length === 0 ? (
        <LnEmptyState
          title={EMPTY_CATEGORY_TITLES[activeCat]}
          description={
            EMPTY_CATEGORY_DESCRIPTIONS[activeCat] ??
            "Tu bandeja está vacía. Te avisaremos por acá cuando haya algo nuevo."
          }
          // Passive surface — nothing to "create" here, but a dead end is still
          // a dead end (copy audit 2026-08-04, S8). Point the owner back at
          // their pets instead of leaving them on an empty inbox with nowhere
          // to go.
          action={
            <LnButton href="/mis-mascotas" variant="ghost" size="sm">
              Ver mis mascotas
            </LnButton>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {groups.map((entry) => {
            if (entry.kind === "single") {
              return (
                <li key={entry.row.notification.id}>
                  <NotificationCard
                    notification={entry.row.notification}
                    relatedPet={entry.row.pet}
                  />
                </li>
              );
            }
            return (
              <li key={entry.leader.notification.id}>
                <NotificationCard
                  notification={entry.leader.notification}
                  relatedPet={entry.leader.pet}
                />
                <details className="mt-2 ml-3 border-l-2 border-[var(--color-ln-line)] pl-3">
                  <summary className="cursor-pointer font-ln-mono text-sm text-[var(--color-ln-azul)] select-none hover:underline">
                    + {entry.rest.length} más del mismo tipo
                  </summary>
                  <ul className="mt-2.5 flex flex-col gap-2">
                    {entry.rest.map(({ notification, pet }) => (
                      <li key={notification.id}>
                        <NotificationCard notification={notification} relatedPet={pet} />
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            );
          })}
        </ul>
      )}

      {/* Pagination footer — only shown when there are rows */}
      {(newerLink || olderLink) && (
        <nav
          aria-label="Paginación de notificaciones"
          className="mt-7 flex items-center justify-between gap-4 border-t border-[var(--color-ln-line)] pt-5"
        >
          <div>
            {newerLink && (
              <Link
                href={newerLink}
                className="font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
              >
                ← Más recientes
              </Link>
            )}
          </div>
          <div>
            {olderLink && (
              <Link
                href={olderLink}
                className="font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
              >
                Ver más antiguos →
              </Link>
            )}
          </div>
        </nav>
      )}
    </>
  );

  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      {/* Header */}
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
            Notificaciones
          </h1>
          <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
            {counts.all === 0
              ? "Sin notificaciones."
              : unreadCount > 0
                ? `${unreadCount} sin leer · ${totalCount} en total`
                : `${totalCount} en total`}
          </p>
        </div>
        {unreadCount > 0 && (
          <Suspense>
            <form action={markAllNotificationsReadAction} className="flex-shrink-0 mt-1.5">
              <LnButton type="submit" variant="ghost" size="sm">
                Marcar todas como leídas
              </LnButton>
            </form>
          </Suspense>
        )}
      </div>

      {/* Category tabs — canonical UrlTabs (APG keyboard nav) when more than one
          category is populated; otherwise the list stands alone. */}
      {visibleCategories.length > 1 ? (
        <UrlTabs
          paramKey="cat"
          defaultValue="all"
          tabs={tabItems}
          aria-label="Filtrar notificaciones por categoría"
        >
          <div className="mt-6">{listBody}</div>
        </UrlTabs>
      ) : (
        listBody
      )}
    </div>
  );
}
