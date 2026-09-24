// Integration tests for lib/infra/notification-service.ts — the canonical
// notification write path (consistency review 2026-07-04).
//
// Runs against the local Postgres directly. Provisions one throwaway user
// (notifications.user_id FKs profiles.id) and tears it down.
//
// Covers:
//   1. double-insert with the same dedupeKey → exactly one row (idempotency)
//   2. a forced insert failure → the payload is dead-lettered, not dropped
//   3. fetchUnreadNotificationCount spans ALL rows, not just a page (review C.3)

import { createClient } from "@supabase/supabase-js";
import { DrizzleQueryError, and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The Web Push leg is replaced with a spy so the suppressPush gate can be
// asserted directly (the real sender is inert in test env, which would hide
// whether it was even reached). createNotification imports ONLY
// sendPushForNotifications from this module.
vi.mock("@/lib/infra/web-push", () => ({
  sendPushForNotifications: vi.fn(async () => {}),
}));

import { db, notificationDeadLetter, notifications } from "@/db";
import { fetchUnreadNotificationCount } from "@/lib/analytics/owner-dashboard";
import { summarizeDeadLetterError } from "@/lib/infra/dead-letter-error-summary";
import { createNotification, createNotificationsBulk } from "@/lib/infra/notification-service";
import { sendPushForNotifications } from "@/lib/infra/web-push";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const EMAIL = "notification-service-test@dim-test.local";
const PASS = "NotifServiceTest_2026!";

let userId: string;

async function purge() {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === EMAIL);
  if (found) {
    await db.delete(notifications).where(eq(notifications.userId, found.id));
    await admin.auth.admin.deleteUser(found.id);
  }
}

beforeAll(async () => {
  await purge();
  const { data, error } = await createFreshTestUser(admin, {
    email: EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
});

afterAll(async () => {
  await db.delete(notifications).where(eq(notifications.userId, userId));
  await db.delete(notificationDeadLetter).where(eq(notificationDeadLetter.dedupeKey, DEDUPE_KEY));
  await db
    .delete(notificationDeadLetter)
    .where(eq(notificationDeadLetter.dedupeKey, DEAD_LETTER_KEY));
  await db
    .delete(notificationDeadLetter)
    .where(like(notificationDeadLetter.dedupeKey, `${PARAMS_KEY_PREFIX}%`));
  await admin.auth.admin.deleteUser(userId);
});

const DEDUPE_KEY = "test:notif-service:dedupe-1";
const DEAD_LETTER_KEY = "test:notif-service:dead-letter-1";
const PARAMS_KEY_PREFIX = "test:notif-service:dead-letter-params-";

describe("createNotification — idempotency", () => {
  it("collapses two inserts with the same dedupeKey into one row", async () => {
    const input = {
      userId,
      notificationType: "test_notification",
      title: "Prueba",
      body: "cuerpo",
      severity: "info" as const,
      category: "health",
      dedupeKey: DEDUPE_KEY,
    };

    const first = await createNotification({ ...input });
    expect(first.status).toBe("inserted");
    expect(first.id).not.toBeNull();

    const second = await createNotification({ ...input });
    expect(second.status).toBe("duplicate");
    expect(second.id).toBeNull();

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupeKey, DEDUPE_KEY));
    expect(rows).toHaveLength(1);
  });
});

describe("createNotification — durability (dead-letter)", () => {
  it("dead-letters the payload when the insert throws instead of dropping it", async () => {
    // A client whose insert chain throws at .returning() — simulates a
    // transient DB fault at flush time. The service's `client` param is
    // intentionally loose, so this structural stub is assignable.
    const throwingClient = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => {
              throw new Error("simulated insert failure");
            },
          }),
        }),
      }),
    };

    const result = await createNotification(
      {
        userId,
        notificationType: "test_notification",
        title: "Fallo",
        dedupeKey: DEAD_LETTER_KEY,
      },
      throwingClient,
    );

    expect(result.status).toBe("dead_lettered");
    expect(result.id).toBeNull();

    // No live notification was written…
    const live = await db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupeKey, DEAD_LETTER_KEY));
    expect(live).toHaveLength(0);

    // …but the payload is recoverable in the dead-letter table.
    const dead = await db
      .select()
      .from(notificationDeadLetter)
      .where(eq(notificationDeadLetter.dedupeKey, DEAD_LETTER_KEY));
    expect(dead).toHaveLength(1);
    expect(dead[0].errorMessage).toContain("simulated insert failure");
    expect((dead[0].payload as { userId: string }).userId).toBe(userId);
  });
});

describe("createNotification — suppressPush gate (RN-3 F5)", () => {
  const pushSpy = vi.mocked(sendPushForNotifications);

  it("pushes an urgent row by default (suppressPush absent)", async () => {
    pushSpy.mockClear();
    const result = await createNotification({
      userId,
      notificationType: "vaccine_due",
      title: "Vencida",
      severity: "urgent",
      category: "health",
      dedupeKey: "test:notif-service:push-on-1",
    });
    expect(result.status).toBe("inserted");
    expect(pushSpy, "an urgent row did not reach the push leg").toHaveBeenCalledTimes(1);
  });

  it("does NOT push when suppressPush is true — the in-app row is still written", async () => {
    pushSpy.mockClear();
    const result = await createNotification({
      userId,
      notificationType: "vaccine_due",
      title: "Vencida (re-emisión)",
      severity: "urgent",
      category: "health",
      dedupeKey: "test:notif-service:push-suppressed-1",
      suppressPush: true,
    });
    expect(result.status, "the in-app notification must still be written").toBe("inserted");
    expect(result.id).not.toBeNull();
    expect(pushSpy, "a suppressPush row still triggered a push").not.toHaveBeenCalled();

    // The row exists in-app (badge/inbox still see it).
    const [row] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupeKey, "test:notif-service:push-suppressed-1"))
      .limit(1);
    expect(row).toBeDefined();
  });
});

describe("fetchUnreadNotificationCount — spans all rows, not one page", () => {
  it("counts unread across more than a page (>100) of notifications", async () => {
    // Insert 105 unread notifications for the user (distinct dedupe keys).
    const values = Array.from({ length: 105 }, (_, i) => ({
      userId,
      notificationType: "test_bulk_unread",
      title: `n${i}`,
      severity: "info" as const,
      category: "custody",
      dedupeKey: `test:notif-service:unread-${i}`,
    }));
    await db.insert(notifications).values(values);

    const count = await fetchUnreadNotificationCount(userId, "custody");
    expect(count).toBe(105);

    // Scope-less count includes the health-category dedupe row from test 1 if it
    // still exists; assert it is at LEAST the 105 custody rows.
    const allUnread = await fetchUnreadNotificationCount(userId);
    expect(allUnread).toBeGreaterThanOrEqual(105);

    // Marking some read reduces the count.
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.notificationType, "test_bulk_unread"),
        ),
      );
    const afterRead = await fetchUnreadNotificationCount(userId, "custody");
    expect(afterRead).toBe(0);
  });
});

// A Postgres error as postgres.js raises it: the server's `detail` carries row
// values (a unique violation reads `Key (col)=(value)`), the identifiers do not.
function postgresError(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
    name: "PostgresError",
    code: "23505",
    constraint_name: "notifications_dedupe_key_uidx",
    table_name: "notifications",
    detail: "Key (dedupe_key)=(Juan Perez 11-5555-0000) already exists.",
  });
}

const FINDER_TEXT = "Juan Perez 11-5555-0000";

/** drizzle's wrapper: message = `Failed query: <sql>` + newline + `params: <params>`. */
function drizzleQueryError(cause?: unknown): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into "notifications" ("user_id", "title", "body") values ($1, $2, $3)',
    ["00000000-0000-0000-0000-000000000001", "Encontraron a Pampa", FINDER_TEXT],
    cause as Error | undefined,
  );
}

describe("summarizeDeadLetterError — no row data reaches error_message", () => {
  it("keeps SQLSTATE and schema identifiers of a wrapped Postgres error, not params or detail", () => {
    const summary = summarizeDeadLetterError(drizzleQueryError(postgresError()));
    expect(summary).toBe(
      "PostgresError: code=23505 constraint=notifications_dedupe_key_uidx table=notifications",
    );
  });

  it("reduces a query wrapper with no coded cause to its name", () => {
    const summary = summarizeDeadLetterError(drizzleQueryError(new Error("boom")));
    expect(summary).toBe("Error");
    expect(summary).not.toContain("params");
    expect(summary).not.toContain(FINDER_TEXT);
  });

  it("keeps the first line of an uncoded error that is not a query dump", () => {
    expect(summarizeDeadLetterError(new Error("Connection terminated\nsecond line"))).toBe(
      "Error: Connection terminated",
    );
  });

  it("never stringifies a thrown non-error", () => {
    expect(summarizeDeadLetterError(FINDER_TEXT)).toBe("non-error thrown (string)");
  });
});

describe("dead-letter rows carry no query params (single and bulk paths)", () => {
  function clientThrowing(err: unknown) {
    return {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => {
              throw err;
            },
          }),
        }),
      }),
    };
  }

  async function errorMessagesFor(keyPrefix: string): Promise<string[]> {
    const rows = await db
      .select({ errorMessage: notificationDeadLetter.errorMessage })
      .from(notificationDeadLetter)
      .where(like(notificationDeadLetter.dedupeKey, `${keyPrefix}%`));
    return rows.map((r) => r.errorMessage ?? "");
  }

  it("createNotification stores the summary, not the DrizzleQueryError message", async () => {
    const key = `${PARAMS_KEY_PREFIX}single`;
    await createNotification(
      { userId, notificationType: "test_notification", title: FINDER_TEXT, dedupeKey: key },
      clientThrowing(drizzleQueryError(postgresError())),
    );
    const messages = await errorMessagesFor(key);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("code=23505");
    expect(messages[0]).not.toContain("params");
    expect(messages[0]).not.toContain(FINDER_TEXT);
  });

  it("createNotificationsBulk stores the summary on every row of a failed chunk", async () => {
    const prefix = `${PARAMS_KEY_PREFIX}bulk-`;
    const result = await createNotificationsBulk(
      [0, 1].map((i) => ({
        userId,
        notificationType: "test_notification",
        title: FINDER_TEXT,
        dedupeKey: `${prefix}${i}`,
      })),
      clientThrowing(drizzleQueryError()),
    );
    expect(result.deadLetteredCount).toBe(2);
    const messages = await errorMessagesFor(prefix);
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m).not.toContain("params");
      expect(m).not.toContain(FINDER_TEXT);
    }
  });

  // LOW-B: when the dead-letter insert ITSELF throws, the fallback console.error
  // used to log the raw DrizzleQueryError (params = the whole notification). It
  // must go through the same summariser as error_message.
  it("summarizes deadLetterErr in the console.error fallback, not the raw error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dbInsertSpy = vi.spyOn(db, "insert").mockImplementation(() => {
      throw drizzleQueryError(postgresError());
    });
    try {
      const key = `${PARAMS_KEY_PREFIX}both-fail`;
      const result = await createNotification(
        { userId, notificationType: "test_notification", title: FINDER_TEXT, dedupeKey: key },
        clientThrowing(drizzleQueryError(postgresError())),
      );
      expect(result.status).toBe("dead_lettered");
      expect(consoleSpy).toHaveBeenCalledOnce();
      // Check the summarized fields specifically, not the whole call (the
      // dedupeKey itself is built from PARAMS_KEY_PREFIX, which contains the
      // substring "params" — a red herring for a bare toContain("params")).
      const [, logged] = consoleSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(logged.insertError).not.toContain(FINDER_TEXT);
      expect(logged.deadLetterErr).not.toContain(FINDER_TEXT);
      expect(logged.insertError).not.toContain("params:");
      expect(logged.deadLetterErr).not.toContain("params:");
      expect(logged.deadLetterErr).toContain("code=23505");
    } finally {
      dbInsertSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});
