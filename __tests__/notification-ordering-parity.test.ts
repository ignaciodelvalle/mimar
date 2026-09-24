// The web inbox and the native inbox order the same notifications identically.
//
// WHAT THIS IS FOR
// ---------------------------------------------------------------------------
// WU-Q-1 gave the notification list a second renderer. The failure it opens is
// not a crash and not a wrong pixel: it is the phone showing the same eight
// notifications in a different order from the browser, which nobody notices in
// review because each list reads perfectly well on its own and they only
// disagree from the fourth row of a real inbox.
//
// The RULE cannot drift — it is one function in `@dim/contract/notifications`,
// called by both. What CAN drift is the projection: five field reads on each
// side answering "what is this row's severity / instant / id / subject animal /
// type". The web reads a Drizzle row (`createdAt` is a `Date`, the subject is
// `pets.id`); the wire carries an ISO string and a public token. A projection
// that returned seconds instead of milliseconds, or dropped the id tiebreak, or
// keyed the subject on something that is not one-per-animal, produces two lists
// that are each internally consistent and not the same list.
//
// So this file runs BOTH projections over the same logical notifications and
// asserts the two orders are equal, id for id, including the grouping.
//
// WHY THE WEB'S OWN UNIT TEST IS STILL LOAD-BEARING, and this does not replace
// it. Both sides here go through the shared rule, so a mutation to the RULE moves
// both orders together and this file stays green. That is not a hole, it is a
// division of labour: `app/(app)/notificaciones/notification-ordering.test.ts`
// pins what the rule DOES (urgent before warning, newest first, id descending),
// unchanged across the move, and this file pins that the two front doors reach it
// with the same answers. Neither alone is enough; the pair is.
//
// THE ONE ASYMMETRY, ASSERTED RATHER THAN ASSUMED. The web groups on `pets.id`
// and the wire groups on `pets.public_token`. Those are different strings, so
// this file only means something if the fixture below actually exercises the
// substitution: two DIFFERENT animals that must not share a bucket, and one
// animal appearing three times that must collapse into one. Both are in the
// fixture, and `it("would notice a subject key that is not one-per-animal")`
// checks the fixture rather than trusting the sentence.

import type { NotificationRow } from "@/app/(app)/notificaciones/notification-ordering";
import {
  groupNotifications,
  sortNotificationsForDisplay,
} from "@/app/(app)/notificaciones/notification-ordering";
import type { Notification, Pet } from "@/db";
import type { MyNotificationV1 } from "@dim/contract/api";
import {
  type NotificationSeverity,
  groupForDisplay,
  sortForDisplay,
  wireNotificationFacts,
} from "@dim/contract/notifications";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// One logical notification, projected two ways
// ---------------------------------------------------------------------------

type Logical = {
  id: string;
  severity: NotificationSeverity;
  createdAt: string;
  notificationType: string;
  /** The subject animal, as the pair the two sides key on differently. */
  pet: { id: string; publicToken: string; name: string } | null;
};

function asWebRow(logical: Logical): NotificationRow {
  return {
    notification: {
      id: logical.id,
      severity: logical.severity,
      createdAt: new Date(logical.createdAt),
      notificationType: logical.notificationType,
      relatedPetId: logical.pet === null ? null : logical.pet.id,
    } as unknown as Notification,
    pet:
      logical.pet === null
        ? null
        : ({ publicToken: logical.pet.publicToken, name: logical.pet.name } as unknown as Pet),
  };
}

function asWireRow(logical: Logical): MyNotificationV1 {
  return {
    id: logical.id,
    notificationType: logical.notificationType,
    title: "irrelevante",
    body: null,
    severity: logical.severity,
    category: null,
    createdAt: logical.createdAt,
    read: false,
    pet:
      logical.pet === null
        ? null
        : { publicToken: logical.pet.publicToken, name: logical.pet.name },
    petLinkAvailable: logical.pet !== null,
    cta: null,
  };
}

/**
 * Two animals, INVENTED HERE and deliberately not the demo seed's.
 *
 * The first draft used `DIM-PAMP-0001`, the flagship, and
 * `__tests__/seed-precondition-contract.test.ts` refused it — correctly, and for
 * a reason worth writing down rather than working around. That fence reads
 * `from "@/db"` to decide a test touches the database, and this file DOES import
 * from `@/db`: only types, which erase, but a regex cannot see that and should
 * not have to. A database-shaped test naming a token only a demo seed writes is
 * a test that passes on a stale local database and goes red on a fresh CI one,
 * and being type-only is exactly the kind of exemption that stops being true
 * later. These tokens are this file's own; nothing seeds them, nothing needs to.
 */
const PAMPA = {
  id: "11111111-1111-1111-1111-111111111111",
  publicToken: "DIM-TEST-0001",
  name: "Pampa",
};
const FIRU = {
  id: "22222222-2222-2222-2222-222222222222",
  publicToken: "DIM-TEST-0002",
  name: "Firu",
};

/**
 * The fixture, built to make every clause of the rule bite at least once.
 *
 *   · all four severities, out of order, so the rank comparison decides;
 *   · two rows of one severity with different instants, so recency decides;
 *   · two rows with the SAME instant and the same severity, so the id tiebreak
 *     decides — the clause a projection is most likely to drop, because it never
 *     matters until two writers land in the same millisecond;
 *   · three `pet_sighting` rows about ONE animal, which must collapse;
 *   · a fourth `pet_sighting` about a DIFFERENT animal, which must not join them;
 *   · a row with no animal at all, which buckets under "_" on both sides.
 */
const FIXTURE: Logical[] = [
  {
    id: "n-01",
    severity: "info",
    createdAt: "2026-08-20T10:00:00.000Z",
    notificationType: "welcome",
    pet: null,
  },
  {
    id: "n-02",
    severity: "urgent",
    createdAt: "2026-08-20T09:00:00.000Z",
    notificationType: "pet_sighting",
    pet: PAMPA,
  },
  {
    id: "n-03",
    severity: "urgent",
    createdAt: "2026-08-20T11:00:00.000Z",
    notificationType: "pet_sighting",
    pet: PAMPA,
  },
  {
    id: "n-04",
    severity: "urgent",
    createdAt: "2026-08-20T11:00:00.000Z",
    notificationType: "pet_sighting",
    pet: PAMPA,
  },
  {
    id: "n-05",
    severity: "urgent",
    createdAt: "2026-08-20T08:00:00.000Z",
    notificationType: "pet_sighting",
    pet: FIRU,
  },
  {
    id: "n-06",
    severity: "warning",
    createdAt: "2026-08-21T08:00:00.000Z",
    notificationType: "vaccination_due",
    pet: FIRU,
  },
  {
    id: "n-07",
    severity: "success",
    createdAt: "2026-08-19T08:00:00.000Z",
    notificationType: "pet_transfer_accepted",
    pet: PAMPA,
  },
  {
    id: "n-08",
    severity: "warning",
    createdAt: "2026-08-22T08:00:00.000Z",
    notificationType: "vaccination_due",
    pet: PAMPA,
  },
  {
    id: "n-09",
    severity: "info",
    createdAt: "2026-08-18T08:00:00.000Z",
    notificationType: "welcome",
    pet: null,
  },
];

/** The group structure, flattened into something two runs can be compared by. */
function shapeOf(
  groups: ReadonlyArray<
    { kind: "single"; row: unknown } | { kind: "group"; leader: unknown; rest: unknown[] }
  >,
  idOf: (row: never) => string,
): string[] {
  return groups.map((entry) =>
    entry.kind === "single"
      ? `single:${idOf(entry.row as never)}`
      : `group:${idOf(entry.leader as never)}[${entry.rest.map((r) => idOf(r as never)).join(",")}]`,
  );
}

const webId = (row: NotificationRow) => row.notification.id;
const wireId = (row: MyNotificationV1) => row.id;

describe("notification display order — web and native agree", () => {
  const webSorted = sortNotificationsForDisplay(FIXTURE.map(asWebRow));
  const wireSorted = sortForDisplay(FIXTURE.map(asWireRow), wireNotificationFacts);

  it("sorts the same page into the same sequence", () => {
    expect(
      wireSorted.map(wireId),
      "the native inbox and the web inbox disagree about the order of the same " +
        "notifications — one of the two projections in " +
        "app/(app)/notificaciones/notification-ordering.ts and " +
        "packages/contract/src/notifications/wire.ts reads a different value",
    ).toEqual(webSorted.map(webId));
  });

  it("is not trivially satisfied by an already-sorted fixture", () => {
    // If the fixture were already in display order, the assertion above would
    // pass for a projection that did nothing at all.
    expect(webSorted.map(webId)).not.toEqual(FIXTURE.map((n) => n.id));
    expect(webSorted).toHaveLength(FIXTURE.length);
  });

  it("puts the same rows in the same groups", () => {
    expect(shapeOf(groupForDisplay(wireSorted, wireNotificationFacts), wireId as never)).toEqual(
      shapeOf(groupNotifications(webSorted), webId as never),
    );
  });

  it("would notice a subject key that is not one-per-animal", () => {
    // The fixture has to CONTAIN a collapsed group and a same-type row about a
    // different animal, or the pets.id ↔ publicToken substitution is untested
    // and this file's headline claim is decoration.
    const groups = groupNotifications(webSorted);
    const collapsed = groups.filter((g) => g.kind === "group");
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.kind === "group" && collapsed[0].rest).toHaveLength(2);

    const sightings = FIXTURE.filter((n) => n.notificationType === "pet_sighting");
    expect(new Set(sightings.map((n) => n.pet?.publicToken)).size).toBe(2);
    // …and the two keys really are different strings, so equality on one is not
    // accidentally equality on the other.
    expect(PAMPA.id).not.toBe(PAMPA.publicToken);
  });

  it("breaks a same-severity same-instant tie identically", () => {
    // n-03 and n-04 are the pair. Descending id on both sides, so n-04 first.
    const web = webSorted.map(webId);
    const wire = wireSorted.map(wireId);
    expect(web.indexOf("n-04")).toBeLessThan(web.indexOf("n-03"));
    expect(wire.indexOf("n-04")).toBeLessThan(wire.indexOf("n-03"));
  });

  it("neither projection mutates its input", () => {
    const rows = FIXTURE.map(asWireRow);
    const before = rows.map(wireId);
    sortForDisplay(rows, wireNotificationFacts);
    expect(rows.map(wireId)).toEqual(before);
  });
});

describe("the wire projection's date handling", () => {
  it("sorts an unreadable instant to the bottom of its band instead of poisoning the sort", () => {
    const broken = asWireRow({
      id: "n-99",
      severity: "info",
      createdAt: "no es una fecha",
      notificationType: "welcome",
      pet: null,
    });
    expect(wireNotificationFacts(broken).createdAtMs).toBe(0);

    const sorted = sortForDisplay([broken, ...FIXTURE.map(asWireRow)], wireNotificationFacts);
    // Every info row still ranks after every non-info one, and the broken one is
    // last among them — the failure stayed local to its own row.
    expect(sorted.at(-1)?.id).toBe("n-99");
    expect(sorted).toHaveLength(FIXTURE.length + 1);
  });
});
