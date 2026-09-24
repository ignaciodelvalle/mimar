// `/api/v1/me/notifications` — the inbox, and the three things it can be told.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. AUTHORIZATION. It hangs off `/me`, so a request with no bearer, an
//      unusable one, or one belonging to an erased or deactivated account is
//      refused — with the same codes every sibling on this surface uses, so a
//      native client writes ONE handler for the auth failure space.
//   2. THE PROJECTION, AND ESPECIALLY WHAT IT DOES NOT CARRY. No internal ids.
//      A redaction sentinel rides verbatim. An external CTA keeps its label and
//      gets no route. A pet whose notification type means custody LEFT the
//      recipient gets `petLinkAvailable: false` even though the row has a pet.
//   3. THE EMPTY STATE IS NOT A FAILED READ. A person with an empty inbox and a
//      pooler outage are different facts, and a phone that draws "tu bandeja está
//      vacía" over the second tells somebody nobody reported seeing their dog.
//   4. THE COMMANDS. Each maps to its use-case, `changed` reflects rows actually
//      touched, and an id belonging to nobody is a 200 with `changed: false` —
//      never a 404, which would make this an oracle over notification ids.
//   5. THE LIMITERS. Two buckets per method, IP before the guard and user after,
//      and the WRITE spends the inbox-state family rather than the read family's.
//
// The door itself (`listNotificationsForUser`) is mocked: its four-clause
// predicate is Postgres's business and is exercised by the page it also serves.
// What is asserted here is what the ROUTE does with the answer.

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  limiterThrows: null as null | ((endpoint: string) => void),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  list: null as null | (() => unknown),
  counts: null as null | (() => unknown),
  unread: null as null | (() => unknown),
  writes: [] as Array<{ fn: string; args: unknown[] }>,
  writeResult: { changed: 0 } as { changed: number },
}));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      control.live
        ? control.live()
        : { ok: true, supabase: {}, user: { id: OWNER_ID }, profile: null },
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.limits.push({ endpoint, identifier });
      control.limiterThrows?.(endpoint);
    },
  };
});

vi.mock(
  "@/src/modules/notifications/application/read/list-notifications-for-user",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/src/modules/notifications/application/read/list-notifications-for-user")
      >();
    return {
      ...actual,
      listNotificationsForUser: async () =>
        control.list ? control.list() : { rows: [], hasMore: false },
    };
  },
);

vi.mock("@/lib/analytics/owner-dashboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/owner-dashboard")>();
  return {
    ...actual,
    fetchNotificationCategoryCounts: async () =>
      control.counts
        ? control.counts()
        : {
            all: 0,
            health: 0,
            custody: 0,
            adoption: 0,
            welfare: 0,
            admin: 0,
            perdidas: 0,
            perdidasUrgent: 0,
          },
    fetchUnreadNotificationCount: async () => (control.unread ? control.unread() : 0),
  };
});

vi.mock("@/src/modules/notifications/application/notification-actions", () => ({
  markNotificationsRead: async (...args: unknown[]) => {
    control.writes.push({ fn: "markNotificationsRead", args });
    return control.writeResult;
  },
  markNotificationRead: async (...args: unknown[]) => {
    control.writes.push({ fn: "markNotificationRead", args });
    return control.writeResult;
  },
  markAllNotificationsRead: async (...args: unknown[]) => {
    control.writes.push({ fn: "markAllNotificationsRead", args });
    return control.writeResult;
  },
  archiveNotification: async (...args: unknown[]) => {
    control.writes.push({ fn: "archiveNotification", args });
    return control.writeResult;
  },
}));

import { DbBudgetExceededError } from "@/lib/infra/db-budget";
import { RateLimitError } from "@/lib/infra/rate-limit";
import { MY_NOTIFICATIONS_PAYLOAD_VERSION, type MyNotificationsV1 } from "@dim/contract/api";

import { GET, POST } from "@/app/api/v1/me/notifications/route";

const NOTIF_ID = "33333333-3333-4333-8333-333333333333";

function row(overrides: Record<string, unknown> = {}) {
  return {
    notification: {
      id: NOTIF_ID,
      userId: OWNER_ID,
      notificationType: "pet_sighting",
      title: "Avistaje de Pampa",
      body: "Alguien la vio en Palermo.",
      severity: "urgent",
      category: "perdidas",
      ctaLabel: "Ver el reporte",
      ctaUrl: "/mis-mascotas/DIM-PAMP-0001/eventos/ev-1",
      relatedPetId: "44444444-4444-4444-4444-444444444444",
      readAt: null,
      archivedAt: null,
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      ...(overrides.notification as object | undefined),
    },
    pet:
      overrides.pet === undefined ? { publicToken: "DIM-PAMP-0001", name: "Pampa" } : overrides.pet,
  };
}

function req(init: { authorization?: string | null; url?: string } = {}) {
  const headers: Record<string, string> = { "x-real-ip": "203.0.113.22" };
  const value = init.authorization === undefined ? "Bearer test-token" : init.authorization;
  if (value) headers.authorization = value;
  return new Request(init.url ?? "http://localhost:3000/api/v1/me/notifications", { headers });
}

function postReq(body: unknown, init: { authorization?: string | null } = {}) {
  const headers: Record<string, string> = {
    "x-real-ip": "203.0.113.22",
    "content-type": "application/json",
  };
  const value = init.authorization === undefined ? "Bearer test-token" : init.authorization;
  if (value) headers.authorization = value;
  return new Request("http://localhost:3000/api/v1/me/notifications", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  control.live = null;
  control.limiterThrows = null;
  control.limits = [];
  control.list = null;
  control.counts = null;
  control.unread = null;
  control.writes = [];
  control.writeResult = { changed: 0 };
});

// ---------------------------------------------------------------------------
// Authorization — the same space as every sibling
// ---------------------------------------------------------------------------

describe("/api/v1/me/notifications — authorization", () => {
  it("refuses a request with no Authorization header at all", async () => {
    for (const res of [
      await GET(req({ authorization: null })),
      await POST(postReq({}, { authorization: null })),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "auth_required" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("refuses a header that is not a usable bearer", async () => {
    const res = await GET(req({ authorization: "Basic abc" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_expired" });
  });

  it("never reaches the door when the bearer resolves to nobody", async () => {
    control.live = () => ({ ok: false, reason: "NO_SESSION" });
    control.list = () => {
      throw new Error("the door must not be opened for an unauthenticated caller");
    };
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_expired" });
  });

  it.each([
    ["ACCOUNT_ERASED", 403, "account_erased"],
    ["DEACTIVATED", 403, "account_deactivated"],
    ["SHIFT_EXPIRED", 401, "session_shift_expired"],
  ])("maps %s to %i %s", async (reason, status, code) => {
    control.live = () => ({ ok: false, reason });
    const res = await GET(req());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
  });

  it("answers 503 with a retry-after while the platform is in maintenance", async () => {
    control.live = () => ({ ok: false, reason: "MAINTENANCE" });
    const res = await POST(postReq({ command: "mark_all_read" }));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(control.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

describe("GET /api/v1/me/notifications — the projection", () => {
  it("carries the row a client renders and no database keys", async () => {
    control.list = () => ({ rows: [row()], hasMore: false });
    control.counts = () => ({
      all: 1,
      health: 0,
      custody: 0,
      adoption: 0,
      welfare: 0,
      admin: 0,
      perdidas: 1,
      perdidasUrgent: 1,
    });
    control.unread = () => 1;

    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as MyNotificationsV1;

    expect(body.payloadVersion).toBe(MY_NOTIFICATIONS_PAYLOAD_VERSION);
    expect(body.unreadCount).toBe(1);
    expect(body.total).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.categories).toEqual([{ category: "perdidas", count: 1 }]);

    const [only] = body.notifications;
    expect(only).toEqual({
      id: NOTIF_ID,
      notificationType: "pet_sighting",
      title: "Avistaje de Pampa",
      body: "Alguien la vio en Palermo.",
      severity: "urgent",
      category: "perdidas",
      createdAt: "2026-08-20T10:00:00.000Z",
      read: false,
      pet: { publicToken: "DIM-PAMP-0001", name: "Pampa" },
      petLinkAvailable: true,
      // The stored CTA is a WEB path; what reaches the phone is the native route
      // for the same destination, resolved through @dim/contract/links.
      cta: { label: "Ver el reporte", route: "/mascotas/DIM-PAMP-0001/eventos/ev-1" },
    });
    // The exhaustive equality above is the point: a widening shows up as a
    // failure rather than as a field nobody looked at. Said again, explicitly,
    // for the two that matter most.
    expect(JSON.stringify(body)).not.toContain("44444444-4444-4444-4444-444444444444");
    expect(JSON.stringify(body)).not.toContain(OWNER_ID);
  });

  it("passes a redaction sentinel through verbatim and drops the CTA with it", async () => {
    // `erase_subject_data` (migration 0170) rewrites the subject's own rows in
    // place and nulls both CTA columns. A client that recognised the sentinel and
    // substituted friendlier copy would be un-redacting a row on screen.
    control.list = () => ({
      rows: [
        row({
          notification: {
            title: "[eliminado]",
            body: "[contenido eliminado a pedido del titular]",
            ctaLabel: null,
            ctaUrl: null,
          },
        }),
      ],
      hasMore: false,
    });
    const body = (await (await GET(req())).json()) as MyNotificationsV1;
    expect(body.notifications[0]?.title).toBe("[eliminado]");
    expect(body.notifications[0]?.body).toBe("[contenido eliminado a pedido del titular]");
    expect(body.notifications[0]?.cta).toBe(null);
  });

  it("keeps an external CTA's label and refuses to route it", async () => {
    control.list = () => ({
      rows: [
        row({
          notification: { ctaLabel: "Leer la resolución", ctaUrl: "https://boletin.gob.ar/x" },
        }),
      ],
      hasMore: false,
    });
    const body = (await (await GET(req())).json()) as MyNotificationsV1;
    expect(body.notifications[0]?.cta).toEqual({ label: "Leer la resolución", route: null });
  });

  it("routes nothing for a web path the deep-link table does not name", async () => {
    control.list = () => ({
      rows: [row({ notification: { ctaUrl: "/inicio" } })],
      hasMore: false,
    });
    const body = (await (await GET(req())).json()) as MyNotificationsV1;
    expect(body.notifications[0]?.cta?.route).toBe(null);
  });

  it("answers 200 for a poisoned cta_url instead of 500ing the whole inbox", async () => {
    // A stored `cta_url` whose `:param` segment carries malformed
    // percent-encoding used to throw `URIError` out of `matchWebPath` →
    // `ctaOf` → `buildMyNotificationV1`. That chain runs while the payload is
    // being built, AFTER the try/catch above it has returned — so one bad row
    // cost the caller their entire native inbox, not its own button. The web is
    // unaffected either way: it renders `cta_url` as a plain href.
    //
    // Latent, not live — every current writer interpolates a server-generated
    // token or a uuid — but the blast radius is what makes it worth a test: the
    // sibling judgement calls in this payload (an unrecognised category, a
    // redacted CTA) each cost their own row and nothing more.
    control.list = () => ({
      rows: [
        row({ notification: { ctaLabel: "Ver el caso", ctaUrl: "/casos/50%" } }),
        row({ notification: { ctaLabel: "Ver la ficha", ctaUrl: "/mis-mascotas/DIM-PAMP-0001" } }),
      ],
      hasMore: false,
    });
    const response = await GET(req());
    expect(response.status).toBe(200);
    const body = (await response.json()) as MyNotificationsV1;
    // The poisoned row keeps its words and loses only its destination …
    expect(body.notifications[0]?.cta).toEqual({ label: "Ver el caso", route: null });
    // … and the row behind it still routes, which is the part a thrown URIError
    // took away.
    expect(body.notifications[1]?.cta?.route).toBe("/mascotas/DIM-PAMP-0001");
  });

  it("refuses the pet link for a type whose recipient no longer holds the animal", async () => {
    // The row HAS a pet. The affordance is still dead, and only the denylist
    // knows it — a client deriving this from "do I own this pet" would rebuild
    // the narrower, wrong version review 2026-08-08 rejected.
    control.list = () => ({
      rows: [row({ notification: { notificationType: "pet_transfer_accepted" } })],
      hasMore: false,
    });
    const body = (await (await GET(req())).json()) as MyNotificationsV1;
    expect(body.notifications[0]?.pet).toEqual({ publicToken: "DIM-PAMP-0001", name: "Pampa" });
    expect(body.notifications[0]?.petLinkAvailable).toBe(false);
  });

  it("nulls a category the contract does not name and keeps the row", async () => {
    control.list = () => ({
      rows: [row({ notification: { category: "una-categoria-futura" } })],
      hasMore: false,
    });
    const body = (await (await GET(req())).json()) as MyNotificationsV1;
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]?.category).toBe(null);
  });

  it("omits an empty category instead of sending a zero", async () => {
    control.counts = () => ({
      all: 3,
      health: 3,
      custody: 0,
      adoption: 0,
      welfare: 0,
      admin: 0,
      perdidas: 0,
      perdidasUrgent: 0,
    });
    const body = (await (await GET(req())).json()) as MyNotificationsV1;
    expect(body.categories).toEqual([{ category: "health", count: 3 }]);
  });

  it("declares truncation from the real total rather than from the page size", async () => {
    control.list = () => ({ rows: [row()], hasMore: true });
    control.counts = () => ({
      all: 240,
      health: 0,
      custody: 0,
      adoption: 0,
      welfare: 0,
      admin: 0,
      perdidas: 240,
      perdidasUrgent: 0,
    });
    const body = (await (await GET(req())).json()) as MyNotificationsV1;
    expect(body.total).toBe(240);
    expect(body.truncated).toBe(true);
  });

  it("compares a filtered page against its own category's total", async () => {
    // `?cat=custody` with four custody rows and 240 in the inbox overall must not
    // report the list as incomplete.
    control.list = () => ({ rows: [row()], hasMore: false });
    control.counts = () => ({
      all: 240,
      health: 0,
      custody: 1,
      adoption: 0,
      welfare: 0,
      admin: 0,
      perdidas: 239,
      perdidasUrgent: 0,
    });
    const res = await GET(
      req({ url: "http://localhost:3000/api/v1/me/notifications?cat=custody" }),
    );
    const body = (await res.json()) as MyNotificationsV1;
    expect(body.total).toBe(1);
    expect(body.truncated).toBe(false);
  });

  it("falls back to the unfiltered inbox for a category it does not know", async () => {
    // A filter is a VIEW, not an assertion. A client one release ahead asking for
    // a tab this build has never heard of sees their notifications, not a 400 —
    // which is what the web page does with the same parameter.
    control.list = () => ({ rows: [row()], hasMore: false });
    control.counts = () => ({
      all: 7,
      health: 0,
      custody: 0,
      adoption: 0,
      welfare: 0,
      admin: 0,
      perdidas: 7,
      perdidasUrgent: 0,
    });
    const res = await GET(
      req({ url: "http://localhost:3000/api/v1/me/notifications?cat=marciano" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as MyNotificationsV1).total).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Empty vs failed — the distinction the whole screen rests on
// ---------------------------------------------------------------------------

describe("GET /api/v1/me/notifications — an empty inbox is not a failed read", () => {
  it("answers 200 with an empty list, no categories and zero counts", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as MyNotificationsV1;
    expect(body.notifications).toEqual([]);
    expect(body.categories).toEqual([]);
    expect(body.unreadCount).toBe(0);
    expect(body.total).toBe(0);
    expect(body.truncated).toBe(false);
  });

  it("answers 503 — never an empty list — when the read exceeds its budget", async () => {
    control.list = () => {
      throw new DbBudgetExceededError("api-v1-me-notifications-read", 8_000);
    };
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
    expect(res.headers.get("retry-after")).toBe("5");
  });
});

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

describe("POST /api/v1/me/notifications — the three commands", () => {
  it("marks a batch read and answers changed with the count that moved", async () => {
    control.writeResult = { changed: 2 };
    control.unread = () => 5;
    const res = await POST(postReq({ command: "mark_read", notificationIds: [NOTIF_ID, "x-2"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ command: "mark_read", changed: true, unreadCount: 5 });
    expect(control.writes).toEqual([
      { fn: "markNotificationsRead", args: [OWNER_ID, [NOTIF_ID, "x-2"]] },
    ]);
  });

  it("marks the whole inbox read", async () => {
    control.writeResult = { changed: 12 };
    control.unread = () => 0;
    const res = await POST(postReq({ command: "mark_all_read" }));
    expect(await res.json()).toEqual({ command: "mark_all_read", changed: true, unreadCount: 0 });
    expect(control.writes).toEqual([{ fn: "markAllNotificationsRead", args: [OWNER_ID] }]);
  });

  it("archives one row", async () => {
    control.writeResult = { changed: 1 };
    control.unread = () => 3;
    const res = await POST(postReq({ command: "archive", notificationId: NOTIF_ID }));
    expect(await res.json()).toEqual({ command: "archive", changed: true, unreadCount: 3 });
    expect(control.writes).toEqual([{ fn: "archiveNotification", args: [OWNER_ID, NOTIF_ID] }]);
  });

  it("answers 200 changed:false for an id that belongs to nobody — never 404", async () => {
    // A 404 here would make the endpoint an oracle over other people's
    // notification ids: an id belonging to somebody else and an id belonging to
    // nobody touch the same number of rows, and must answer the same.
    control.writeResult = { changed: 0 };
    control.unread = () => 4;
    const res = await POST(postReq({ command: "archive", notificationId: NOTIF_ID }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { changed: boolean }).changed).toBe(false);
  });

  it("reports the badge as null rather than failing a write that already landed", async () => {
    control.writeResult = { changed: 1 };
    control.unread = () => {
      throw new DbBudgetExceededError("api-v1-me-notifications-unread", 8_000);
    };
    const res = await POST(postReq({ command: "mark_all_read" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      command: "mark_all_read",
      changed: true,
      unreadCount: null,
    });
  });

  it.each([
    ["a body that is not JSON at all", "no soy json"],
    ["a command nobody declared", { command: "delete", notificationId: NOTIF_ID }],
    ["mark_read with no ids", { command: "mark_read", notificationIds: [] }],
    ["archive with no id", { command: "archive" }],
  ])("refuses %s with one key and writes nothing", async (_label, body) => {
    const res = await POST(postReq(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toEqual([]);
  });

  it("refuses a batch larger than one page", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const res = await POST(postReq({ command: "mark_read", notificationIds: ids }));
    expect(res.status).toBe(400);
    expect(control.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The limiters
// ---------------------------------------------------------------------------

describe("/api/v1/me/notifications — rate limiting", () => {
  it("spends the IP bucket BEFORE the guard and the user bucket after", async () => {
    await GET(req());
    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_notifications_read_ip", identifier: "203.0.113.22" },
      { endpoint: "api_v1_me_notifications_read_user", identifier: OWNER_ID },
    ]);
  });

  it("spends the WRITE buckets on POST, not the read ones", async () => {
    await POST(postReq({ command: "mark_all_read" }));
    expect(control.limits.map((l) => l.endpoint)).toEqual([
      "api_v1_me_notifications_write_ip",
      "api_v1_me_notifications_write_user",
    ]);
  });

  it("answers 429 with no retry-after when a budget runs out", async () => {
    // No `retry-after` on either branch, deliberately: the pair must stay
    // byte-identical so the response never says which budget ran out
    // (api-invariants.md §10).
    control.limiterThrows = () => {
      throw new RateLimitError(new Date("2026-08-26T00:01:00.000Z"), "minute");
    };
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(res.headers.get("retry-after")).toBe(null);
  });

  it("fails OPEN when the limiter itself is broken", async () => {
    // The limiter is a DB write. Refusing here would empty a person's inbox over
    // an abuse control on rows that are only ever their own.
    control.limiterThrows = () => {
      throw new Error("rate_limit_buckets unavailable");
    };
    const res = await GET(req());
    expect(res.status).toBe(200);
  });

  it("never writes into the per-user keyspace for an unauthenticated caller", async () => {
    control.live = () => ({ ok: false, reason: "NO_SESSION" });
    await POST(postReq({ command: "mark_all_read" }));
    expect(control.limits.map((l) => l.endpoint)).toEqual(["api_v1_me_notifications_write_ip"]);
  });
});
