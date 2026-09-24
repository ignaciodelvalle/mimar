// What the adoption bearer door's notification fan-out actually does.
//
// THE MOCK IS THE SERVICE, NOT THE DATABASE, and that is the point of the file:
// `check-notifications-service.ts` can prove there is no `db.insert(notifications)`
// in this module's TEXT, and nothing else. It cannot prove the rows arrive with a
// usable idempotency key, and a key is the whole reason the service exists — a
// bulk insert with a key that collapses two distinct notifications is worse than
// the raw insert it replaced, because the loss is silent on BOTH ends.
//
// Each test names the mutation that reddens it, and every one was applied.

import { beforeEach, describe, expect, it, vi } from "vitest";

type BulkResult = { insertedCount: number; duplicateCount: number; deadLetteredCount: number };
const createNotificationsBulk = vi.fn<
  (rows: ReadonlyArray<Record<string, unknown>>) => Promise<BulkResult>
>(async () => ({ insertedCount: 0, duplicateCount: 0, deadLetteredCount: 0 }));

vi.mock("@/lib/infra/notification-service", () => ({
  createNotificationsBulk: (...args: unknown[]) =>
    (createNotificationsBulk as unknown as (...a: unknown[]) => unknown)(...args),
}));

import type { NewNotification } from "../../application/set-adoption-eligibility";
import { adoptionNotificationDedupeKey, flushAdoptionNotifications } from "../notification-flush";

function row(overrides: Partial<NewNotification> = {}): NewNotification {
  return {
    userId: "member-1",
    notificationType: "adoption_application_received",
    title: "Nueva postulación para Mochi",
    body: "Una persona se postuló para adoptar.",
    severity: "info",
    category: "adoption",
    ctaLabel: "Revisar postulación",
    ctaUrl: "/org/org-tok/adopciones/evt-1",
    relatedPetId: "pet-1",
    relatedEventId: "evt-1",
    ...overrides,
  };
}

/** The single argument the service was handed, as rows. */
function sentRows(): ReadonlyArray<Record<string, unknown>> {
  return createNotificationsBulk.mock.calls.at(-1)?.[0] ?? [];
}

describe("flushAdoptionNotifications", () => {
  beforeEach(() => {
    createNotificationsBulk.mockClear();
  });

  it("does not call the service at all for an empty fan-out", async () => {
    // MUTATION APPLIED: delete the `if (pending.length === 0) return;` guard.
    // The service is then called with `[]`, which is a round trip and a chunk
    // loop for nothing on every application to a shelter with no members.
    await flushAdoptionNotifications([]);
    expect(createNotificationsBulk).not.toHaveBeenCalled();
  });

  it("hands every row to the service WITH a dedupe key", async () => {
    // MUTATION APPLIED: drop `dedupeKey` from the mapping in
    // `flushAdoptionNotifications`. TypeScript catches that one, so the mutation
    // actually applied was `dedupeKey: ""` — which type-checks, and which the
    // service's partial unique index (WHERE dedupe_key IS NOT NULL) treats as a
    // real value, so every adoption notification in the system would collapse
    // onto one row. 2 assertions red.
    await flushAdoptionNotifications([row(), row({ userId: "member-2" })]);
    expect(createNotificationsBulk).toHaveBeenCalledTimes(1);
    expect(sentRows()).toHaveLength(2);
    for (const sent of sentRows()) {
      expect(sent.dedupeKey).toBe(
        `adoption:adoption_application_received:evt-1:${sent.userId as string}`,
      );
    }
  });

  it("carries the row's own content through unchanged", async () => {
    // MUTATION APPLIED: `body: row.title` in the mapping. Red — a shelter would
    // get a notification whose body repeats its title.
    await flushAdoptionNotifications([row()]);
    expect(sentRows()[0]).toMatchObject({
      userId: "member-1",
      notificationType: "adoption_application_received",
      title: "Nueva postulación para Mochi",
      body: "Una persona se postuló para adoptar.",
      severity: "info",
      category: "adoption",
      relatedPetId: "pet-1",
      relatedEventId: "evt-1",
    });
  });
});

describe("adoptionNotificationDedupeKey", () => {
  it("is STABLE across two flushes of one fan-out, which is what makes a retry safe", () => {
    // MUTATION APPLIED: append `:${randomUUID()}` to the key. The key stays
    // well-formed and unique — and the dedupe becomes a no-op, so a retry after
    // a timeout writes the shelter a second copy of every notification. Red.
    expect(adoptionNotificationDedupeKey(row())).toBe(adoptionNotificationDedupeKey(row()));
  });

  it("separates two applications for the SAME pet, because the spine event differs", () => {
    // MUTATION APPLIED: anchor the key on `relatedPetId` alone
    // (`pending.relatedPetId ?? pending.relatedEventId ?? …`). Red — and the
    // failure it describes is the expensive one: the SECOND person to apply for
    // an animal generates a notification that dedupes against the first
    // person's, so the shelter is never told about them and the applicant waits
    // on a letter nobody saw.
    expect(adoptionNotificationDedupeKey(row({ relatedEventId: "evt-1" }))).not.toBe(
      adoptionNotificationDedupeKey(row({ relatedEventId: "evt-2" })),
    );
  });

  it("separates two recipients of ONE application", () => {
    // MUTATION APPLIED: drop `:${pending.userId}` from the key. Red — a shelter
    // with a director and three coordinators would have exactly one of them
    // notified, chosen by whichever row the bulk insert reached first.
    expect(adoptionNotificationDedupeKey(row({ userId: "member-1" }))).not.toBe(
      adoptionNotificationDedupeKey(row({ userId: "member-2" })),
    );
  });

  it("separates two TYPES about one event", () => {
    // MUTATION APPLIED: drop `${pending.notificationType}` from the key. Red.
    expect(adoptionNotificationDedupeKey(row({ notificationType: "a" }))).not.toBe(
      adoptionNotificationDedupeKey(row({ notificationType: "b" })),
    );
  });

  it("never mints a key containing the literal `undefined`", () => {
    // MUTATION APPLIED: replace the `?? "no-anchor"` fallback with nothing, so
    // the anchor interpolates as `undefined` for a row carrying neither id. Two
    // such rows — different types, different people, different animals — would
    // then share the string `undefined` in the one position that is supposed to
    // separate them. Unreachable on this door (the test below pins that), which
    // is exactly why the fallback needs a test rather than a comment.
    const anchorless = adoptionNotificationDedupeKey(
      row({ relatedEventId: null, relatedPetId: null }),
    );
    expect(anchorless).not.toContain("undefined");
    expect(anchorless).toBe("adoption:adoption_application_received:no-anchor:member-1");
  });
});
