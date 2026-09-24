import type { Notification } from "@/db";
import { describe, expect, it } from "vitest";

import {
  type NotificationRow,
  groupNotifications,
  severityRank,
  sortNotificationsForDisplay,
} from "./notification-ordering";

// Minimal Notification factory — only the fields the ordering/grouping logic
// reads. Cast keeps the test focused without reconstructing the whole row.
function notif(
  overrides: Partial<Notification> & Pick<Notification, "id" | "severity" | "createdAt">,
): Notification {
  return {
    notificationType: "generic",
    relatedPetId: null,
    ...overrides,
  } as Notification;
}

function row(
  id: string,
  severity: Notification["severity"],
  createdAtIso: string,
  extra?: Partial<Notification>,
): NotificationRow {
  return {
    notification: notif({ id, severity, createdAt: new Date(createdAtIso), ...extra }),
    pet: null,
  };
}

describe("severityRank", () => {
  it("ranks urgent highest (lowest number) and info lowest", () => {
    expect(severityRank("urgent")).toBeLessThan(severityRank("warning"));
    expect(severityRank("warning")).toBeLessThan(severityRank("success"));
    expect(severityRank("success")).toBeLessThan(severityRank("info"));
  });
});

describe("sortNotificationsForDisplay", () => {
  it("orders by severity first (urgent → warning → success → info)", () => {
    const rows = [
      row("a", "info", "2026-07-10T10:00:00Z"),
      row("b", "urgent", "2026-07-01T10:00:00Z"),
      row("c", "success", "2026-07-05T10:00:00Z"),
      row("d", "warning", "2026-07-08T10:00:00Z"),
    ];
    const sorted = sortNotificationsForDisplay(rows);
    expect(sorted.map((r) => r.notification.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("orders by recency (newest first) within the same severity", () => {
    const rows = [
      row("old", "warning", "2026-07-01T10:00:00Z"),
      row("new", "warning", "2026-07-09T10:00:00Z"),
      row("mid", "warning", "2026-07-05T10:00:00Z"),
    ];
    const sorted = sortNotificationsForDisplay(rows);
    expect(sorted.map((r) => r.notification.id)).toEqual(["new", "mid", "old"]);
  });

  it("breaks ties on equal severity+timestamp by id descending (stable keyset tiebreak)", () => {
    const ts = "2026-07-05T10:00:00Z";
    const rows = [row("aaa", "info", ts), row("zzz", "info", ts), row("mmm", "info", ts)];
    const sorted = sortNotificationsForDisplay(rows);
    expect(sorted.map((r) => r.notification.id)).toEqual(["zzz", "mmm", "aaa"]);
  });

  it("does not mutate the input array (keyset pagination reads the original order)", () => {
    const rows = [
      row("a", "info", "2026-07-10T10:00:00Z"),
      row("b", "urgent", "2026-07-01T10:00:00Z"),
    ];
    const snapshot = rows.map((r) => r.notification.id);
    sortNotificationsForDisplay(rows);
    expect(rows.map((r) => r.notification.id)).toEqual(snapshot);
  });
});

describe("groupNotifications after severity sort", () => {
  it("collapses ≥3 rows of the same pet+type into one group regardless of severity scatter", () => {
    // Three rows share pet+type but differ in severity; a fourth is unrelated.
    const rows = sortNotificationsForDisplay([
      row("g1", "info", "2026-07-01T10:00:00Z", { relatedPetId: "pet-1", notificationType: "x" }),
      row("g2", "urgent", "2026-07-02T10:00:00Z", { relatedPetId: "pet-1", notificationType: "x" }),
      row("g3", "warning", "2026-07-03T10:00:00Z", {
        relatedPetId: "pet-1",
        notificationType: "x",
      }),
      row("solo", "info", "2026-07-04T10:00:00Z", { relatedPetId: "pet-2", notificationType: "y" }),
    ]);
    const groups = groupNotifications(rows);
    const group = groups.find((g) => g.kind === "group");
    expect(group).toBeDefined();
    if (group?.kind === "group") {
      // Leader is the highest-severity instance (urgent g2) after the sort.
      expect(group.leader.notification.id).toBe("g2");
      expect(group.rest).toHaveLength(2);
      expect(group.rest.map((r) => r.notification.id).sort()).toEqual(["g1", "g3"]);
    }
    // The unrelated singleton survives as a single.
    expect(groups.some((g) => g.kind === "single")).toBe(true);
  });

  it("orders group leaders by severity (an urgent group precedes an info singleton)", () => {
    const rows = sortNotificationsForDisplay([
      row("s1", "info", "2026-07-10T10:00:00Z", { relatedPetId: "pet-9", notificationType: "z" }),
      row("u1", "urgent", "2026-07-01T10:00:00Z", { relatedPetId: "pet-1", notificationType: "x" }),
      row("u2", "urgent", "2026-07-02T10:00:00Z", { relatedPetId: "pet-1", notificationType: "x" }),
      row("u3", "urgent", "2026-07-03T10:00:00Z", { relatedPetId: "pet-1", notificationType: "x" }),
    ]);
    const groups = groupNotifications(rows);
    expect(groups[0].kind).toBe("group");
    if (groups[0].kind === "group") {
      expect(groups[0].leader.notification.severity).toBe("urgent");
    }
  });
});
