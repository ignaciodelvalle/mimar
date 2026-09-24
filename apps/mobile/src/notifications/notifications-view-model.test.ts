// `notifications-view-model` — the pure half of the inbox.
//
// WHAT THESE HAVE TO PROVE
// ---------------------------------------------------------------------------
//   1. THE SCREEN DOES NOT SORT. `notificationsForDisplay` must be the shared
//      rule and nothing else, or the phone and the browser can disagree about
//      the order of the same eight rows. The cross-client half of that claim is
//      `__tests__/notification-ordering-parity.test.ts` at the repo root, which
//      runs both projections; this half is that the screen actually CALLS it
//      rather than rendering the array as it arrives.
//   2. THE COMMANDS ARE THE CONTRACT'S. Every builder round-trips through the
//      shared schema, so a shape this app invents is refused HERE with a code
//      rather than by the server with a 400.
//   3. THE EMPTY SENTENCES ARE DIFFERENT. "You have no notifications" and
//      "nobody has reported seeing your lost dog" are different facts, and the
//      second is what somebody is on this screen for.
//   4. THE TRUNCATION IS DECLARED. There is no cursor on this surface and the
//      web has one; a phone that drew a complete-looking list would be hiding
//      the gap rather than not having it.

import {
  type MyNotificationV1,
  type MyNotificationsV1,
  NOTIFICATION_CATEGORIES_V1,
} from "@dim/contract/api";
import { describe, expect, it } from "@jest/globals";

import {
  buildArchive,
  buildMarkAllRead,
  buildMarkRead,
  categoryLabel,
  emptyBody,
  emptyTitle,
  inboxSummary,
  notificationDateLabel,
  notificationsForDisplay,
  rowsOf,
  severityLabel,
  truncationNote,
} from "./notifications-view-model";

function aNotification(over: Partial<MyNotificationV1> = {}): MyNotificationV1 {
  return {
    id: "n-1",
    notificationType: "pet_sighting",
    title: "Avistaje de Pampa",
    body: null,
    severity: "info",
    category: "perdidas",
    createdAt: "2026-08-20T10:00:00.000Z",
    read: false,
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampa" },
    petLinkAvailable: true,
    cta: null,
    ...over,
  };
}

function payload(over: Partial<MyNotificationsV1> = {}): MyNotificationsV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-26T00:00:00.000Z",
    staleAfter: "2026-08-26T00:00:30.000Z",
    notifications: [],
    categories: [],
    unreadCount: 0,
    total: 0,
    truncated: false,
    ...over,
  };
}

describe("notificationsForDisplay", () => {
  it("floats urgent to the top of the page it was handed", () => {
    // The wire order is chronological — the server's cursor order — and this is
    // what turns it into the order a person reads.
    //
    // THREE DIFFERENT `notificationType`s ON PURPOSE. The first draft of this
    // fixture used the default for all three and the grouping rule folded them
    // into ONE entry: three rows about one animal of one kind is exactly what it
    // collapses. That is the rule working, and it is worth leaving the note,
    // because a fixture that quietly triggers the OTHER rule tests nothing about
    // this one.
    const view = payload({
      notifications: [
        aNotification({
          id: "n-info",
          severity: "info",
          notificationType: "welcome",
          createdAt: "2026-08-22T10:00:00.000Z",
        }),
        aNotification({
          id: "n-urgent",
          severity: "urgent",
          notificationType: "pet_sighting",
          createdAt: "2026-08-19T10:00:00.000Z",
        }),
        aNotification({
          id: "n-warn",
          severity: "warning",
          notificationType: "vaccination_due",
          createdAt: "2026-08-21T10:00:00.000Z",
        }),
      ],
    });
    expect(notificationsForDisplay(view).map((e) => rowsOf(e)[0]?.id)).toEqual([
      "n-urgent",
      "n-warn",
      "n-info",
    ]);
  });

  it("collapses three of one kind about one animal and leaves a fourth animal alone", () => {
    const sighting = (id: string, publicToken: string) =>
      aNotification({
        id,
        severity: "urgent",
        notificationType: "pet_sighting",
        pet: { publicToken, name: publicToken },
      });
    const view = payload({
      notifications: [
        sighting("a1", "DIM-PAMP-0001"),
        sighting("a2", "DIM-PAMP-0001"),
        sighting("a3", "DIM-PAMP-0001"),
        sighting("b1", "DIM-FIRU-0002"),
      ],
    });

    const entries = notificationsForDisplay(view);
    const groups = entries.filter((e) => e.kind === "group");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind === "group" && groups[0].rest).toHaveLength(2);
    // The other animal's row is its own entry — the grouping key is the PET, not
    // the type, and a bucket that swallowed Firu would hide a second lost dog.
    expect(entries.filter((e) => e.kind === "single")).toHaveLength(1);
  });

  it("does not mutate the payload it was handed", () => {
    const view = payload({
      notifications: [
        aNotification({ id: "n-info", severity: "info" }),
        aNotification({ id: "n-urgent", severity: "urgent" }),
      ],
    });
    notificationsForDisplay(view);
    expect(view.notifications.map((n) => n.id)).toEqual(["n-info", "n-urgent"]);
  });
});

describe("the command builders", () => {
  it("builds the three commands the endpoint accepts", () => {
    expect(buildMarkRead(["n-1", "n-2"])).toEqual({
      ok: true,
      input: { command: "mark_read", notificationIds: ["n-1", "n-2"] },
    });
    expect(buildMarkAllRead()).toEqual({ ok: true, input: { command: "mark_all_read" } });
    expect(buildArchive("n-1")).toEqual({
      ok: true,
      input: { command: "archive", notificationId: "n-1" },
    });
  });

  it("refuses an empty batch locally, with a sentence and a code", () => {
    const result = buildMarkRead([]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("NOTIFICATION_IDS_REQUIRED");
    expect(result.message).toMatch(/notificación/);
  });

  it("refuses a batch bigger than one page locally rather than by round trip", () => {
    const result = buildMarkRead(Array.from({ length: 101 }, (_, i) => `n-${i}`));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("TOO_MANY_NOTIFICATION_IDS");
  });

  it("refuses an empty id", () => {
    const result = buildArchive("   ");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("NOTIFICATION_ID_REQUIRED");
  });
});

describe("copy", () => {
  it("says three different things about three different inboxes", () => {
    expect(inboxSummary(payload())).toBe("Sin notificaciones.");
    expect(inboxSummary(payload({ total: 4, unreadCount: 2 }))).toBe("2 sin leer · 4 en total");
    expect(inboxSummary(payload({ total: 4, unreadCount: 0 }))).toBe("4 en total");
  });

  it("gives the lost-pet tab its own empty sentence", () => {
    // The one tab whose emptiness is a fact somebody is waiting on.
    expect(emptyTitle("perdidas")).toMatch(/avistajes/);
    expect(emptyBody("perdidas")).not.toBe(emptyBody(null));
    expect(emptyTitle(null)).toBe("Sin notificaciones");
  });

  it("labels the six categories in the web's own words", () => {
    expect(categoryLabel("perdidas")).toBe("Pérdidas");
    expect(categoryLabel("admin")).toBe("Sistema");
  });

  it("falls back to the neutral severity word rather than printing an enum", () => {
    // The rule that ORDERS an unknown severity treats it as `info`; this agrees.
    expect(severityLabel("urgent")).toBe("Urgente");
    expect(severityLabel("una-severidad-futura")).toBe("Info");
  });

  it("says how many rows are missing, and where the rest are", () => {
    expect(truncationNote(payload({ truncated: false, total: 3 }))).toBe(null);
    const note = truncationNote(
      payload({ truncated: true, total: 240, notifications: [aNotification()] }),
    );
    expect(note).toMatch(/1 de 240/);
    expect(note).toMatch(/web/);
  });

  it("never prints an unreadable date as Invalid Date", () => {
    expect(notificationDateLabel("2026-08-20T10:00:00.000Z")).toMatch(/2026/);
    expect(notificationDateLabel("no es una fecha")).toBe("fecha desconocida");
  });
});

describe("the empty state does not say the same thing twice (S-4)", () => {
  it("never repeats the headline in the body, on any category", () => {
    // "Sin notificaciones de salud" over "Tu bandeja está vacía" is one claim
    // printed twice — and on a filtered tab the second one is false as well.
    for (const category of [null, ...NOTIFICATION_CATEGORIES_V1] as const) {
      const title = emptyTitle(category);
      const body = emptyBody(category);
      expect(body).not.toBe(title);
      expect(body.toLowerCase()).not.toContain("bandeja está vacía");
    }
  });

  it("tells a person on a FILTERED tab that the other tabs are a different question", () => {
    // Eleven unread custody rows one tab away, under a sentence that said the
    // inbox was empty. The unfiltered inbox keeps the shorter sentence, because
    // there it IS the whole answer.
    expect(emptyBody("health")).toContain("en esta categoría");
    expect(emptyBody("health")).toContain("Las otras pueden tener novedades");
    expect(emptyBody(null)).not.toContain("Las otras");
  });
});
