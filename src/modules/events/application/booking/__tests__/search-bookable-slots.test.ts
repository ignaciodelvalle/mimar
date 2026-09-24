// What the SEARCH actually asks Postgres — pinned on the COMPILED predicate.
//
// WHY COMPILED SQL AND NOT A SOURCE-TEXT SWEEP
// ---------------------------------------------------------------------------
// This repo has paid twice for the alternative. `listAppointmentsForUser`'s
// authorization `WHERE` had zero coverage because the drizzle stub read
// `self.where = async () => rows` and DISCARDED the predicate: a reviewer mutated
// `eq(appointments.ownerUserId, args.userId)` to a tautology and the file stayed
// 21/21 green, with three tests that read like authorization fences passing
// throughout. One line higher, the art. 16 join was guarded by a source-text
// `toContain("isNull(pets.deletedAt)")`, which passes for
// `or(isNull(pets.deletedAt), sql\`true\`)` — the substring survives and the
// filtering stops.
//
// So the stub CAPTURES every argument and every case compiles it with
// `PgDialect().sqlToQuery()`, asserting the SQL text and the bound params. That
// proves what the database is ASKED, which is the half a tautology breaks, and it
// needs no database.
//
// THE STUB IS SCRIPTED, WHICH IS THE ONE THING WORTH READING BEFORE THE CASES.
// These use-cases run several queries whose TERMINAL call differs — the offerings
// search ends at `.where()`, the slot reads end at `.orderBy()`, the offering
// lookup ends at `.limit()`. A stub that resolved on one of them would silently
// hand a builder object to a `for … of` in the other. `control.plan` names the
// terminal per query in the order they run, so a query that changes shape stops
// resolving LOUDLY instead of quietly answering the previous rows.

import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-4111-8111-111111111111";
const OFFERING_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-30T12:00:00.000Z");

type Terminal = "where" | "orderBy" | "limit";

const control = vi.hoisted(() => ({
  /** One entry per query the use-case runs, in order. */
  plan: [] as Array<{ terminal: Terminal; rows: Array<Record<string, unknown>> }>,
  /** What each query handed each builder method. */
  captured: [] as Array<{
    projection: unknown;
    where: unknown;
    joins: Array<{ kind: "inner" | "left"; on: unknown }>;
    orderBy: unknown[];
  }>,
  index: -1,
}));

// A drizzle SELECT chain that records every argument and resolves at the
// terminal its plan entry names. Nothing is swallowed: `where`, the joins and
// `orderBy` are all captured, because a stub that ignores an argument does not
// merely fail to test it — it makes every assertion in the file assert that the
// argument does not matter.
const chain: Record<string, unknown> = vi.hoisted(() => {
  const self: Record<string, unknown> = {};
  const current = () => control.captured[control.index];
  const isTerminal = (method: Terminal) => control.plan[control.index]?.terminal === method;
  const rows = () => control.plan[control.index]?.rows ?? [];

  self.select = (projection: unknown) => {
    control.index += 1;
    control.captured.push({ projection, where: null, joins: [], orderBy: [] });
    return self;
  };
  self.from = () => self;
  self.innerJoin = (_table: unknown, on: unknown) => {
    current()?.joins.push({ kind: "inner", on });
    return self;
  };
  self.leftJoin = (_table: unknown, on: unknown) => {
    current()?.joins.push({ kind: "left", on });
    return self;
  };
  self.where = (predicate: unknown) => {
    const captured = current();
    if (captured) captured.where = predicate;
    return isTerminal("where") ? Promise.resolve(rows()) : self;
  };
  self.orderBy = (...args: unknown[]) => {
    current()?.orderBy.push(...args);
    return isTerminal("orderBy") ? Promise.resolve(rows()) : self;
  };
  self.limit = () => (isTerminal("limit") ? Promise.resolve(rows()) : self);
  return self;
});

// A PARTIAL mock: only `db` is replaced. The table objects stay REAL, because the
// use-case builds a drizzle query out of them and because half the app's infra
// transitively imports this module — a hand-written object would report a missing
// export as a broken FILE, the one red `/CLAUDE.md` says may never be committed.
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, db: chain };
});

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  readBookableOffering,
  searchBookableOfferings,
} from "@/src/modules/events/application/booking/search-bookable-slots";

const dialect = new PgDialect();
const compile = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL);

function offeringRow(over: Record<string, unknown> = {}) {
  return {
    offeringToken: "SVO-7K2M-9QX4",
    offeringId: OFFERING_ID,
    displayName: "Campaña antirrábica — Plaza San Martín",
    description: null,
    serviceKind: "vaccination_rabies",
    durationMinutes: 15,
    priceArs: null,
    jurisdictionProvince: "Río Negro",
    jurisdictionLocality: "San Carlos de Bariloche",
    organizationId: "33333333-3333-4333-8333-333333333333",
    orgDisplayName: "Zoonosis Bariloche",
    orgPhone: "+54 294 442-0000",
    orgLocality: "San Carlos de Bariloche",
    providerDisplayName: null,
    providerMatricula: null,
    providerPhone: null,
    ...over,
  };
}

const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

beforeEach(() => {
  control.plan = [];
  control.captured = [];
  control.index = -1;
});

describe("searchBookableOfferings — the offering filter", () => {
  it("asks for the service kind AND an approved offering, with the values bound", async () => {
    control.plan = [
      { terminal: "where", rows: [offeringRow()] },
      { terminal: "orderBy", rows: [{ serviceOfferingId: OFFERING_ID, startsAt: at(60) }] },
    ];

    await searchBookableOfferings({
      serviceKind: "vaccination_rabies",
      province: null,
      locality: null,
      fromDate: null,
      freeOnly: false,
      now: NOW,
    });

    const query = compile(control.captured[0]?.where);
    // EQUALITY, never `toContain`. `and(eq(kind), sql\`true\`)` keeps every
    // substring a containment check would look for and stops filtering.
    expect(query.sql).toBe(
      '("service_offerings"."service_kind" = $1 and "service_offerings"."status" = $2)',
    );
    // The PARAMS are half the assertion: an `OR TRUE` that leaves them untouched
    // is killed by the text, and a predicate reading the wrong column is killed
    // by these.
    expect(query.params).toEqual(["vaccination_rabies", "approved"]);
  });

  it("adds locality by SUBSUMPTION and never by equality, so a province-wide campaign is reachable", async () => {
    // The defect this pins was LIVE on staging on 2026-08-13: an offering tagged
    // to the whole province was invisible to every barrio search inside it, so the
    // campaign covering all of CABA reached nobody in CABA.
    control.plan = [{ terminal: "where", rows: [] }];

    await searchBookableOfferings({
      serviceKind: "vaccination_rabies",
      province: "Río Negro",
      locality: "San Carlos de Bariloche",
      fromDate: null,
      freeOnly: false,
      now: NOW,
    });

    const query = compile(control.captured[0]?.where);
    expect(query.sql).toBe(
      '("service_offerings"."service_kind" = $1 and "service_offerings"."status" = $2 and "service_offerings"."jurisdiction_province" = $3 and "service_offerings"."jurisdiction_locality" in ($4, $5))',
    );
    // TWO accepted localities, not one: the barrio itself and the whole-province
    // sentinel. `in ($4)` alone would be the equality this case exists to forbid.
    expect(query.params).toEqual([
      "vaccination_rabies",
      "approved",
      "Río Negro",
      "San Carlos de Bariloche",
      "",
    ]);
  });

  it("adds `price_ars IS NULL` only when solo_gratis was asked for", async () => {
    control.plan = [{ terminal: "where", rows: [] }];
    await searchBookableOfferings({
      serviceKind: "vaccination_rabies",
      province: null,
      locality: null,
      fromDate: null,
      freeOnly: true,
      now: NOW,
    });
    expect(compile(control.captured[0]?.where).sql).toBe(
      '("service_offerings"."service_kind" = $1 and "service_offerings"."status" = $2 and "service_offerings"."price_ars" is null)',
    );
  });
});

describe("searchBookableOfferings — the slot window", () => {
  it("binds the window through the typed helper and compares capacity COLUMN to COLUMN", async () => {
    control.plan = [
      { terminal: "where", rows: [offeringRow()] },
      { terminal: "orderBy", rows: [] },
    ];

    await searchBookableOfferings({
      serviceKind: "vaccination_rabies",
      province: null,
      locality: null,
      fromDate: null,
      freeOnly: false,
      now: NOW,
    });

    const query = compile(control.captured[1]?.where);
    // The rule-liveness term (T1-L16, lib/infra/slot-rule-liveness.ts) is the
    // same predicate bookSlotWriter re-checks under the lock, so this read never
    // advertises a slot of a deleted/paused/ended schedule rule.
    expect(query.sql).toBe(
      `("time_slots"."service_offering_id" in ($1) and "time_slots"."status" = $2 and ("time_slots"."rule_id" is null or exists (select 1 from service_schedule_rules ssr where ssr.id = "time_slots"."rule_id" and ssr.status = 'active' and ("time_slots"."starts_at" at time zone ssr.timezone)::date >= ssr.effective_from and (ssr.effective_until is null or ("time_slots"."starts_at" at time zone ssr.timezone)::date <= ssr.effective_until))) and "time_slots"."starts_at" >= $3 and "time_slots"."starts_at" <= $4 and "time_slots"."bookings_count" < "time_slots"."capacity")`,
    );
    // The capacity comparison carries NO param — it is two identifiers, which is
    // what makes it mean "this slot has room" rather than "this slot has room
    // for N", and what keeps it out of `no-raw-date-in-sql`'s way.
    //
    // THE TWO BOUNDS ARE ISO STRINGS AND NOT `Date` OBJECTS, and that is the
    // point of asserting them here rather than a detail of the assertion:
    // `gte`/`lte` run the column's own timestamp mapper, which is exactly the
    // `.toISOString()` that fence demands — done by the typed helper instead of
    // by hand in a `sql` template, which is where the crash that took down three
    // admin pages came from.
    expect(query.params).toEqual([
      OFFERING_ID,
      "open",
      "2026-08-30T12:00:00.000Z",
      "2026-09-06T12:00:00.000Z",
    ]);
  });

  it("never moves the floor backwards, so a past `fecha_desde` is `now`", async () => {
    control.plan = [
      { terminal: "where", rows: [offeringRow()] },
      { terminal: "orderBy", rows: [] },
    ];

    await searchBookableOfferings({
      serviceKind: "vaccination_rabies",
      province: null,
      locality: null,
      fromDate: new Date("2020-01-01T00:00:00.000Z"),
      freeOnly: false,
      now: NOW,
    });

    expect(compile(control.captured[1]?.where).params[2]).toBe("2026-08-30T12:00:00.000Z");
  });

  it("honours a `fecha_desde` that is ahead of now", async () => {
    control.plan = [
      { terminal: "where", rows: [offeringRow()] },
      { terminal: "orderBy", rows: [] },
    ];
    const tomorrow = new Date("2026-08-31T00:00:00.000Z");

    await searchBookableOfferings({
      serviceKind: "vaccination_rabies",
      province: null,
      locality: null,
      fromDate: tomorrow,
      freeOnly: false,
      now: NOW,
    });

    expect(compile(control.captured[1]?.where).params[2]).toBe(tomorrow.toISOString());
  });

  it("asks NOTHING about slots when no offering matched", async () => {
    // Not an optimisation — an `IN ()` over an empty array is a query that either
    // errors or matches everything depending on the driver, and the second is a
    // whole-table scan of `time_slots` behind a filter nobody wrote.
    control.plan = [{ terminal: "where", rows: [] }];

    const results = await searchBookableOfferings({
      serviceKind: "vaccination_rabies",
      province: null,
      locality: null,
      fromDate: null,
      freeOnly: false,
      now: NOW,
    });

    expect(results).toEqual([]);
    expect(control.captured).toHaveLength(1);
  });
});

describe("searchBookableOfferings — what comes back", () => {
  it("drops an offering with no takeable slot and orders the rest soonest-first", async () => {
    const OTHER = "44444444-4444-4444-8444-444444444444";
    const EMPTY = "55555555-5555-4555-8555-555555555555";
    control.plan = [
      {
        terminal: "where",
        rows: [
          offeringRow(),
          offeringRow({ offeringId: OTHER, offeringToken: "SVO-AAAA-BBBB" }),
          offeringRow({ offeringId: EMPTY, offeringToken: "SVO-CCCC-DDDD" }),
        ],
      },
      {
        terminal: "orderBy",
        rows: [
          { serviceOfferingId: OTHER, startsAt: at(30) },
          { serviceOfferingId: OFFERING_ID, startsAt: at(60) },
          { serviceOfferingId: OFFERING_ID, startsAt: at(90) },
        ],
      },
    ];

    const results = await searchBookableOfferings({
      serviceKind: "vaccination_rabies",
      province: null,
      locality: null,
      fromDate: null,
      freeOnly: false,
      now: NOW,
    });

    expect(results.map((r) => r.offeringToken)).toEqual(["SVO-AAAA-BBBB", "SVO-7K2M-9QX4"]);
    expect(results.map((r) => r.slotsInWindow)).toEqual([1, 2]);
    expect(results[0]?.nextSlotAt).toEqual(at(30));
  });

  it("keeps `null` for a free service rather than turning it into 0", async () => {
    control.plan = [
      { terminal: "where", rows: [offeringRow({ priceArs: null })] },
      { terminal: "orderBy", rows: [{ serviceOfferingId: OFFERING_ID, startsAt: at(60) }] },
    ];
    const [result] = await searchBookableOfferings({
      serviceKind: "vaccination_rabies",
      province: null,
      locality: null,
      fromDate: null,
      freeOnly: false,
      now: NOW,
    });
    // `Number(null)` is 0, and "$0" is a different claim from "Gratuito".
    expect(result?.priceArs).toBe(null);
  });

  it("reads `numeric` back as a number, since the driver hands it over as a string", async () => {
    control.plan = [
      { terminal: "where", rows: [offeringRow({ priceArs: "12500.00" })] },
      { terminal: "orderBy", rows: [{ serviceOfferingId: OFFERING_ID, startsAt: at(60) }] },
    ];
    const [result] = await searchBookableOfferings({
      serviceKind: "vaccination_rabies",
      province: null,
      locality: null,
      fromDate: null,
      freeOnly: false,
      now: NOW,
    });
    expect(result?.priceArs).toBe(12_500);
  });

  it("labels coverage from the OFFERING and never from the organisation's address", async () => {
    // On 2026-08-13 the web's detail page printed the org's locality while the
    // search matched the offering's, so the label named a place the search
    // rejects. Here the two columns are deliberately made to disagree.
    control.plan = [
      {
        terminal: "where",
        rows: [
          offeringRow({
            jurisdictionLocality: "Dina Huapi",
            orgLocality: "San Carlos de Bariloche",
          }),
        ],
      },
      { terminal: "orderBy", rows: [{ serviceOfferingId: OFFERING_ID, startsAt: at(60) }] },
    ];
    const [result] = await searchBookableOfferings({
      serviceKind: "vaccination_rabies",
      province: null,
      locality: null,
      fromDate: null,
      freeOnly: false,
      now: NOW,
    });
    expect(result?.coverageLabel).toBe("Dina Huapi");
  });

  it("resolves the organization's provider.locality from the OFFERING too, never the org's own address", async () => {
    // Same root cause as the coverageLabel case above, one field over: fixed
    // 2026-09-04. `resolveProvider` used to read `organizations.jurisdiction_
    // locality` (a decoy here, "San Carlos de Bariloche") for this nested
    // field even after `coverageLabel` was fixed in 2026-08-13 to read the
    // offering's own column. The two columns are deliberately made to
    // disagree, exactly as above.
    control.plan = [
      {
        terminal: "where",
        rows: [
          offeringRow({
            jurisdictionLocality: "Dina Huapi",
            orgLocality: "San Carlos de Bariloche",
          }),
        ],
      },
      { terminal: "orderBy", rows: [{ serviceOfferingId: OFFERING_ID, startsAt: at(60) }] },
    ];
    const [result] = await searchBookableOfferings({
      serviceKind: "vaccination_rabies",
      province: null,
      locality: null,
      fromDate: null,
      freeOnly: false,
      now: NOW,
    });
    expect(result?.provider).toEqual({
      kind: "organization",
      displayName: "Zoonosis Bariloche",
      phone: "+54 294 442-0000",
      locality: "Dina Huapi",
    });
  });
});

describe("readBookableOffering — the offering lookup", () => {
  it("demands an APPROVED offering in the same predicate as the token", async () => {
    control.plan = [{ terminal: "limit", rows: [] }];

    const detail = await readBookableOffering({
      offeringToken: "SVO-7K2M-9QX4",
      userId: USER,
      now: NOW,
    });

    expect(detail).toBe(null);
    const query = compile(control.captured[0]?.where);
    expect(query.sql).toBe(
      '("service_offerings"."public_token" = $1 and "service_offerings"."status" = $2)',
    );
    expect(query.params).toEqual(["SVO-7K2M-9QX4", "approved"]);
    // AND NOTHING ELSE RAN. A lookup that missed and still asked for slots and
    // pets would be a 404 wrapped around two completed reads.
    expect(control.captured).toHaveLength(1);
  });
});

describe("readBookableOffering — which pets may be offered", () => {
  async function runDetail(petRows: Array<Record<string, unknown>>) {
    control.plan = [
      { terminal: "limit", rows: [offeringRow()] },
      {
        terminal: "orderBy",
        rows: [{ slotId: "aaaa", startsAt: at(60), endsAt: at(75), capacity: 3, bookingsCount: 1 }],
      },
      { terminal: "orderBy", rows: petRows },
    ];
    return readBookableOffering({ offeringToken: "SVO-7K2M-9QX4", userId: USER, now: NOW });
  }

  it("binds the caller's id, an active ownership, a live animal and a live record", async () => {
    // THE WHOLE AUTHORIZATION BOUNDARY OF THE PICKER, in one predicate. There is
    // no RLS under it (the read runs on the service-role handle) and no pet-access
    // guard above it. A tautology here would offer somebody else's animals.
    await runDetail([]);

    const query = compile(control.captured[2]?.where);
    expect(query.sql).toBe(
      '("ownerships"."owner_user_id" = $1 and "ownerships"."ended_at" is null and "pets"."status" <> $2 and "pets"."deleted_at" is null)',
    );
    expect(query.params).toEqual([USER, "deceased"]);
  });

  it("joins the animal's existing booking on THIS offering, confirmed only", async () => {
    await runDetail([]);

    const join = control.captured[2]?.joins.find((j) => j.kind === "left");
    const query = compile(join?.on);
    expect(query.sql).toBe(
      '("appointments"."pet_id" = "pets"."id" and "appointments"."service_offering_id" = $1 and "appointments"."status" = $2)',
    );
    // The OFFERING id and not the slot id: the guard `bookSlotWriter` enforces is
    // per (pet, offering), which is what stopped one animal eating the 08:00 AND
    // the 08:15 of one free campaign.
    expect(query.params).toEqual([OFFERING_ID, "confirmed"]);
  });

  it("reports a pet that already holds a place as blocked rather than hiding it", async () => {
    const detail = await runDetail([
      { publicToken: "DIM-PAMP-0001", name: "Pampa", bookedAppointmentId: null },
      { publicToken: "DIM-LOLA-0002", name: "Lola", bookedAppointmentId: "some-uuid" },
    ]);

    expect(detail?.pets).toEqual([
      { publicToken: "DIM-PAMP-0001", name: "Pampa", canBook: true, blockedReason: null },
      {
        publicToken: "DIM-LOLA-0002",
        name: "Lola",
        canBook: false,
        blockedReason: "already_booked_in_offering",
      },
    ]);
  });

  it("counts places left from capacity and bookings, never from capacity alone", async () => {
    const detail = await runDetail([]);
    expect(detail?.slots).toEqual([
      { slotId: "aaaa", startsAt: at(60), endsAt: at(75), placesLeft: 2 },
    ]);
  });

  it("uses the SIXTY-day window for the grid, not the list's seven", async () => {
    await runDetail([]);
    const query = compile(control.captured[1]?.where);
    expect(query.params).toEqual([
      OFFERING_ID,
      "open",
      "2026-08-30T12:00:00.000Z",
      "2026-10-29T12:00:00.000Z",
    ]);
  });
});
