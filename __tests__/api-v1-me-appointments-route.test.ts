// `/api/v1/me/appointments` — the read's clock rules, and the write's refusals.
//
// WHAT THIS FILE IS ACTUALLY ABOUT
// ---------------------------------------------------------------------------
// Three facts on this payload are functions of the SERVER'S clock — which of the
// three sections a row is in, whether it can still be cancelled, whether its
// check-in QR is still good — and the whole reason they are on the wire is that a
// phone's clock cannot be trusted with them. So most of this file is a clock:
// fixed `now`, rows placed either side of it, and assertions about which bucket
// and which capability came back.
//
// The second half is the refusal table. `cancelAppointmentByOwner` answers es-AR
// prose, and this endpoint has to translate it into the contract's closed code
// vocabulary. `every sentence the writer can return is in the table` is the test
// that keeps the two from drifting: the table matches sentences EXACTLY, so a
// reworded refusal silently degrades to a 500 for something that is not a server
// failure, and this is what makes that loud.
//
// THE DB IS STUBBED, THE USE-CASE IS NOT. `listAppointmentsForUser` is what does
// the bucketing, so mocking it would delete the subject of half this file. What
// is stubbed is the drizzle chain under it, which hands back rows.

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const ME = "11111111-1111-4111-8111-111111111111";
/** A second live account, used to prove the WHERE follows the SESSION. */
const SOMEBODY_ELSE = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
/** The address the stubbed `callerIp` reports, so the IP gates can be told apart. */
const CALLER_IP = "200.5.4.3";

const NOW = new Date("2026-08-29T15:00:00.000Z");

const control = vi.hoisted(() => ({
  /**
   * What the liveness guard answers. `null` = a live session for `ME`.
   *
   * IT WAS DECLARED AND NEVER ASSIGNED until the authorization tests below
   * landed, which is worse than not having it: scaffolding for a case nobody
   * exercises advertises coverage that does not exist. It is now the instrument
   * for two things — the five refusal reasons, and the proof that the read's
   * WHERE is bound to whoever the guard says is calling.
   */
  live: null as null | (() => unknown),
  /** Rows the stubbed drizzle chain resolves with. */
  rows: [] as Array<Record<string, unknown>>,
  /** The predicate the use-case handed to `.where()`, uncompiled. */
  wherePredicate: null as unknown,
  /** The column map the use-case handed to `.select()`. */
  projection: null as unknown,
  /** Every join the use-case built, with the method it used to build it. */
  joins: [] as Array<{ kind: "inner" | "left"; on: unknown }>,
  /** Buckets that should answer 429 instead of proceeding. */
  overLimit: new Set<string>(),
  /**
   * Every bucket a handler tried to spend, WITH the identifier it keyed on.
   *
   * IT USED TO BE `string[]` — the bucket name alone — and that was a DECLARED
   * DEBT on the board naming this file as its owner: the stub read
   * `enforceRateLimit: async (endpoint: string)` and dropped the second argument,
   * so collapsing all four gates onto shared constants left this file 36/36
   * green. Ten sibling route tests already took the pair. This one does now.
   */
  spent: [] as Array<{ endpoint: string; identifier: string }>,
  /**
   * Buckets whose limiter is BROKEN — it throws something that is not a
   * `RateLimitError`, the way an unreachable `rate_limit_buckets` table would.
   * Distinct from `overLimit` on purpose: the two must produce OPPOSITE answers,
   * and that is the second declared debt this file owned.
   */
  limiterBroken: new Set<string>(),
  /** What the cancel writer answers. */
  cancelResult: { ok: true } as Record<string, unknown>,
  /** Every call the cancel writer received. */
  cancelCalls: [] as Array<{ token: string; userId: string }>,
  /** What the BOOKING writer answers. */
  bookResult: { ok: true, appointmentToken: "APT-NEW-0001" } as Record<string, unknown>,
  /** Every call the booking writer received. */
  bookCalls: [] as Array<{ slotId: string; petPublicToken: string; userId: string }>,
}));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      control.live ? control.live() : { ok: true, supabase: {}, user: { id: ME }, profile: null },
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    // RECORDS THE BUCKET AND CAN REFUSE ONE. The old stub swallowed every call,
    // which made the four gates unfalsifiable: no test could tell a handler that
    // spends its budgets from one that never calls the limiter at all.
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.spent.push({ endpoint, identifier });
      if (control.limiterBroken.has(endpoint)) {
        throw new Error("rate_limit_buckets is unreachable");
      }
      if (control.overLimit.has(endpoint)) {
        throw new actual.RateLimitError(new Date(), endpoint);
      }
    },
    callerIp: () => CALLER_IP,
  };
});

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

// A drizzle SELECT chain that answers `control.rows`.
//
// `where` is the TERMINAL call in the use-case's one query, so it is the method
// that resolves; every other builder just hands the chain back. A thenable would
// have been shorter and is banned (`noThenProperty`) for good reason — an object
// with a `then` is awaited by anything that touches it, including a stray
// `Promise.resolve(chain)` somewhere in the stack — and naming the terminal call
// is better documentation anyway: change the query's shape and this stub stops
// resolving, loudly, instead of quietly answering the old rows.
//
// THE JOINS AND THE WHERE ARE CAPTURED, NOT SWALLOWED, and that is the whole
// repair this stub needed. It used to read `self.where = async () => rows`,
// which discards the predicate — so `.where(eq(appointments.ownerUserId, …))`
// had ZERO coverage and a reviewer's mutation of it to a tautology left the file
// 21/21 green with three authorization tests still passing. A stub that ignores
// the argument does not merely fail to test it; it makes the whole file assert
// that the argument does not matter.
const chain: Record<string, unknown> = vi.hoisted(() => {
  const self: Record<string, unknown> = {};
  for (const method of ["from", "orderBy", "limit"]) {
    self[method] = () => self;
  }
  self.select = (projection: unknown) => {
    control.projection = projection;
    return self;
  };
  self.innerJoin = (_table: unknown, on: unknown) => {
    control.joins.push({ kind: "inner", on });
    return self;
  };
  self.leftJoin = (_table: unknown, on: unknown) => {
    control.joins.push({ kind: "left", on });
    return self;
  };
  self.where = async (predicate: unknown) => {
    control.wherePredicate = predicate;
    return control.rows;
  };
  return self;
});

// A PARTIAL mock: only `db` is replaced. The table objects stay real, because
// the use-case builds a drizzle query out of them and because half the app's
// infra transitively imports this module for tables this file has never heard of
// — a hand-written object would report a missing export as a broken FILE, which
// is the one red `/CLAUDE.md` says may never be committed.
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, db: chain };
});

vi.mock("@/src/modules/events/application/booking/cancel-appointment-by-owner", () => ({
  cancelAppointmentByOwner: async (token: string, userId: string) => {
    control.cancelCalls.push({ token, userId });
    return control.cancelResult;
  },
}));

// THE BOOKING USE-CASE IS MOCKED HERE AND ITS PREDICATE IS TESTED ELSEWHERE.
// `bookSlotForUser` carries the ownership guard, and mocking it in this file is
// only legitimate because that guard has its own compiled-SQL fence next to it
// (`src/modules/events/application/booking/__tests__/book-slot-for-user.test.ts`).
// What this file is for is the DOOR: which budgets it spends, which id it acts
// as, and how a typed refusal becomes a status.
vi.mock("@/src/modules/events/application/booking/book-slot-for-user", () => ({
  bookSlotForUser: async (args: { slotId: string; petPublicToken: string; userId: string }) => {
    control.bookCalls.push(args);
    return control.bookResult;
  },
}));

import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { APPOINTMENT_REFUSAL_RULES, BOOK_REFUSALS } from "@/app/api/v1/me/appointments/commands";
import { GET, POST } from "@/app/api/v1/me/appointments/route";
import { API_V1_ERROR_CODES, type MyAppointmentV1, type MyAppointmentsV1 } from "@dim/contract/api";

/**
 * Compiles a captured drizzle fragment to the SQL text and bound params Postgres
 * would actually receive.
 *
 * THIS IS WHAT MAKES A PREDICATE TESTABLE WITHOUT A DATABASE. The alternative
 * available to a stubbed driver is reading the use-case's source for a substring,
 * which is what the Art. 16 join had and which cannot fail for a predicate that
 * is still WRITTEN and no longer BINDS — `or(isNull(pets.deletedAt), sql`true`)`
 * contains the substring. Compiling answers the only question worth asking: what
 * does the database get?
 */
const dialect = new PgDialect();
const compile = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL);

/** Minutes either side of the frozen `now`, as a Date. */
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

function row(over: Record<string, unknown> = {}) {
  return {
    appointmentToken: "APT-7K2M-9QX4",
    status: "confirmed",
    organizationId: ORG_ID,
    startsAt: at(60),
    endsAt: at(75),
    offeringName: "Campaña antirrábica — Plaza San Martín",
    serviceKind: "vaccination_rabies",
    durationMinutes: 15,
    priceArs: null,
    petPublicToken: "DIM-PAMP-0001",
    petName: "Pampa",
    orgDisplayName: "Zoonosis Bariloche",
    orgPhone: "+54 294 442-0000",
    // The OFFERING's own locality (`serviceOfferings.jurisdictionLocality`),
    // not the organisation's registered address — see `resolveProvider`.
    offeringLocality: "San Carlos de Bariloche",
    providerDisplayName: null,
    providerMatricula: null,
    providerPhone: null,
    ...over,
  };
}

function get() {
  return GET(new Request("https://x/api/v1/me/appointments", { headers: { authorization: "b" } }));
}

function post(body: unknown) {
  return POST(
    new Request("https://x/api/v1/me/appointments", {
      method: "POST",
      headers: { authorization: "b", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function payloadOf(response: Response): Promise<MyAppointmentsV1> {
  return (await response.json()) as MyAppointmentsV1;
}

/** Make the liveness guard answer a live session for `userId`. */
function liveAs(userId: string) {
  control.live = () => ({ ok: true, supabase: {}, user: { id: userId }, profile: null });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  control.live = null;
  control.rows = [];
  control.wherePredicate = null;
  control.projection = null;
  control.joins = [];
  control.overLimit = new Set();
  control.limiterBroken = new Set();
  control.spent = [];
  control.cancelResult = { ok: true };
  control.cancelCalls = [];
  control.bookResult = { ok: true, appointmentToken: "APT-NEW-0001" };
  control.bookCalls = [];
});

describe("GET — the three sections are the server's clock, not the client's", () => {
  it("files a confirmed turno that has not finished under `upcoming`, soonest first", async () => {
    control.rows = [
      row({ appointmentToken: "APT-LATER", startsAt: at(600), endsAt: at(615) }),
      row({ appointmentToken: "APT-SOONER", startsAt: at(30), endsAt: at(45) }),
    ];

    const body = await payloadOf(await get());

    expect(body.upcoming.map((a) => a.appointmentToken)).toEqual(["APT-SOONER", "APT-LATER"]);
    expect(body.past).toEqual([]);
    expect(body.cancelled).toEqual([]);
  });

  it("keeps a turno IN PROGRESS under `upcoming`, which is where its QR is looked for", async () => {
    // THE ONE DELIBERATE DIVERGENCE FROM THE WEB. The browser buckets on
    // `starts_at >= now`, so a consultation that began ten minutes ago is filed
    // under "Pasados" while its check-in QR is still valid — somebody arriving
    // late goes looking under the wrong heading for the code they need.
    control.rows = [row({ startsAt: at(-10), endsAt: at(5) })];

    const body = await payloadOf(await get());

    expect(body.upcoming).toHaveLength(1);
    const item = body.upcoming[0] as MyAppointmentV1;
    expect(item.section).toBe("upcoming");
    // Still checkable in, no longer cancellable. That is the honest state of a
    // consultation in progress, and it is why the two flags are separate.
    expect(item.capabilities).toEqual({ canCancel: false, canCheckIn: true });
  });

  it("moves a confirmed turno to `past` once its slot has ENDED, with both flags off", async () => {
    control.rows = [row({ startsAt: at(-120), endsAt: at(-105) })];

    const body = await payloadOf(await get());

    expect(body.upcoming).toEqual([]);
    expect(body.past).toHaveLength(1);
    expect((body.past[0] as MyAppointmentV1).capabilities).toEqual({
      canCancel: false,
      canCheckIn: false,
    });
  });

  it("files attended under `past` and the three terminal states under `cancelled`", async () => {
    control.rows = [
      row({ appointmentToken: "APT-ATT", status: "attended", startsAt: at(-1440) }),
      row({ appointmentToken: "APT-OWN", status: "cancelled_by_owner", startsAt: at(-60) }),
      row({ appointmentToken: "APT-ORG", status: "cancelled_by_org", startsAt: at(-30) }),
      row({ appointmentToken: "APT-NOS", status: "no_show", startsAt: at(-90) }),
    ];

    const body = await payloadOf(await get());

    expect(body.past.map((a) => a.appointmentToken)).toEqual(["APT-ATT"]);
    // Newest first.
    expect(body.cancelled.map((a) => a.appointmentToken)).toEqual([
      "APT-ORG",
      "APT-OWN",
      "APT-NOS",
    ]);
  });

  it("never offers a capability on a terminal row, whatever the clock says", async () => {
    // A turno the clinic cancelled whose slot is still in the FUTURE. The naive
    // predicate — "the slot has not started, so you may cancel" — would offer
    // Cancelar on something already cancelled and a QR for a turno nobody holds.
    control.rows = [
      row({ status: "cancelled_by_org", startsAt: at(120), endsAt: at(135) }),
      row({ status: "no_show", startsAt: at(120), endsAt: at(135) }),
    ];

    const body = await payloadOf(await get());

    for (const item of body.cancelled) {
      expect(item.capabilities).toEqual({ canCancel: false, canCheckIn: false });
    }
  });

  it("drops a row whose status the CHECK constraint cannot produce, rather than defaulting it", async () => {
    // The web's detail page used to fall through an unrecognised status to the
    // green "Confirmado" badge (state-honesty audit). Saying nothing about a row
    // we cannot classify is the honest answer; bucketing it as confirmed is not.
    control.rows = [row({ status: "cancelled" }), row({ status: "rescheduled" })];

    const body = await payloadOf(await get());

    expect(body.upcoming).toEqual([]);
    expect(body.past).toEqual([]);
    expect(body.cancelled).toEqual([]);
  });
});

describe("GET — what each row carries", () => {
  it("resolves an org-booked turno to the organization arm, phone included", async () => {
    control.rows = [row()];
    const [item] = (await payloadOf(await get())).upcoming;

    expect(item?.provider).toEqual({
      kind: "organization",
      displayName: "Zoonosis Bariloche",
      phone: "+54 294 442-0000",
      locality: "San Carlos de Bariloche",
    });
  });

  it("uses the OFFERING's own locality, never the organisation's registered address", async () => {
    // Root cause of the QA bug found 2026-09-04: this query used to select
    // `organizations.jurisdiction_locality` here, so every turno booked with
    // an org read that org's OWN address regardless of which offering (which
    // may run outreach campaigns in other neighbourhoods) was actually
    // booked — the La Matanza and Palermo pilot offerings both read
    // "Recoleta". Same bug, same fix as `coverageLabel` in
    // `appointment-search.ts` shipped for search on 2026-08-13.
    control.rows = [
      row({
        // A decoy under the OLD key: if `resolveProvider` ever reads this
        // again instead of `offeringLocality`, this assertion catches it.
        orgLocality: "Recoleta",
        offeringLocality: "La Matanza",
      }),
    ];
    const [item] = (await payloadOf(await get())).upcoming;

    expect(item?.provider).toEqual({
      kind: "organization",
      displayName: "Zoonosis Bariloche",
      phone: "+54 294 442-0000",
      locality: "La Matanza",
    });
  });

  it("resolves an independent vet to the professional arm and never to the org one", async () => {
    control.rows = [
      row({
        organizationId: null,
        orgDisplayName: null,
        orgPhone: null,
        providerDisplayName: "Ana Beatriz Rossi",
        providerMatricula: "MP 4821",
        providerPhone: "+54 294 415-1111",
      }),
    ];
    const [item] = (await payloadOf(await get())).upcoming;

    expect(item?.provider).toEqual({
      kind: "professional",
      displayName: "Ana Beatriz Rossi",
      matriculaNumber: "MP 4821",
      phone: "+54 294 415-1111",
    });
  });

  it("answers `unknown` when the LEFT join found nobody, instead of inventing a name", async () => {
    control.rows = [row({ orgDisplayName: null, orgPhone: null })];
    const [item] = (await payloadOf(await get())).upcoming;

    expect(item?.provider).toEqual({ kind: "unknown" });
  });

  it("keeps a free service as null and never as zero", async () => {
    // `Number(null)` is 0, and "Gratuito" and "$0" are different claims — the
    // first is a campaign, the second is a price somebody set.
    control.rows = [
      row({ priceArs: null }),
      row({ appointmentToken: "APT-P", priceArs: "1500.00" }),
    ];
    const items = (await payloadOf(await get())).upcoming;

    expect(items.find((i) => i.appointmentToken === "APT-7K2M-9QX4")?.priceArs).toBe(null);
    // And the numeric column's STRING arrives as a number, once, here.
    expect(items.find((i) => i.appointmentToken === "APT-P")?.priceArs).toBe(1500);
  });

  it("labels a known service kind and answers null for one outside the catalogue", async () => {
    control.rows = [
      row({ serviceKind: "vaccination_rabies" }),
      row({ appointmentToken: "APT-X", serviceKind: "seeded_outside_the_catalogue" }),
    ];
    const items = (await payloadOf(await get())).upcoming;

    expect(items.find((i) => i.appointmentToken === "APT-7K2M-9QX4")?.serviceKindLabel).toBe(
      "Vacunación antirrábica",
    );
    // NOT the raw code echoed back. A client that printed a snake_case string at
    // somebody is the shape the buscar page was fixed for (QA S3-F07).
    expect(items.find((i) => i.appointmentToken === "APT-X")?.serviceKindLabel).toBe(null);
  });

  it("carries no owner notes at all — neither plaintext column is selected", async () => {
    control.rows = [row({ notesFromOwner: "mi perro muerde", notesFromOrg: "revisar cadera" })];
    const raw = JSON.stringify(await payloadOf(await get()));

    expect(raw).not.toContain("muerde");
    expect(raw).not.toContain("cadera");
  });

  it("never asks the database for either notes column in the first place", async () => {
    // THE TEST ABOVE ALONE IS DECORATION AND SAYING SO IS THE POINT: its rows
    // are a fixture this file writes, so it proves the payload builder does not
    // forward unknown keys — never that the QUERY leaves the columns alone. Add
    // `notesFromOwner: appointments.notesFromOwner` to the SELECT and it stays
    // green, because the fixture's key is what it was already reading.
    //
    // `notes_from_owner` and `notes_from_org` are plaintext columns the Ley
    // 25.326 sweep named, and neither belongs on a citizen wallet's wire — the
    // org's note in particular is a clinical remark written for the clinic. So
    // the projection itself is asserted, out of what the use-case handed
    // drizzle.
    await get();

    // A bare `Column` is not an SQL fragment, so each one is wrapped in a
    // template first — `sql`${column}`` is what drizzle itself does to render a
    // projection, and it yields the same qualified name the WHERE assertions
    // above are written against.
    const selected = Object.values(control.projection as Record<string, unknown>).map(
      (column) => compile(sql`${column}`).sql,
    );
    // Non-vacuity: an empty projection would satisfy every `not.toContain` below.
    expect(selected.length).toBeGreaterThanOrEqual(15);
    expect(selected).not.toContain('"appointments"."notes_from_owner"');
    expect(selected).not.toContain('"appointments"."notes_from_org"');
    // And the row's own token IS asked for, which is what makes the two
    // assertions above a statement about this query rather than about a stub
    // that captured nothing.
    expect(selected).toContain('"appointments"."public_token"');

    // Same projection, same `selected` array — pinning the turno-locality
    // regression here too instead of a second query-compile test. QA bug
    // found 2026-09-04: this query used to select
    // `organizations.jurisdiction_locality`, so every turno read the ORG's
    // own registered address regardless of which offering was booked. Fixed
    // alongside `coverageLabel` in `appointment-search.ts` (2026-08-13).
    // `resolveProvider` must read the OFFERING's own locality.
    expect(selected).toContain('"service_offerings"."jurisdiction_locality"');
    expect(selected).not.toContain('"organizations"."jurisdiction_locality"');
  });
});

describe("the authorization predicate — whose turnos the query asks for", () => {
  // WHY THIS BLOCK EXISTS, WRITTEN OUT BECAUSE IT IS THE EXPENSIVE LESSON.
  //
  // `listAppointmentsForUser` ends in `.where(eq(appointments.ownerUserId,
  // args.userId))`. That single line is the ONLY thing standing between one
  // citizen and every other citizen's veterinary appointments — there is no RLS
  // fallback on this path (the read runs on the service-role `db` handle) and no
  // pet-access guard above it (`commands.ts` explains, correctly, why there must
  // not be one). It is the whole authorization boundary of this endpoint.
  //
  // It had ZERO coverage. A reviewer mutated it to a tautology returning every
  // user's rows and the file stayed 21/21 green, with three tests that read like
  // authorization fences passing throughout. The cause was not a missing test —
  // it was the stub: `self.where = async () => control.rows` discards its
  // argument, so every assertion in this file was made against rows the
  // predicate had no say over. A stub that ignores an argument silently asserts
  // that the argument does not matter.
  //
  // WHAT THESE TESTS DO INSTEAD is compile the fragment the use-case handed to
  // drizzle and read the SQL and the bound parameters. That is not a live
  // database and it is not claimed to be one: it proves what Postgres is ASKED,
  // not what Postgres answers. The integration suite owns the second half. But
  // "what is it asked" is exactly the half a tautology breaks.

  it("binds the WHERE to the SESSION's user id and follows it when the session changes", async () => {
    // THE BEHAVIOURAL ONE, and the one a text assertion cannot fake. Two live
    // sessions, two reads, and the parameter the database is handed has to be
    // the id the liveness guard just returned — not a constant, not a value
    // from the request, and not nothing at all.
    liveAs(SOMEBODY_ELSE);
    await get();
    expect(compile(control.wherePredicate).params).toEqual([SOMEBODY_ELSE]);

    liveAs(ME);
    await get();
    expect(compile(control.wherePredicate).params).toEqual([ME]);
  });

  it("asks for exactly one condition — the appointment's own owner_user_id", async () => {
    await get();
    const { sql, params } = compile(control.wherePredicate);

    // AN EXACT MATCH ON PURPOSE, and the exactness is the assertion. A
    // `toContain("owner_user_id")` passes for `or(eq(ownerUserId, me), sql`true`)`
    // — the predicate is still written, still mentions the column, and still
    // returns every row in the table. Any edit to an authorization boundary has
    // to be deliberate enough to come here and change this string.
    expect(sql).toBe('"appointments"."owner_user_id" = $1');
    // And the parameter is BOUND rather than interpolated: a comparison with no
    // params is a column compared against a column, which is the other tautology.
    expect(params).toEqual([ME]);
  });

  it("keeps the Art. 16 join on pets an INNER join whose ON clause still binds", async () => {
    // THIS TEST REPLACES A SOURCE-TEXT ANCHOR, and the replacement is the point:
    // the old one read the use-case's own file for `isNull(pets.deletedAt)`. That
    // catches the edit that DELETES the guard and nothing else — it passes for
    // `or(isNull(pets.deletedAt), sql`true`)`, which keeps the substring and
    // stops filtering. Same hole as the WHERE above, one line higher up.
    //
    // WHY THE GUARD MATTERS: `bookSlotAction` accepts any active ownership role,
    // so a foster or a co-owner books with their own id on the appointment. The
    // erasure RPC soft-deletes the `role='owner'` pet and leaves that ownership —
    // and this appointment — standing. Without the predicate an erased animal
    // surfaces to a live third party.
    await get();

    const petsJoin = control.joins.find((j) => compile(j.on).sql.includes('"pets"."id"'));
    // Non-vacuity: a join that stopped being built at all would make every
    // assertion below run over `undefined` and read like a clean pass.
    expect(petsJoin).toBeDefined();

    // INNER AND NOT LEFT, which is half the guard. Demoting it to a LEFT join
    // keeps the ON clause word-for-word and stops it excluding anything: the
    // appointment row survives with every pet column null, and the payload
    // publishes a turno whose animal was erased.
    expect(petsJoin?.kind).toBe("inner");
    expect(compile(petsJoin?.on).sql).toBe(
      '("pets"."id" = "appointments"."pet_id" and "pets"."deleted_at" is null)',
    );
  });

  it("still reads the use-case's source, as a second and weaker witness", () => {
    // KEPT, DEMOTED, AND LABELLED. The compiled assertions above are strictly
    // stronger, so this one earns its place only by failing DIFFERENTLY: it holds
    // when the query is restructured in a way that keeps the compiled SQL
    // identical but moves the guard somewhere a reader would not look for it.
    // It is a second witness, not the fence — and saying so is the difference
    // between documentation and an overclaim.
    const source = readFileSync(
      "src/modules/events/application/booking/list-appointments-for-user.ts",
      "utf8",
    );
    expect(source).toContain("isNull(pets.deletedAt)");
    expect(source).toMatch(/innerJoin\(\s*pets,\s*and\(/);
  });
});

describe("POST — the cancel acts as the SESSION and never as the body", () => {
  it("hands the writer the id the liveness guard returned, for two different sessions", async () => {
    // THE WRITE'S HALF OF THE SAME QUESTION. The read's boundary is a WHERE; the
    // write's is the second argument to `cancelAppointmentByOwner`, which is
    // where that use-case matches `appointments.owner_user_id`. Both have to
    // follow the session, and both are worth proving with two of them rather
    // than one — an assertion against a single id also passes for a constant.
    liveAs(SOMEBODY_ELSE);
    await post({ command: "cancel", appointmentToken: "APT-A", ownerUserId: ME });
    liveAs(ME);
    await post({ command: "cancel", appointmentToken: "APT-B", ownerUserId: SOMEBODY_ELSE });

    expect(control.cancelCalls).toEqual([
      { token: "APT-A", userId: SOMEBODY_ELSE },
      { token: "APT-B", userId: ME },
    ]);
  });
});

describe("the liveness guard's five refusals, on both methods", () => {
  // THE SCAFFOLDING THAT WAS BUILT AND NEVER USED. `control.live` existed from
  // the first commit and no test ever assigned it, so `liveUserRefusal` — five
  // arms mapping a refusal reason to a status — shipped with none of them
  // exercised. Four of the five are the difference between a client that
  // re-authenticates and a client that shows the wrong sentence forever; the
  // fifth (MAINTENANCE) is the only one that must NOT be a 4xx at all.
  const cases: Array<[string, number, string]> = [
    ["NO_SESSION", 401, "auth_expired"],
    ["ACCOUNT_ERASED", 403, "account_erased"],
    ["DEACTIVATED", 403, "account_deactivated"],
    ["SHIFT_EXPIRED", 401, "session_shift_expired"],
    ["MAINTENANCE", 503, "temporarily_unavailable"],
  ];

  for (const [reason, status, code] of cases) {
    it(`answers ${code} for ${reason} on GET and on POST`, async () => {
      control.live = () => ({ ok: false, reason });

      const read = await get();
      expect(read.status).toBe(status);
      expect(await read.json()).toEqual({ error: code });

      const write = await post({ command: "cancel", appointmentToken: "APT-7K2M-9QX4" });
      expect(write.status).toBe(status);
      expect(await write.json()).toEqual({ error: code });

      // AND NEITHER SIDE-EFFECT RAN. A refusal that still queried, or still
      // cancelled, would be a 403 wrapped around a completed action.
      expect(control.wherePredicate).toBe(null);
      expect(control.cancelCalls).toEqual([]);
    });
  }
});

describe("the four rate-limit gates — each one refuses on its own", () => {
  // NONE OF THE FOUR WAS TESTED. The limiter was stubbed to a no-op, so the only
  // thing the file knew about the gates was that they did not throw. Four
  // buckets, two per method, and the pair on each method fires at a DIFFERENT
  // point: the per-IP one before the GoTrue round-trip, the per-user one after
  // it. A test per bucket is what keeps that ordering honest.
  // THE FOURTH COLUMN IS THE IDENTIFIER THE GATE MUST KEY ON, and it is the half
  // this table did not have while the stub dropped the second argument: an IP gate
  // keyed on the user id would still refuse, still be the last bucket spent, and
  // still satisfy every assertion below.
  const gates: Array<[string, "GET" | "POST", boolean, string]> = [
    ["api_v1_me_appointments_read_ip", "GET", false, CALLER_IP],
    ["api_v1_me_appointments_read_user", "GET", true, ME],
    ["api_v1_me_appointments_write_ip", "POST", false, CALLER_IP],
    ["api_v1_me_appointments_write_user", "POST", true, ME],
  ];

  for (const [bucket, method, afterAuth, identifier] of gates) {
    it(`answers 429 when ${bucket} is spent, keyed on the right identifier`, async () => {
      control.overLimit = new Set([bucket]);

      const response =
        method === "GET" ? await get() : await post({ command: "cancel", appointmentToken: "APT" });

      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "rate_limited" });
      // The bucket that refused is the LAST one spent: a gate that let control
      // through to the next budget is a gate that did not bind. And it was spent
      // against the right key — an address for the IP gates, a user id for the
      // user gates.
      expect(control.spent.at(-1)).toEqual({ endpoint: bucket, identifier });
      // The per-IP gate runs BEFORE `requireLiveUser`, so it refuses without a
      // GoTrue round-trip; the per-user gate necessarily runs after one. That
      // ordering is what the IP bucket exists for and it is asserted rather
      // than assumed.
      expect(control.spent.length).toBe(afterAuth ? 2 : 1);
      // Refused means refused: neither the read nor the writer ran.
      expect(control.wherePredicate).toBe(null);
      expect(control.cancelCalls).toEqual([]);
    });
  }

  it("spends both budgets and proceeds when neither is over", async () => {
    // NON-VACUITY for the four above: without this, a stub that threw on every
    // bucket would satisfy all of them and the suite would be asserting that the
    // endpoint always refuses.
    control.rows = [row()];
    const response = await get();

    expect(response.status).toBe(200);
    // THE PAIR, not just the name. The IP gate keys on the caller ADDRESS and the
    // user gate on the user ID; asserting only the bucket names left "collapse all
    // four onto one constant" invisible, which is the debt this closes.
    expect(control.spent).toEqual([
      { endpoint: "api_v1_me_appointments_read_ip", identifier: CALLER_IP },
      { endpoint: "api_v1_me_appointments_read_user", identifier: ME },
    ]);
  });

  it("FAILS OPEN when the limiter itself is broken, on both methods", async () => {
    // THE OTHER DEBT THIS FILE OWNED. The route's docblock argues it at length —
    // "a limiter outage must not stand between somebody and CANCELLING a turno they
    // cannot attend" — and flipping its `return true` to `return false` left this
    // file 36/36 green. Five sibling route files carry a case named exactly this.
    control.limiterBroken = new Set([
      "api_v1_me_appointments_read_ip",
      "api_v1_me_appointments_read_user",
      "api_v1_me_appointments_write_ip",
      "api_v1_me_appointments_write_user",
    ]);
    control.rows = [row()];

    expect((await get()).status).toBe(200);
    expect((await post({ command: "cancel", appointmentToken: "APT-7K2M-9QX4" })).status).toBe(200);
  });

  it("still fails CLOSED on authorization while the limiter is broken", async () => {
    // The pair the case above only half proves: a fail-open limiter must not carry
    // the guard open with it.
    control.limiterBroken = new Set([
      "api_v1_me_appointments_read_ip",
      "api_v1_me_appointments_read_user",
    ]);
    control.live = () => ({ ok: false, reason: "ACCOUNT_ERASED" });

    const response = await get();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "account_erased" });
    expect(control.wherePredicate).toBe(null);
  });
});

describe("POST — the one command, and who it acts as", () => {
  it("cancels and acks, passing the caller id from the SESSION and not from the body", async () => {
    const response = await post({
      command: "cancel",
      appointmentToken: "APT-7K2M-9QX4",
      // A client trying to name somebody else. The route never reads it.
      ownerUserId: "99999999-9999-4999-8999-999999999999",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      command: "cancel",
      changed: true,
      appointmentToken: "APT-7K2M-9QX4",
    });
    expect(control.cancelCalls).toEqual([{ token: "APT-7K2M-9QX4", userId: ME }]);
  });

  it("refuses a provider command with invalid_request and never reaches the writer", async () => {
    // `attend`, `no_show` and `cancel_by_org` are the clinic's, behind
    // `/org/{token}/agenda`. A citizen wallet that could run one would be doing
    // something the owner's browser cannot.
    //
    // `book` USED TO BE IN THIS LIST and is not any more — it landed as the second
    // command and has its own describe below. The three that remain are the three
    // that are refused by RULE rather than by scope, which is what this case was
    // always about.
    for (const command of ["attend", "no_show", "cancel_by_org"]) {
      const response = await post({ command, appointmentToken: "APT-7K2M-9QX4" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect(control.cancelCalls).toEqual([]);
  });

  it("maps each of the writer's refusals to its own code and status", async () => {
    const expected: Array<[string, string, number]> = [
      ["Turno no encontrado.", "not_found", 404],
      ["Este turno no te pertenece.", "appointment_forbidden", 403],
      ["El turno ya fue procesado.", "appointment_already_resolved", 409],
      ["No podés cancelar un turno que ya pasó.", "appointment_past", 409],
    ];

    for (const [sentence, code, status] of expected) {
      control.cancelResult = { error: sentence };
      const response = await post({ command: "cancel", appointmentToken: "APT-7K2M-9QX4" });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
    }
  });

  it("falls through an unrecognised sentence to a 500 rather than granting anything", async () => {
    control.cancelResult = { error: "Una frase que nadie tradujo." };
    const response = await post({ command: "cancel", appointmentToken: "APT-7K2M-9QX4" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "appointment_failed" });
  });

  it("has a table entry for EVERY sentence the writer can return", async () => {
    // THE DRIFT GUARD. The table matches sentences exactly, so a reworded refusal
    // in the writer degrades silently to a 500 for something that is not a server
    // failure. This reads the writer's own source and demands the table covers it.
    const source = readFileSync(
      "src/modules/events/application/booking/cancel-appointment-by-owner.ts",
      "utf8",
    );
    const sentences = [...source.matchAll(/return \{ error: "([^"]+)" \}/g)].map((m) => m[1]);

    // Non-vacuity: a regex that stopped matching would make this pass over nothing.
    expect(sentences.length).toBeGreaterThanOrEqual(4);

    const mapped = new Set(APPOINTMENT_REFUSAL_RULES.map((r) => r.sentence));
    for (const sentence of sentences) {
      expect(mapped.has(sentence as string)).toBe(true);
    }
  });
});

describe("POST book — the second command, and the coarseness of its refusals", () => {
  const BOOK = {
    command: "book",
    slotId: "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
    petPublicToken: "DIM-PAMP-0001",
  };

  it("books and acks, passing the caller id from the SESSION and not from the body", async () => {
    const response = await post({
      ...BOOK,
      // A client trying to book as somebody else. The route never reads it.
      userId: "99999999-9999-4999-8999-999999999999",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ command: "book", appointmentToken: "APT-NEW-0001" });
    expect(control.bookCalls).toEqual([
      { slotId: BOOK.slotId, petPublicToken: BOOK.petPublicToken, userId: ME },
    ]);
  });

  it("carries NO `changed` field, unlike the cancel ack", async () => {
    // A booking either minted an appointment or was refused; a boolean that is
    // always `true` on its only success arm describes nothing. The cancel ack
    // carries one for a real reason (see the contract) and copying it here to make
    // the two "consistent" would put a field on the wire nobody can act on.
    const body = (await (await post(BOOK)).json()) as Record<string, unknown>;
    expect("changed" in body).toBe(false);
  });

  it("acts as whoever the LIVENESS GUARD says is calling, not whoever the first test did", async () => {
    liveAs(SOMEBODY_ELSE);
    await post(BOOK);
    expect(control.bookCalls).toEqual([
      { slotId: BOOK.slotId, petPublicToken: BOOK.petPublicToken, userId: SOMEBODY_ELSE },
    ]);
  });

  it("maps every typed refusal to a code, and the map is TOTAL over the union", async () => {
    // THE COARSENESS WAS THE SUBJECT HERE AND THE TABLE BELOW IS THE UNFOLD.
    // Six domain refusals shipped collapsed onto four codes written for
    // CANCELLING, because `API_V1_ERROR_CODES` was another lane's territory in
    // that window; the lane pinned the fold so that the day the codes landed,
    // changing it would be a deliberate edit rather than a drift. This is that
    // edit, made at the 2026-08-30 integration merge with the three `booking_*`
    // codes the hand-off specified.
    //
    // ONE FOLD SURVIVES ON PURPOSE and it is named in `commands.ts`:
    // `pet_not_yours`/`pet_deceased` share one code so this door is not an
    // existence oracle over erased pets. Ratified by the PO on 2026-08-31.
    //
    // The second fold is GONE as of the same decision. `slot_past` borrowed
    // `appointment_past` — a code whose es-AR copy ends in "así que no se puede
    // cancelar" — so a person refused a BOOKING read a sentence about cancelling
    // a turno they never held. It now has `booking_slot_past` and its own
    // string. This row is what would go red if anybody re-folded it.
    const expected: Array<[string, string, number]> = [
      ["pet_not_yours", "booking_pet_not_bookable", 403],
      ["pet_deceased", "booking_pet_not_bookable", 403],
      ["slot_not_found", "booking_slot_taken", 409],
      ["slot_unavailable", "booking_slot_taken", 409],
      ["already_booked", "booking_already_in_offering", 409],
      ["slot_past", "booking_slot_past", 409],
    ];

    for (const [failure, code, status] of expected) {
      control.bookResult = { ok: false, code: failure };
      const response = await post(BOOK);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
    }

    // TOTAL, in both directions. A seventh member of `BookSlotFailureCode` added
    // without a row here is a TYPE error in `commands.ts` (the map is a
    // `Record<BookSlotFailureCode, …>`); what the type cannot catch is a row that
    // stops being reachable, which this half names.
    expect(Object.keys(BOOK_REFUSALS).sort()).toEqual(expected.map(([f]) => f).sort());
  });

  it("only ever answers a code the CONTRACT declares", async () => {
    // The mobile copy switch is exhaustive over `API_V1_ERROR_CODES` with no
    // `default`, so a code outside that vocabulary renders as a blank line under a
    // "no se pudo" heading. The map is typed `ApiV1ErrorCode`, and this is the
    // runtime half of the same claim.
    for (const refusal of Object.values(BOOK_REFUSALS)) {
      expect(API_V1_ERROR_CODES).toContain(refusal.code);
    }
  });

  it("refuses a book with a malformed slot before reaching the writer", async () => {
    const response = await post({ ...BOOK, slotId: "not-a-uuid" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.bookCalls).toEqual([]);
  });

  it("refuses a book with no pet before reaching the writer", async () => {
    const response = await post({ command: "book", slotId: BOOK.slotId });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.bookCalls).toEqual([]);
  });

  it("spends the WRITE budgets, not the read ones — booking is not a lookup", async () => {
    // `book` shares `cancel`'s route and therefore its family. That is the
    // decision `api-v1-limits.ts` records: both are a transaction across three
    // tables that moves a place between people, so one anchor bounds both.
    await post(BOOK);
    expect(control.spent).toEqual([
      { endpoint: "api_v1_me_appointments_write_ip", identifier: CALLER_IP },
      { endpoint: "api_v1_me_appointments_write_user", identifier: ME },
    ]);
  });

  it("refuses at the per-IP gate BEFORE the liveness round-trip", async () => {
    control.overLimit = new Set(["api_v1_me_appointments_write_ip"]);
    control.live = () => {
      throw new Error("the guard must not run when the IP bucket already refused");
    };

    const response = await post(BOOK);
    expect(response.status).toBe(429);
    expect(control.bookCalls).toEqual([]);
  });
});

describe("the door itself", () => {
  it("answers auth_required with no bearer, on both methods", async () => {
    const read = await GET(new Request("https://x/api/v1/me/appointments"));
    expect(read.status).toBe(401);
    expect(await read.json()).toEqual({ error: "auth_required" });

    const write = await POST(
      new Request("https://x/api/v1/me/appointments", { method: "POST", body: "{}" }),
    );
    expect(write.status).toBe(401);
  });

  it("stamps the envelope §6 requires, with `now` taken once for the whole response", async () => {
    control.rows = [row()];
    const body = await payloadOf(await get());

    expect(body.payloadVersion).toBe(1);
    expect(body.issuedAt).toBe(NOW.toISOString());
    expect(new Date(body.staleAfter).getTime()).toBe(NOW.getTime() + 60_000);
  });

  it("sets cache-control: no-store, which /api is not on middleware's allowlist for", async () => {
    const response = await get();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
