// `GET /api/v1/appointments` and `GET /api/v1/appointments/{offeringToken}` — the
// door, not the query.
//
// WHAT IS TESTED WHERE, SAID FIRST BECAUSE THE SPLIT IS THE ONLY REASON THIS
// FILE MAY MOCK ITS USE-CASES
// ---------------------------------------------------------------------------
// The two search predicates — which offerings match, which pets may be offered,
// and the art. 16 join under both — are pinned on the COMPILED SQL in
// `src/modules/events/application/booking/__tests__/search-bookable-slots.test.ts`,
// where 20 applied mutations are red. Mocking them here would be the defect the
// turnos rejection is about ONLY if nothing else measured them; what this file
// measures is the door: which budgets it spends and in which order, which id it
// reads the caller as, and what it says when the read degrades.
//
// THE FOUR RATE-LIMIT GATES ARE ASSERTED WITH THEIR IDENTIFIER, not just their
// bucket name. `api-v1-me-appointments-route.test.ts` stubs
// `enforceRateLimit: async (endpoint: string)` and drops the second argument,
// which is a DECLARED DEBT on the board: collapsing all four onto shared
// constants leaves that file green. Ten sibling route tests already take
// `(endpoint, identifier)`; this one does too, from the start.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ME = "11111111-1111-4111-8111-111111111111";
const SOMEBODY_ELSE = "22222222-2222-4222-8222-222222222222";
const CALLER_IP = "200.5.4.3";
const NOW = new Date("2026-08-30T12:00:00.000Z");

const control = vi.hoisted(() => ({
  /** What the liveness guard answers. `null` = a live session for `ME`. */
  live: null as null | (() => unknown),
  /** Buckets that should answer 429 instead of proceeding. */
  overLimit: new Set<string>(),
  /**
   * Buckets whose limiter is BROKEN — it throws something that is not a
   * `RateLimitError`, the way an unreachable `rate_limit_buckets` table would.
   * Distinct from `overLimit` on purpose: the two must produce opposite answers.
   */
  limiterBroken: new Set<string>(),
  /** Every bucket a handler tried to spend, WITH the identifier it keyed on. */
  spent: [] as Array<{ endpoint: string; identifier: string }>,
  /** What the search use-case answers, or a thrower. */
  searchResult: [] as unknown,
  searchThrows: null as null | (() => never),
  /** Every call the search use-case received. */
  searchCalls: [] as Array<Record<string, unknown>>,
  /** What the jurisdiction prefill answers. */
  jurisdiction: {
    province: null as string | null,
    locality: null as string | null,
    source: "none" as string,
  },
  /** Every call the prefill received. */
  jurisdictionCalls: [] as Array<Record<string, unknown>>,
  /** What the offering detail read answers. `null` = 404. */
  detail: null as unknown,
  detailThrows: null as null | (() => never),
  detailCalls: [] as Array<Record<string, unknown>>,
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
    // RECORDS THE PAIR AND CAN REFUSE ONE. Dropping the identifier is what makes
    // "the route passes the right key" unfalsifiable — see the header.
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

vi.mock("@/src/modules/events/application/booking/search-bookable-slots", () => ({
  searchBookableOfferings: async (args: Record<string, unknown>) => {
    control.searchCalls.push(args);
    if (control.searchThrows) control.searchThrows();
    return control.searchResult;
  },
  readBookableOffering: async (args: Record<string, unknown>) => {
    control.detailCalls.push(args);
    if (control.detailThrows) control.detailThrows();
    return control.detail;
  },
}));

vi.mock("@/app/api/v1/appointments/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/api/v1/appointments/query")>();
  return {
    ...actual,
    // The PARSER stays real — it is the half with cases worth running. Only the
    // prefill's database trip is replaced.
    defaultJurisdictionForUser: async (args: Record<string, unknown>) => {
      control.jurisdictionCalls.push(args);
      return control.jurisdiction;
    },
  };
});

import { GET as GET_DETAIL } from "@/app/api/v1/appointments/[offeringToken]/route";
import { GET as GET_SEARCH } from "@/app/api/v1/appointments/route";
import { SERVICE_KINDS } from "@/lib/reference/service-kinds";
import type { AppointmentSearchV1, BookableOfferingDetailV1 } from "@dim/contract/api";

function search(query = "") {
  return GET_SEARCH(
    new Request(`https://x/api/v1/appointments${query}`, { headers: { authorization: "b" } }),
  );
}

function detail(token = "SVO-7K2M-9QX4") {
  return GET_DETAIL(
    new Request(`https://x/api/v1/appointments/${token}`, { headers: { authorization: "b" } }),
    { params: Promise.resolve({ offeringToken: token }) },
  );
}

const offering = {
  offeringToken: "SVO-7K2M-9QX4",
  displayName: "Campaña antirrábica — Plaza San Martín",
  description: null,
  serviceKind: "vaccination_rabies",
  serviceKindLabel: "Vacunación antirrábica",
  provider: { kind: "organization" as const, displayName: "Zoonosis", phone: null, locality: null },
  durationMinutes: 15,
  priceArs: null,
  coverageLabel: "San Carlos de Bariloche",
  slotsInWindow: 3,
  nextSlotAt: new Date("2026-08-30T13:00:00.000Z"),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  control.live = null;
  control.overLimit = new Set();
  control.limiterBroken = new Set();
  control.spent = [];
  control.searchResult = [];
  control.searchThrows = null;
  control.searchCalls = [];
  control.jurisdiction = { province: null, locality: null, source: "none" };
  control.jurisdictionCalls = [];
  control.detail = null;
  control.detailThrows = null;
  control.detailCalls = [];
});

describe("GET /appointments — the picker, and an unknown service", () => {
  it("answers the whole catalogue and asks NOTHING when no service was chosen", async () => {
    const body = (await (await search()).json()) as AppointmentSearchV1;

    expect(body.serviceKind).toBe(null);
    expect(body.results).toEqual([]);
    expect(body.jurisdictionSource).toBe("none");
    expect(body.serviceKinds.map((k) => k.code)).toEqual(SERVICE_KINDS.map((k) => k.code));
    // NO QUERY RAN. A picker that also searched would spend a pooler round trip
    // to answer a twelve-item constant.
    expect(control.searchCalls).toEqual([]);
    expect(control.jurisdictionCalls).toEqual([]);
  });

  it("treats an UNRECOGNISED service_kind as absent and never echoes it", async () => {
    // QA 2026-08-08 (S3-F07): the web loaded `?service_kind=spay_female_dog` and
    // answered 200 with a heading that read `spay_female_dog`, because the page
    // used the raw param. React escaped it, so it was never injection — it was the
    // page asserting a service that does not exist.
    const response = await search("?service_kind=spay_female_dog");
    const body = (await response.json()) as AppointmentSearchV1;

    expect(response.status).toBe(200);
    expect(body.serviceKind).toBe(null);
    // The raw param must not appear ANYWHERE in the payload, not merely in the
    // field a client would draw as a heading.
    expect(JSON.stringify(body)).not.toContain("spay_female_dog");
    expect(control.searchCalls).toEqual([]);
  });

  it("carries the catalogue on a RESULTS response too, so a client redraws the picker offline", async () => {
    control.searchResult = [offering];
    const body = (await (
      await search("?service_kind=vaccination_rabies")
    ).json()) as AppointmentSearchV1;
    expect(body.serviceKinds.length).toBe(SERVICE_KINDS.length);
    expect(body.results.map((r) => r.offeringToken)).toEqual(["SVO-7K2M-9QX4"]);
    expect(body.windowDays).toBe(7);
  });

  it("echoes a RECOGNISED service_kind back, not just the absent/unrecognised cases (T4-M6, 2026-09-22)", async () => {
    // THE HOLE THIS CLOSES. Every case above asserts `body.serviceKind` only for
    // `null` (no service chosen, or an unrecognised one) — none pins the POSITIVE
    // value a valid code resolves to. Measured at the merge review: mutating the
    // route's `serviceKind: findServiceKind(query.serviceKind)?.code ?? …` line
    // left every one of the 28 route tests green. `control.searchCalls[0]`
    // carries the QUERY'S OWN string (unaffected by this line, which only shapes
    // the RESPONSE), so that assertion elsewhere in this file cannot catch a
    // regression here either.
    const body = (await (
      await search("?service_kind=vaccination_rabies")
    ).json()) as AppointmentSearchV1;
    expect(body.serviceKind).toBe("vaccination_rabies");
  });
});

describe("GET /appointments — the jurisdiction prefill", () => {
  it("does NOT run the prefill when the caller named both halves", async () => {
    control.searchResult = [];
    const body = (await (
      await search("?service_kind=vaccination_rabies&province=Río+Negro&locality=Dina+Huapi")
    ).json()) as AppointmentSearchV1;

    expect(control.jurisdictionCalls).toEqual([]);
    expect(body.jurisdictionSource).toBe("requested");
    expect(body.appliedProvince).toBe("Río Negro");
    expect(body.appliedLocality).toBe("Dina Huapi");
    expect(control.searchCalls[0]).toMatchObject({
      province: "Río Negro",
      locality: "Dina Huapi",
    });
  });

  it("reports a GUESSED jurisdiction as guessed, which the web does not", async () => {
    // The browser draws the prefilled locality into its own filter form, where it
    // reads as something the person asked for. A client that showed it with no
    // sign it was guessed would have somebody conclude their barrio has no
    // campaigns when they never chose their barrio.
    control.jurisdiction = {
      province: "Río Negro",
      locality: "San Carlos de Bariloche",
      source: "defaulted-from-pet",
    };
    const body = (await (
      await search("?service_kind=vaccination_rabies")
    ).json()) as AppointmentSearchV1;

    expect(control.jurisdictionCalls).toHaveLength(1);
    expect(body.jurisdictionSource).toBe("defaulted-from-pet");
    expect(body.appliedLocality).toBe("San Carlos de Bariloche");
  });

  it("runs the prefill when only ONE half was named", async () => {
    control.jurisdiction = {
      province: "Río Negro",
      locality: "El Bolsón",
      source: "defaulted-from-pet",
    };
    await search("?service_kind=vaccination_rabies&province=Río+Negro");
    expect(control.jurisdictionCalls).toHaveLength(1);
  });
});

describe("GET /appointments — the query string the web already publishes", () => {
  it("passes fecha_desde and solo_gratis through to the use-case", async () => {
    await search("?service_kind=vaccination_rabies&fecha_desde=2026-09-01&solo_gratis=true");
    expect(control.searchCalls[0]).toMatchObject({
      serviceKind: "vaccination_rabies",
      fromDate: new Date("2026-09-01"),
      freeOnly: true,
    });
  });

  it("folds a day that does not exist into NO floor rather than binding Invalid Date", async () => {
    // AND IT IS NOT `Invalid Date` — this case was written believing it was, and
    // the test is what corrected the belief. `new Date("2026-02-31")` does not
    // throw and is not NaN: JavaScript ROLLS IT OVER to 3 March, so a search floor
    // silently moves three days forward and hides every slot in between with
    // nothing reporting a substitution. `isRealArDay` round-trips the string,
    // which is the only check that catches it.
    await search("?service_kind=vaccination_rabies&fecha_desde=2026-02-31");
    expect(control.searchCalls[0]?.fromDate).toBe(null);
  });

  it("reads solo_gratis as the web does — the literal string, nothing else", async () => {
    await search("?service_kind=vaccination_rabies&solo_gratis=1");
    expect(control.searchCalls[0]?.freeOnly).toBe(false);
  });

  it("takes ONE `now` for the whole response", async () => {
    control.searchResult = [];
    const response = await search("?service_kind=vaccination_rabies");
    const body = (await response.json()) as AppointmentSearchV1;

    expect(control.searchCalls[0]?.now).toEqual(NOW);
    expect(body.issuedAt).toBe(NOW.toISOString());
    expect(new Date(body.staleAfter).getTime()).toBe(NOW.getTime() + 30_000);
  });
});

describe("GET /appointments/{offeringToken}", () => {
  it("answers 404 for an offering the read refuses, and says nothing about why", async () => {
    // A pending, paused or archived offering must be indistinguishable from a
    // token that names nothing, or this URL is an oracle for which offerings exist
    // and which are merely switched off.
    control.detail = null;
    const response = await detail();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("carries the slots, the pets and the SIXTY-day window", async () => {
    control.detail = {
      offering,
      slots: [
        {
          slotId: "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
          startsAt: new Date("2026-08-30T13:00:00.000Z"),
          endsAt: new Date("2026-08-30T13:15:00.000Z"),
          placesLeft: 2,
        },
      ],
      pets: [
        { publicToken: "DIM-PAMP-0001", name: "Pampa", canBook: true, blockedReason: null },
        {
          publicToken: "DIM-LOLA-0002",
          name: "Lola",
          canBook: false,
          blockedReason: "already_booked_in_offering",
        },
      ],
    };

    const body = (await (await detail()).json()) as BookableOfferingDetailV1;
    expect(body.windowDays).toBe(60);
    expect(body.slots[0]?.startsAt).toBe("2026-08-30T13:00:00.000Z");
    expect(body.slots[0]?.placesLeft).toBe(2);
    // THE REFUSAL IS VISIBLE BEFORE THE TAP, which is this door's whole design:
    // the (pet, offering) guard lives inside the booking transaction and is
    // invisible in a slot grid.
    expect(body.pets[1]).toEqual({
      publicToken: "DIM-LOLA-0002",
      name: "Lola",
      canBook: false,
      blockedReason: "already_booked_in_offering",
    });
  });

  it("reads the offering as the SESSION's caller and not as anybody the URL names", async () => {
    control.live = () => ({ ok: true, supabase: {}, user: { id: SOMEBODY_ELSE }, profile: null });
    control.detail = { offering, slots: [], pets: [] };
    await detail();
    expect(control.detailCalls[0]).toMatchObject({
      offeringToken: "SVO-7K2M-9QX4",
      userId: SOMEBODY_ELSE,
    });
  });
});

describe("the two rate-limit gates on each route — bucket AND identifier", () => {
  it("spends the IP bucket keyed on the caller ADDRESS and the user bucket on the user ID", async () => {
    await search("?service_kind=vaccination_rabies");
    expect(control.spent).toEqual([
      { endpoint: "api_v1_appointment_search_ip", identifier: CALLER_IP },
      { endpoint: "api_v1_appointment_search_user", identifier: ME },
    ]);
  });

  it("spends the SAME pair from the detail route — one budget for one act of looking", async () => {
    control.detail = { offering, slots: [], pets: [] };
    await detail();
    expect(control.spent).toEqual([
      { endpoint: "api_v1_appointment_search_ip", identifier: CALLER_IP },
      { endpoint: "api_v1_appointment_search_user", identifier: ME },
    ]);
  });

  it("refuses at the per-IP gate BEFORE the GoTrue round-trip", async () => {
    control.overLimit = new Set(["api_v1_appointment_search_ip"]);
    control.live = () => {
      throw new Error("the guard must not run when the IP bucket already refused");
    };
    const response = await search("?service_kind=vaccination_rabies");
    expect(response.status).toBe(429);
    expect(control.searchCalls).toEqual([]);
  });

  it("refuses at the per-USER gate AFTER it, which is the whole point of the second bucket", async () => {
    control.overLimit = new Set(["api_v1_appointment_search_user"]);
    const response = await search("?service_kind=vaccination_rabies");
    expect(response.status).toBe(429);
    // The guard DID run — a per-user bucket cannot be keyed before there is a
    // user, and the ordering is what makes carrier NAT survivable.
    expect(control.spent.map((s) => s.endpoint)).toEqual([
      "api_v1_appointment_search_ip",
      "api_v1_appointment_search_user",
    ]);
    expect(control.searchCalls).toEqual([]);
  });

  it("FAILS OPEN when the limiter itself is broken, on both routes", async () => {
    // The limiter is a DB write. Refusing when `rate_limit_buckets` is unavailable
    // would stop somebody finding a free vaccination campaign, and this read
    // discloses a public catalogue.
    //
    // THE FENCE THIS SIBLING FILE DOES NOT HAVE. `me/appointments`'s documented
    // fail-open is unmeasured — flipping its `return true` to `return false`
    // leaves that file 36/36 green — and it is a declared debt on the board with
    // an owner. Five other route files carry a case literally named this. So does
    // this one, from the start.
    control.limiterBroken = new Set([
      "api_v1_appointment_search_ip",
      "api_v1_appointment_search_user",
    ]);
    control.searchResult = [];
    control.detail = { offering, slots: [], pets: [] };

    expect((await search("?service_kind=vaccination_rabies")).status).toBe(200);
    expect((await detail()).status).toBe(200);
  });

  it("still fails CLOSED on authorization while the limiter is broken", async () => {
    // The pair the case above only half proves. A fail-open limiter must not carry
    // the guard open with it, and the two live in the same `try` in neither route
    // — this is what says so.
    control.limiterBroken = new Set([
      "api_v1_appointment_search_ip",
      "api_v1_appointment_search_user",
    ]);
    control.live = () => ({ ok: false, reason: "ACCOUNT_ERASED" });

    const response = await search("?service_kind=vaccination_rabies");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "account_erased" });
    expect(control.searchCalls).toEqual([]);
  });
});

describe("the door itself", () => {
  it("answers auth_required with no bearer, on both routes", async () => {
    const list = await GET_SEARCH(new Request("https://x/api/v1/appointments"));
    expect(list.status).toBe(401);
    expect(await list.json()).toEqual({ error: "auth_required" });

    const one = await GET_DETAIL(new Request("https://x/api/v1/appointments/SVO-1"), {
      params: Promise.resolve({ offeringToken: "SVO-1" }),
    });
    expect(one.status).toBe(401);
  });

  const refusals: Array<[string, number, string]> = [
    ["NO_SESSION", 401, "auth_expired"],
    ["ACCOUNT_ERASED", 403, "account_erased"],
    ["DEACTIVATED", 403, "account_deactivated"],
    ["SHIFT_EXPIRED", 401, "session_shift_expired"],
    ["MAINTENANCE", 503, "temporarily_unavailable"],
  ];

  for (const [reason, status, code] of refusals) {
    it(`answers ${code} for ${reason} on both routes, and reads nothing`, async () => {
      control.live = () => ({ ok: false, reason });

      const list = await search("?service_kind=vaccination_rabies");
      expect(list.status).toBe(status);
      expect(await list.json()).toEqual({ error: code });

      const one = await detail();
      expect(one.status).toBe(status);
      expect(await one.json()).toEqual({ error: code });

      // AND NEITHER SIDE RAN. A refusal that still queried would be a 403 wrapped
      // around a completed read.
      expect(control.searchCalls).toEqual([]);
      expect(control.detailCalls).toEqual([]);
    });
  }

  it("answers 503 and NOT an empty catalogue when the read exceeds its budget", async () => {
    // "There are no turnos" and "we could not ask" are different facts, and a
    // client that rendered the first over a pooler outage would send somebody away
    // from a campaign that is running.
    const { DbBudgetExceededError } = await import("@/lib/infra/db-budget");
    control.searchThrows = () => {
      throw new DbBudgetExceededError("api-v1-appointment-search", 8_000);
    };

    const response = await search("?service_kind=vaccination_rabies");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("answers 503 and NOT a 404 when the offering read exceeds its budget", async () => {
    // The worst lie a read can tell: a database outage rendered as "this offering
    // does not exist".
    const { DbBudgetExceededError } = await import("@/lib/infra/db-budget");
    control.detailThrows = () => {
      throw new DbBudgetExceededError("api-v1-appointment-offering", 8_000);
    };

    const response = await detail();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
  });

  it("sets cache-control: no-store on both routes, which /api is not on middleware's allowlist for", async () => {
    control.detail = { offering, slots: [], pets: [] };
    expect((await search()).headers.get("cache-control")).toContain("no-store");
    expect((await detail()).headers.get("cache-control")).toContain("no-store");
  });
});
