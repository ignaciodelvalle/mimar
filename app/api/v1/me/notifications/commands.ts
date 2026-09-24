// The three inbox commands, and the read the hub is built from.
//
// THE THREE ARE THE WEB'S THREE — mark read, mark all read, archive — and there
// is deliberately no fourth. A phone that could delete a notification, or mark
// one UNread, would be doing something no browser can, which is not parity in the
// direction this programme measures. `@dim/contract/input`'s `notification.ts`
// states it where a client reads it.
//
// THERE IS NO REFUSAL TABLE HERE, and its absence is worth a paragraph because
// every sibling command file on this surface has one. `me/transfers` and
// `me/caretaker-grants` translate es-AR prose out of `UseCaseResult`'s untyped
// failure arm (api-invariants.md §3); these three use-cases have no failure arm
// at all. They are UPDATEs scoped to the caller's own rows, and the only two
// outcomes are "n rows changed" and "the database was unreachable" — the latter
// throwing, and answered as a 503 like every other degraded call on this surface.
//
// WHICH MEANS AN UNKNOWN ID IS A 200, NOT A 404, and that is a decision rather
// than laziness. An id belonging to somebody else and an id belonging to nobody
// change the same number of rows — zero — and answering differently would make
// this endpoint an oracle over other people's notification ids. `changed: false`
// is the honest answer to both, and it is the same answer the web gives (its form
// posts, revalidates, and the row is simply not there).

import {
  fetchNotificationCategoryCounts,
  fetchUnreadNotificationCount,
} from "@/lib/analytics/owner-dashboard";
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import {
  archiveNotification,
  markAllNotificationsRead,
  markNotificationsRead,
} from "@/src/modules/notifications/application/notification-actions";
import {
  MY_NOTIFICATIONS_PAGE_LIMIT,
  type NotificationCategoryV1,
  type NotificationCommandAckV1,
} from "@dim/contract/api";
import type { NotificationCommandInput } from "@dim/contract/input";

import { listNotificationsForUser } from "@/src/modules/notifications/application/read/list-notifications-for-user";

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * The reads this endpoint makes: one page of the inbox plus the two aggregates.
 *
 * LONGER THAN THE AUTH BUDGET because a hundred-row page joined against `pets`,
 * plus two grouped counts over the same predicate, is a real workload — and
 * shorter than a spinner, so a degraded pooler produces a 503 rather than a
 * screen that never resolves.
 *
 * THE WRITES ARE DELIBERATELY OUTSIDE ANY BUDGET, for the reason
 * `shares/commands.ts` and `caretaker-grants/commands.ts` both record:
 * `withDbBudgetOrThrow` races a promise against a timer and rejects, which does
 * not abort a Postgres statement. Wrapping a write would produce a 503 for a
 * mutation that then COMMITS, and the client would redraw an unread badge for
 * rows that are already read.
 */
const READ_BUDGET_MS = 8_000;

/** The 503 this endpoint answers for every degraded read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

export type InboxRead = {
  rows: Awaited<ReturnType<typeof listNotificationsForUser>>["rows"];
  countsByCategory: Record<NotificationCategoryV1, number>;
  unreadCount: number;
  total: number;
};

/**
 * The hub read, budgeted. Exported so the route reads nothing itself.
 *
 * STATICALLY IMPORTED, deliberately — a per-call `await import()` of a module the
 * suite mocks silently drops one of two concurrent callers in vitest, a defect
 * this repo has already paid for once.
 *
 * THE THREE QUERIES RUN CONCURRENTLY and share one budget. They are independent
 * reads over the same predicate, and running them in series would make the
 * endpoint's latency the sum of three round trips on the screen a person opens
 * first after a push.
 */
export async function readInbox(args: {
  userId: string;
  category: NotificationCategoryV1 | null;
}): Promise<InboxRead> {
  const [page, counts, unreadCount] = await withDbBudgetOrThrow(
    Promise.all([
      listNotificationsForUser({
        userId: args.userId,
        category: args.category,
        limit: MY_NOTIFICATIONS_PAGE_LIMIT,
      }),
      fetchNotificationCategoryCounts(args.userId),
      fetchUnreadNotificationCount(args.userId, args.category ?? undefined),
    ]),
    READ_BUDGET_MS,
    "api-v1-me-notifications-read",
  );

  const countsByCategory: Record<NotificationCategoryV1, number> = {
    perdidas: counts.perdidas,
    custody: counts.custody,
    health: counts.health,
    adoption: counts.adoption,
    welfare: counts.welfare,
    admin: counts.admin,
  };

  return {
    rows: page.rows,
    countsByCategory,
    unreadCount,
    // THE VIEW'S TOTAL, not the whole inbox's. `truncated` is derived from it, so
    // a filtered read has to compare its page against its own category's count or
    // a phone showing all four `custody` rows would be told the list is
    // incomplete. `counts.all` is the unfiltered figure and includes rows with no
    // category at all, which is what the web's "en total" shows.
    total: args.category === null ? counts.all : countsByCategory[args.category],
  };
}

/**
 * Run one command, then re-read the unread count so the client can correct its
 * badge without a second round trip.
 *
 * THE RE-READ IS AFTER THE WRITE AND IS NOT INSIDE IT. There is no transaction
 * here and there does not need to be: the number is a badge, the write already
 * committed, and a count that raced another tab by a few milliseconds is a badge
 * that is briefly one off — not a row in the wrong state. Making it exact would
 * mean holding a transaction open across an aggregate over the caller's whole
 * inbox, which is a real cost for a cosmetic guarantee.
 */
export async function runNotificationCommand(ctx: {
  userId: string;
  input: NotificationCommandInput;
}) {
  let changed: number;
  switch (ctx.input.command) {
    case "mark_read":
      ({ changed } = await markNotificationsRead(ctx.userId, ctx.input.notificationIds));
      break;
    case "mark_all_read":
      ({ changed } = await markAllNotificationsRead(ctx.userId));
      break;
    case "archive":
      ({ changed } = await archiveNotification(ctx.userId, ctx.input.notificationId));
      break;
  }

  let unreadCount: number | null;
  try {
    unreadCount = await withDbBudgetOrThrow(
      fetchUnreadNotificationCount(ctx.userId),
      READ_BUDGET_MS,
      "api-v1-me-notifications-unread",
    );
  } catch (err) {
    // NOT a 503, and not a sentinel number either. The write already COMMITTED;
    // reporting a failure would have the client retry a mutation that landed —
    // for `archive`, on a row it can no longer see. So the command succeeds and
    // the badge comes back as `null`, which the contract defines as "your tap
    // worked, the count is stale until the next refresh".
    if (!(err instanceof DbBudgetExceededError)) throw err;
    unreadCount = null;
  }

  const body: NotificationCommandAckV1 = {
    command: ctx.input.command,
    changed: changed > 0,
    unreadCount,
  };
  return apiV1Json(body, { status: 200 });
}
