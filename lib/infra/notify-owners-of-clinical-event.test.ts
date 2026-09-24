import type { Notification } from "@/db";
import { describe, expect, it, vi } from "vitest";

import {
  type Group,
  type NotificationRow,
  groupNotifications,
} from "@/app/(app)/notificaciones/notification-ordering";
import {
  type ClinicalEventNotifyInput,
  notifyOwnersOfClinicalEvent,
} from "./notify-owners-of-clinical-event";

function makeInput(over: Partial<ClinicalEventNotifyInput> = {}): ClinicalEventNotifyInput {
  return {
    petId: "pet-1",
    petName: "Rocky",
    petPublicToken: "DIM-1234-5678",
    eventId: "evt-1",
    eventType: "vaccination_administered",
    // 2026-07-16 12:00 UTC → 16 de julio de 2026 in America/Argentina/Buenos_Aires.
    occurredAt: new Date("2026-07-16T12:00:00Z"),
    authorUserId: "vet-1",
    authorLabel: "Refugio Patitas del Norte",
    ...over,
  };
}

describe("notifyOwnersOfClinicalEvent — third-party clinical signature", () => {
  it("notifies the owner when a third party signs a clinical event", async () => {
    const createNotification = vi.fn().mockResolvedValue({ status: "inserted", id: "n-1" });

    const res = await notifyOwnersOfClinicalEvent(makeInput(), {
      findOwnerUserIds: async () => ["owner-1"],
      createNotification,
    });

    expect(createNotification).toHaveBeenCalledTimes(1);
    const arg = createNotification.mock.calls[0][0];
    expect(arg.userId).toBe("owner-1");
    expect(arg.notificationType).toBe("clinical_event_recorded");
    expect(arg.category).toBe("health");
    expect(arg.title).toBe("Nuevo registro en la libreta de Rocky");
    // The three facts the owner needs — WHAT, WHO, WHEN — plus the recourse.
    // Pinned as one exact string: a partial match would let a mutant drop the
    // date or the recourse sentence and still pass.
    expect(arg.body).toBe(
      "Refugio Patitas del Norte registró vacuna administrada con fecha 16 de julio de 2026. " +
        "Si no reconocés esta atención, abrí el registro para revisarlo o corregirlo.",
    );
    // Deep link to the EVENT, not the libreta: that page carries the owner's
    // "Corregir registro" button, which is the recourse the body promises.
    expect(arg.ctaLabel).toBe("Ver el registro");
    expect(arg.ctaUrl).toBe("/mis-mascotas/DIM-1234-5678/eventos/evt-1");
    expect(arg.relatedPetId).toBe("pet-1");
    expect(arg.relatedEventId).toBe("evt-1");
    expect(arg.dedupeKey).toBe("event:evt-1:owner-1:clinical_recorded");
    expect(res.delivered).toBe(1);
  });

  it("does NOT notify a self-authored event (owner signs on their own pet)", async () => {
    const createNotification = vi.fn().mockResolvedValue({ status: "inserted" });

    const res = await notifyOwnersOfClinicalEvent(makeInput({ authorUserId: "owner-1" }), {
      findOwnerUserIds: async () => ["owner-1"],
      createNotification,
    });

    expect(createNotification).not.toHaveBeenCalled();
    expect(res.delivered).toBe(0);
  });

  it("notifies only the non-author owners on a co-owned pet", async () => {
    const createNotification = vi.fn().mockResolvedValue({ status: "inserted" });

    await notifyOwnersOfClinicalEvent(makeInput({ authorUserId: "owner-2" }), {
      findOwnerUserIds: async () => ["owner-1", "owner-2"],
      createNotification,
    });

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0].userId).toBe("owner-1");
  });

  it("does nothing when the pet has no human owner (org-held)", async () => {
    const createNotification = vi.fn();

    const res = await notifyOwnersOfClinicalEvent(makeInput(), {
      findOwnerUserIds: async () => [],
      createNotification,
    });

    expect(createNotification).not.toHaveBeenCalled();
    expect(res.delivered).toBe(0);
  });

  it("labels each clinical sibling from the shared event-label vocabulary", async () => {
    const createNotification = vi.fn().mockResolvedValue({ status: "inserted" });

    await notifyOwnersOfClinicalEvent(makeInput({ eventType: "deworming_administered" }), {
      findOwnerUserIds: async () => ["owner-1"],
      createNotification,
    });

    expect(createNotification.mock.calls[0][0].body).toBe(
      "Refugio Patitas del Norte registró antiparasitario con fecha 16 de julio de 2026. " +
        "Si no reconocés esta atención, abrí el registro para revisarlo o corregirlo.",
    );
  });

  it("dates the body from occurredAt, not from the moment it was recorded", async () => {
    const createNotification = vi.fn().mockResolvedValue({ status: "inserted" });

    // A walk-in event declared six months back. The notification list already
    // shows "hace un minuto" from the row's createdAt, so the ONLY way an owner
    // sees a backdated signature is if the declared date is in the body.
    await notifyOwnersOfClinicalEvent(makeInput({ occurredAt: new Date("2026-01-09T12:00:00Z") }), {
      findOwnerUserIds: async () => ["owner-1"],
      createNotification,
    });

    expect(createNotification.mock.calls[0][0].body).toContain("con fecha 9 de enero de 2026");
  });

  it("is best-effort: a lookup failure never throws", async () => {
    const createNotification = vi.fn();

    const res = await notifyOwnersOfClinicalEvent(makeInput(), {
      findOwnerUserIds: async () => {
        throw new Error("db down");
      },
      createNotification,
    });

    expect(res.delivered).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------
//
// A consultation is a BURST: one vet loads five things and the owner must not
// get five cards. The repo's answer already exists — groupNotifications() folds
// ≥3 rows sharing `relatedPetId|notificationType` behind "+ N más del mismo
// tipo" — so the job here is not to invent a digest, it is to keep the payload
// GROUPABLE. These tests run the burst through the REAL grouper (not a copy of
// its bucket key), so the day someone varies notificationType per event type
// the burst unfolds into five cards and this fails.

/** Build the notification row the /notificaciones page would render. */
function rowFrom(payload: { notificationType: string; relatedPetId?: string | null }, i: number) {
  return {
    notification: {
      id: `n-${i}`,
      severity: "info",
      createdAt: new Date(2026, 6, 16, 10, i),
      notificationType: payload.notificationType,
      relatedPetId: payload.relatedPetId ?? null,
    } as unknown as Notification,
    pet: null,
  } satisfies NotificationRow;
}

/** Fire one clinical alert per event type and collect the created payloads. */
async function burst(eventTypes: ClinicalEventNotifyInput["eventType"][]) {
  const createNotification = vi.fn().mockResolvedValue({ status: "inserted" });
  for (const [i, eventType] of eventTypes.entries()) {
    await notifyOwnersOfClinicalEvent(makeInput({ eventType, eventId: `evt-${i}` }), {
      findOwnerUserIds: async () => ["owner-1"],
      createNotification,
    });
  }
  return createNotification.mock.calls.map((c) => c[0]);
}

describe("notifyOwnersOfClinicalEvent — one consultation is not five notifications", () => {
  it("collapses a five-event consultation into ONE group in the real notification list", async () => {
    const payloads = await burst([
      "vaccination_administered",
      "vaccination_administered",
      "deworming_administered",
      "note_added",
      "medication_started",
    ]);
    expect(payloads).toHaveLength(5);

    const groups: Group[] = groupNotifications(payloads.map(rowFrom));

    expect(groups).toHaveLength(1);
    const only = groups[0];
    expect(only.kind).toBe("group");
    if (only.kind !== "group") throw new Error("unreachable");
    // Exactly one visible card; the other four sit behind the disclosure.
    expect(only.rest).toHaveLength(4);
    expect(only.leader.notification.id).toBe("n-0");
  });

  it("keeps two DIFFERENT pets apart — grouping must not merge across animals", async () => {
    const payloads = await burst(["vaccination_administered", "note_added", "note_added"]);
    // Re-point one of them at another pet, exactly as a second walk-in would.
    const rows = payloads.map(rowFrom);
    rows[2].notification.relatedPetId = "pet-2";

    const groups = groupNotifications(rows);

    // pet-1 has 2 (< GROUP_MIN) and pet-2 has 1, so nothing collapses: three
    // separate cards. This is what proves the grouping is keyed on the pet and
    // not merely on the shared notificationType.
    expect(groups.map((g) => g.kind)).toEqual(["single", "single", "single"]);
  });
});

// ---------------------------------------------------------------------------
// The notice override — the rabies close's words, the walk-in's delivery
// ---------------------------------------------------------------------------
//
// A veterinary close of a rabies observation (2026-09-18) goes through this
// helper like every walk-in write, but its owner notice has to carry the result.
// Only the WORDS change: recipients, the third-party rule, the event deep link
// and the idempotency key stay the helper's.

describe("notifyOwnersOfClinicalEvent — notice override", () => {
  const NOTICE = {
    notificationType: "rabies_observation_completed_professional_owner",
    severity: "urgent" as const,
    title: "Observación cerrada profesionalmente — Rocky",
    body: "La observación antirrábica de Rocky fue cerrada por un veterinario matriculado de Refugio Patitas del Norte con resultado positivo.",
    relatedCaseId: "case-9",
  };

  it("delivers the caller's words to every owner and co-owner, keyed on event and type", async () => {
    const createNotification = vi.fn().mockResolvedValue({ status: "inserted" });

    const res = await notifyOwnersOfClinicalEvent(
      makeInput({ eventId: "evt-ended", eventType: "rabies_observation_ended", notice: NOTICE }),
      { findOwnerUserIds: async () => ["owner-1", "co-owner-2"], createNotification },
    );

    expect(res.delivered).toBe(2);
    expect(createNotification.mock.calls.map((c) => c[0])).toEqual([
      {
        userId: "owner-1",
        notificationType: "rabies_observation_completed_professional_owner",
        category: "health",
        severity: "urgent",
        title: "Observación cerrada profesionalmente — Rocky",
        body: NOTICE.body,
        ctaLabel: "Ver el registro",
        ctaUrl: "/mis-mascotas/DIM-1234-5678/eventos/evt-ended",
        relatedPetId: "pet-1",
        relatedEventId: "evt-ended",
        relatedCaseId: "case-9",
        dedupeKey: "event:evt-ended:owner-1:rabies_observation_completed_professional_owner",
      },
      {
        userId: "co-owner-2",
        notificationType: "rabies_observation_completed_professional_owner",
        category: "health",
        severity: "urgent",
        title: "Observación cerrada profesionalmente — Rocky",
        body: NOTICE.body,
        ctaLabel: "Ver el registro",
        ctaUrl: "/mis-mascotas/DIM-1234-5678/eventos/evt-ended",
        relatedPetId: "pet-1",
        relatedEventId: "evt-ended",
        relatedCaseId: "case-9",
        dedupeKey: "event:evt-ended:co-owner-2:rabies_observation_completed_professional_owner",
      },
    ]);
  });

  it("keeps the third-party rule: the signing owner is not told about their own close", async () => {
    const createNotification = vi.fn().mockResolvedValue({ status: "inserted" });

    await notifyOwnersOfClinicalEvent(makeInput({ authorUserId: "owner-1", notice: NOTICE }), {
      findOwnerUserIds: async () => ["owner-1", "co-owner-2"],
      createNotification,
    });

    expect(createNotification.mock.calls.map((c) => c[0].userId)).toEqual(["co-owner-2"]);
  });
});
