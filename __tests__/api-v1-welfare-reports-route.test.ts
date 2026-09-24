// `POST /api/v1/welfare-reports` — the denuncia door, and the one property it
// exists to keep.
//
// WHAT THIS FILE IS ABOUT
// ---------------------------------------------------------------------------
// A citizen denuncia under Ley 14.346 may be ANONYMOUS: the person filing it can
// choose that the record carries no link to them. On this transport the caller is
// always authenticated — every `/api/v1` door is — so "anonymous" is not a
// property of the request, it is a property of everything the request WRITES.
// That makes it exactly the kind of guarantee that decays silently: nothing goes
// red when a user id starts appearing in a column, a log line or a case row.
//
// So the centre of this file is a sweep rather than three spot checks. The
// anonymous submission is run end to end with the caller's uuid known to the
// test, and then EVERY value the door produced — the inserted row, the case it
// opened, the moderation input, the authority signal, the response body, and
// every string handed to the error sink — is searched for that uuid and for the
// caller's contact details. A single `toContain` over the whole trace is what
// survives somebody adding a field to a payload; six assertions naming six
// columns is what does not.
//
// THE HARNESS STUBS THE EDGES AND KEEPS THE MIDDLE
// ---------------------------------------------------------------------------
// `createWelfareReport` is NOT mocked. It is the use-case that carries
// `reporterUserId` into `openCase` and into the pet-event bridge, so mocking it
// would delete the subject of the sweep and leave a file asserting that the
// route passes an argument to a function that no longer does anything with it.
// What is stubbed is the repository, the case helper, the transaction, and the
// three infra seams the web's action also calls (jurisdiction inference, the
// moderation heuristics, the authority signal) — each CAPTURING its arguments
// rather than swallowing them, because a stub that ignores an argument makes
// every assertion in the file assert that the argument does not matter.
//
// The rate-limit stub records the bucket AND THE IDENTIFIER. Ten sibling route
// tests take the pair; `api-v1-me-appointments-route.test.ts` drops the second
// argument and its own debt row says collapsing all four gates onto shared
// constants leaves it green. This file does not inherit that.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ME = "11111111-1111-4111-8111-111111111111";
const CALLER_IP = "203.0.113.77";

const control = vi.hoisted(() => ({
  /** What the liveness guard answers. `null` = a live session for `ME`. */
  live: null as null | (() => unknown),
  /** Buckets that should answer 429 instead of proceeding. */
  overLimit: new Set<string>(),
  /**
   * Buckets whose LIMITER is broken — it throws something that is not a
   * `RateLimitError`, which is what a `rate_limit_buckets` outage looks like.
   * Distinct from `overLimit` on purpose: the two arms of the `catch` are the
   * difference between "refused" and "the instrument failed", and a stub that
   * could only produce one of them cannot test the other.
   */
  limiterBroken: new Set<string>(),
  /** Every (bucket, identifier) pair a handler actually tried to spend. */
  spent: [] as Array<{ endpoint: string; identifier: string }>,
  /** Values handed to `insertReportWithRetry`. */
  inserted: [] as Array<Record<string, unknown>>,
  /** Make the insert throw, to exercise the 500 arm. */
  insertThrows: false,
  /** Arguments `openCase` received. */
  cases: [] as Array<Record<string, unknown>>,
  /** Arguments `linkCase` received. */
  links: [] as Array<unknown[]>,
  /** Every pet event the use-case tried to append. */
  petEvents: [] as Array<Record<string, unknown>>,
  /** Attachment rows the use-case tried to insert. */
  attachments: [] as Array<unknown[]>,
  /** What `computeFlagReasons` was asked, and what it answers. */
  flagInputs: [] as Array<Record<string, unknown>>,
  flagReasons: [] as string[],
  /** Rows `setFlagged` received. */
  flagged: [] as Array<unknown[]>,
  /** What `signalWelfareReport` was handed. */
  signals: [] as Array<Record<string, unknown>>,
  /** What `resolveRoutableJurisdiction` was handed, and what it answers. */
  jurisdictionInputs: [] as Array<Record<string, unknown>>,
  jurisdiction: {
    province: "Río Negro",
    locality: "San Carlos de Bariloche",
    localityId: "44444444-4444-4444-8444-444444444444",
    unverified: true,
  } as Record<string, unknown>,
  /**
   * What the catalog lookup behind `normalizeLocationForWrite`'s "soft" mode
   * was asked, and what it answers. `null` answers as the real function does on
   * a miss: the pair back unchanged, `canonical: false`, no FK.
   */
  localityLookups: [] as Array<Record<string, unknown>>,
  localityAnswer: null as Record<string, unknown> | null,
  /** Every string the error sink was handed. */
  errors: [] as string[],
  /** Every query handed to the web's anonymous geocoder, and what it answers. */
  geocodeQueries: [] as string[],
  geocodeResults: [] as Array<Record<string, unknown>>,
  /**
   * Make the geocoder THROW, which is the arm the stub could not reach.
   *
   * `geocodeAddress` throws `rate_limited`, `fetch_failed` and `provider_error`
   * (`lib/infra/geocoding.ts`) and `geocodeAddressPublicAction` re-throws all
   * three, but a stub that only ever RESOLVES makes every assertion in this file
   * an assertion about the happy path. The message is the control's so a case can
   * pick which of the three it is exercising.
   */
  geocodeThrows: null as string | null,
  /**
   * Make the SHARED `geocode_public` budget refuse (A5-ciudadanas-04). A
   * different arm from `geocodeThrows`: that one is the provider failing, this
   * one is the limiter working — and the two must not answer the same status.
   */
  geocodeThrowsRateLimit: false,
  /** Make the case transaction fail, to exercise the other 500 arm. */
  txThrows: false,
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
    // THE IDENTIFIER IS RECORDED, not dropped. A stub of shape
    // `async (endpoint: string) => …` cannot tell a route that keys its per-IP
    // bucket on the address from one that keys it on the user — which is the
    // declared debt on the turnos route test, in this exact position.
    // THE BROKEN-LIMITER ERROR CARRIES THE BUCKET KEY, because the real one
    // does and this file's whole subject is what reaches a log. `rate-limit.ts`
    // throws `enforceRateLimit: UPSERT returned no rows for key "{bucketKey}"`
    // on its driver-glitch path, and `bucketKey` embeds the identifier — which
    // on `welfare_auth` is the caller's uuid, on the ANONYMOUS branch. A stub
    // that threw a tidy `"rate_limit_buckets is unavailable"` made every
    // assertion in this file about logs pass for free: the sweep below asserts
    // the uuid is nowhere in `trace()`, and `trace()` reads `control.errors`,
    // but with a message that never contained an id there was nothing to catch.
    // Same defect this lane wrote up one file over — "a stub that drops the
    // predicate does not fail to test it, it makes the whole file assert that
    // the argument does not matter."
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.spent.push({ endpoint, identifier });
      if (control.limiterBroken.has(endpoint)) {
        throw new Error(
          `enforceRateLimit: UPSERT returned no rows for key "${endpoint}:${identifier}:hour:1756512000000"`,
        );
      }
      if (control.overLimit.has(endpoint)) throw new actual.RateLimitError(new Date(), endpoint);
    },
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

vi.mock("@/src/modules/welfare/infrastructure/welfare-repository", () => ({
  WelfareRepository: class {
    async insertReportWithRetry(values: Record<string, unknown>) {
      control.inserted.push(values);
      if (control.insertThrows) throw new Error("insert failed");
      return { id: "report-uuid", referenceCode: "DEN-9KSC-MRMZ" };
    }
    async insertAttachments(...args: unknown[]) {
      control.attachments.push(args);
    }
    async linkCase(...args: unknown[]) {
      control.links.push(args);
    }
    async insertPetEvent(values: Record<string, unknown>) {
      control.petEvents.push(values);
    }
    async insertPetEventIdempotent(values: Record<string, unknown>) {
      control.petEvents.push(values);
    }
    async setFlagged(...args: unknown[]) {
      control.flagged.push(args);
    }
  },
}));

vi.mock("@/lib/infra/case-helpers", () => ({
  openCase: async (input: Record<string, unknown>) => {
    control.cases.push(input);
    return { id: "case-uuid", publicCode: "CAS-1234-5678" };
  },
}));

vi.mock("@/lib/infra/jurisdiction-from-text", () => ({
  resolveRoutableJurisdiction: async (input: Record<string, unknown>) => {
    control.jurisdictionInputs.push(input);
    return control.jurisdiction;
  },
}));

// PARTIAL: the province canonicalizer upstream of this is pure and stays real —
// it is the thing under test. Only the catalog lookup is replaced, because the
// `@/db` mock below has no `select`, and the real `tryResolveCanonicalJurisdiction`
// would swallow that as a miss and hand every case the raw pair: green for the
// wrong reason.
vi.mock("@/lib/infra/jurisdiction-validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/jurisdiction-validation")>();
  return {
    ...actual,
    tryResolveCanonicalJurisdiction: async (input: {
      rawProvince: string;
      rawLocality: string;
    }) => {
      control.localityLookups.push(input);
      return (
        control.localityAnswer ?? {
          province: input.rawProvince,
          locality: input.rawLocality,
          canonical: false,
          localityId: null,
        }
      );
    },
  };
});

vi.mock("@/lib/infra/welfare-moderation", () => ({
  computeFlagReasons: async (input: Record<string, unknown>) => {
    control.flagInputs.push(input);
    return control.flagReasons;
  },
}));

vi.mock("@/lib/domain/authority", () => ({
  signalWelfareReport: async (input: Record<string, unknown>) => {
    control.signals.push(input);
  },
}));

vi.mock("@/lib/infra/report-error", () => ({
  reportError: (scope: string, err: unknown) => {
    control.errors.push(scope, String(err), JSON.stringify(err ?? null));
  },
}));

// The WEB'S OWN anonymous geocoding action — the one the DenunciaWizard's
// address field calls. Mocked at the module the route imports, not re-created,
// so a rename of that export is a red here rather than a second geocoder.
vi.mock("@/src/modules/localities/application/geocoding/geocoding", () => {
  // THE REAL `RateLimitError`, resolved lazily and memoised. The route decides
  // with `instanceof`, so a hand-rolled look-alike here would test nothing; and
  // a top-level import cannot be referenced from a hoisted factory. Memoised
  // rather than re-imported per call — a per-call `await import()` of a mocked
  // module has dropped a concurrent caller in this repo before.
  let rateLimit: typeof import("@/lib/infra/rate-limit") | null = null;
  return {
    // `…OrThrow`, not `…Action` (A5-ciudadanas-04). Same act, same
    // `geocode_public` bucket, same IP — the difference is that a REFUSED
    // budget throws here instead of coming back as `[]`, because this door
    // renders an empty list as "No pudimos encontrar esa dirección" and a
    // limiter refusal is not a fact about the address.
    geocodeAddressPublicOrThrow: async (query: string) => {
      control.geocodeQueries.push(query);
      // The query is recorded BEFORE the throw on purpose: a case asserting the
      // failure arm still gets to assert the geocoder was in fact reached, so a
      // 503 produced by something else upstream cannot pass for this one.
      if (control.geocodeThrowsRateLimit) {
        rateLimit ??= await import("@/lib/infra/rate-limit");
        throw new rateLimit.RateLimitError(new Date(Date.now() + 60_000), "geocode_public");
      }
      if (control.geocodeThrows !== null) throw new Error(control.geocodeThrows);
      return control.geocodeResults;
    },
  };
});

// A PARTIAL mock: only `db` is replaced, and only its `transaction`. The table
// objects stay real, because half the app's infra transitively imports this
// module — a hand-written object would report a missing export as a broken FILE,
// which is the one red `/CLAUDE.md` says may never be committed.
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return {
    ...actual,
    db: {
      transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
        if (control.txThrows) throw new Error("tx failed");
        return cb({});
      },
    },
  };
});

import { POST } from "@/app/api/v1/welfare-reports/route";
import { WELFARE_REPORT_KINDS as DOMAIN_KINDS } from "@/src/modules/welfare/domain/types";
import type { WelfareReportFiledV1 } from "@dim/contract/api";

const FACTS = {
  kind: "physical_abuse",
  severity: "critical",
  description: "Vi al perro atado al sol sin agua y con golpes visibles en el lomo.",
  subjectKind: "unowned_animal",
  subjectDescription: "Perro mestizo marrón, mediano, atado en el fondo de una casa.",
  locationLat: -41.135,
  locationLng: -71.3103,
  locationAddress: "Av. Bustillo 1200, San Carlos de Bariloche",
} as const;

const CONTACT_EMAIL = "vecina.testigo@example.com";
const CONTACT_PHONE = "+54 294 4123456";

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://x/api/v1/welfare-reports", {
      method: "POST",
      headers: {
        authorization: "b",
        "content-type": "application/json",
        "x-forwarded-for": CALLER_IP,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

/** Every value the door produced, as one searchable string. */
function trace(): string {
  return JSON.stringify({
    inserted: control.inserted,
    cases: control.cases,
    links: control.links,
    petEvents: control.petEvents,
    flagInputs: control.flagInputs,
    flagged: control.flagged,
    signals: control.signals,
    jurisdictionInputs: control.jurisdictionInputs,
    errors: control.errors,
  });
}

beforeEach(() => {
  control.live = null;
  control.overLimit = new Set();
  control.limiterBroken = new Set();
  control.spent = [];
  control.inserted = [];
  control.insertThrows = false;
  control.cases = [];
  control.links = [];
  control.petEvents = [];
  control.attachments = [];
  control.flagInputs = [];
  control.flagReasons = [];
  control.flagged = [];
  control.signals = [];
  control.jurisdictionInputs = [];
  control.localityLookups = [];
  control.localityAnswer = null;
  control.errors = [];
  control.txThrows = false;
  control.geocodeQueries = [];
  control.geocodeResults = [];
  control.geocodeThrows = null;
  control.geocodeThrowsRateLimit = false;
});

describe("resolve_location — the only way a phone can name a point", () => {
  /** One Nominatim row, with the two fields the wire must NOT carry. */
  function match(over: Record<string, unknown> = {}) {
    return {
      lat: -41.135,
      lng: -71.3103,
      display_name: "Avenida Bustillo 1200, San Carlos de Bariloche, Río Negro, Argentina",
      province: "Río Negro",
      locality: "San Carlos de Bariloche",
      // Two fields `GeocodeResult` does not declare today, standing in for the
      // ones it will. A pass-through would put both on the wire.
      osm_id: 987654321,
      boundingbox: ["-41.2", "-41.1", "-71.4", "-71.3"],
      ...over,
    };
  }

  it("asks the WEB'S geocoder, with the address verbatim", async () => {
    // Kill it by importing `geocodeAddress` from `lib/infra/geocoding` directly
    // instead of the public action. Applied: the module mock no longer
    // intercepts, `control.geocodeQueries` stays empty and this fails — which is
    // the point, because the public action is what spends the shared
    // `geocode_public` bucket the browser spends.
    control.geocodeResults = [match()];
    const response = await post({
      command: "resolve_location",
      addressText: "  Av. Bustillo 1200, Bariloche  ",
    });

    expect(response.status).toBe(200);
    expect(control.geocodeQueries).toEqual(["Av. Bustillo 1200, Bariloche"]);
  });

  it("PROJECTS the geocoder's rows — five fields, and nothing it grows later", async () => {
    // Kill it by spreading the match (`...match`) in
    // `buildWelfareLocationResolvedAck`. Applied: `osm_id` and `boundingbox`
    // reach the wire and this fails.
    control.geocodeResults = [match()];
    const body = (await (
      await post({ command: "resolve_location", addressText: "Av. Bustillo 1200" })
    ).json()) as { matches: Array<Record<string, unknown>> };

    expect(Object.keys(body.matches[0]).sort()).toEqual([
      "label",
      "lat",
      "lng",
      "locality",
      "province",
    ]);
    expect(body.matches[0].label).toBe(
      "Avenida Bustillo 1200, San Carlos de Bariloche, Río Negro, Argentina",
    );
  });

  it("does NOT echo the address the person typed", async () => {
    // Spec D10: user-supplied query strings are never persisted or logged by us,
    // and on a maltrato form the typed address is the incident's — sometimes the
    // reporter's own street. Echoing it costs a client nothing (it already holds
    // it) and puts it in one more place.
    //
    // Kill it by adding `query: addressText` to the resolved ack. Applied: fails.
    control.geocodeResults = [match()];
    const raw = await (
      await post({ command: "resolve_location", addressText: "Mi casa, Pasaje Los Notros 45" })
    ).text();

    expect(raw).not.toContain("Pasaje Los Notros");
  });

  it("caps the candidate list, so one address cannot return a gazetteer", async () => {
    // Kill it by dropping the `.slice(0, MAX_LOCATION_MATCHES)`. Applied: fails
    // on the length.
    control.geocodeResults = Array.from({ length: 12 }, (_, i) =>
      match({ display_name: `match ${i}` }),
    );
    const body = (await (
      await post({ command: "resolve_location", addressText: "San Martín" })
    ).json()) as { matches: unknown[] };

    expect(body.matches).toHaveLength(5);
  });

  it("answers 200 with an EMPTY list when nothing resolves — never an error", async () => {
    // A MISS IS A 200 WITH NO MATCHES. A 404 here would tell a client "that
    // address does not exist" on evidence the server does not have — the
    // geocoder answering nothing is not the gazetteer asserting absence.
    //
    // THIS COMMENT USED TO SAY the miss, the timeout and the rate-limit refusal
    // were "deliberately indistinguishable", and that was false in both
    // directions: `lib/infra/geocoding.ts` THROWS for the other two rather than
    // returning empty, and this file's stub could not throw, so the sentence
    // described neither the code nor the test under it. They are distinguishable
    // and they should be — see the 503 cases below.
    control.geocodeResults = [];
    const response = await post({ command: "resolve_location", addressText: "asdkjhasd" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      command: "resolve_location",
      version: 1,
      matches: [],
    });
  });

  // The three THROWING paths of the geocoder, which escaped this handler as a
  // bare Next.js 500 until the try/catch in `commands.ts` landed. Each one is a
  // real `throw new Error(...)` in `lib/infra/geocoding.ts` — `rate_limited` at
  // its own token bucket, `fetch_failed` at the nominatim timeout,
  // `provider_error` at any non-2xx — and `geocodeAddressPublicAction` re-throws
  // all three rather than absorbing them.
  //
  // MUTATION, APPLIED: deleting the try/catch in `runWelfareReportCommand` makes
  // all three of these red. Both halves of each assertion matter — the envelope
  // is what a bare 500 does NOT have, and it is the whole reason a 503 beats
  // letting it propagate.
  for (const reason of ["rate_limited", "fetch_failed", "provider_error"] as const) {
    it(`answers 503 with the ENVELOPE when the geocoder throws ${reason}`, async () => {
      control.geocodeThrows = reason;
      const response = await post({
        command: "resolve_location",
        addressText: "Av. Bustillo 1200",
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
      expect(response.headers.get("retry-after")).toBe("5");
      // The geocoder really was reached, so a 503 minted upstream cannot pass
      // for this one.
      expect(control.geocodeQueries).toEqual(["Av. Bustillo 1200"]);
    });
  }

  it("does NOT answer an empty match list when the geocoder throws", async () => {
    // THE FIX THAT WOULD HAVE BEEN WRONG, pinned so nobody applies it later.
    // Collapsing a failure into `matches: []` makes the 200 path unreachable to
    // distinguish, and the screen renders that as "no encontramos esa
    // dirección" — telling somebody standing in front of an injured animal that
    // the street they are looking at does not exist, on evidence the server does
    // not have. This asserts the two are NOT the same answer.
    control.geocodeThrows = "fetch_failed";
    const failed = await post({ command: "resolve_location", addressText: "Av. Bustillo 1200" });

    control.geocodeThrows = null;
    control.geocodeResults = [];
    const missed = await post({ command: "resolve_location", addressText: "Av. Bustillo 1200" });

    expect(failed.status).not.toBe(missed.status);
    expect(missed.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // A5-ciudadanas-04 — the SHARED budget's refusal is not a fact about the street
  // -------------------------------------------------------------------------
  //
  // CANON-433 covered the provider throwing. It did not cover the `geocode_public`
  // limiter, because `geocodeAddressPublicAction` answers a refused budget with
  // `[]` — the shape the web's debounced autocomplete wants and the one this door
  // renders as "No pudimos encontrar esa dirección. Probá escribirla de otra
  // forma". Behind a carrier gateway where neighbours are filing web sightings, a
  // tester retypes the address three ways (each spending more of the same
  // budget), is told three times that it does not exist, and never files.
  it("answers rate_limited 429 when the shared geocode budget refuses", async () => {
    control.geocodeThrowsRateLimit = true;
    const response = await post({
      command: "resolve_location",
      addressText: "Av. Bustillo 1200",
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    // The limiter really was reached through this call, so a 429 minted by the
    // route's own per-IP bucket cannot pass for this one.
    expect(control.geocodeQueries).toEqual(["Av. Bustillo 1200"]);
  });

  it("does NOT answer an empty match list when the budget refuses", async () => {
    control.geocodeThrowsRateLimit = true;
    const refused = await post({ command: "resolve_location", addressText: "Av. Bustillo 1200" });

    control.geocodeThrowsRateLimit = false;
    control.geocodeResults = [];
    const missed = await post({ command: "resolve_location", addressText: "Av. Bustillo 1200" });

    expect(refused.status).not.toBe(missed.status);
    expect(missed.status).toBe(200);
  });

  it("does not report a spent budget to the error sink — the limiter working is not an incident", async () => {
    control.geocodeThrowsRateLimit = true;
    await post({ command: "resolve_location", addressText: "Av. Bustillo 1200" });

    expect(control.errors).not.toContain("api-v1-welfare-reports/geocode");
  });

  it("keeps the limiter's answer DISTINCT from the provider's", async () => {
    // Two different truths: "we could not reach the geocoder, try again in a
    // few seconds" (503 + retry-after) and "you have used this budget up"
    // (429). Collapsing them would put the wrong sentence on the phone.
    control.geocodeThrowsRateLimit = true;
    const limited = await post({ command: "resolve_location", addressText: "Av. Bustillo 1200" });

    control.geocodeThrowsRateLimit = false;
    control.geocodeThrows = "fetch_failed";
    const down = await post({ command: "resolve_location", addressText: "Av. Bustillo 1200" });

    expect(limited.status).toBe(429);
    expect(down.status).toBe(503);
  });

  it("reports the geocoder failure to the sink WITHOUT the address", async () => {
    // Spec D10: what the person typed is theirs and is not logged. A geocoder
    // failure is the most tempting place to attach it "for debugging", so the
    // absence is asserted rather than assumed.
    control.geocodeThrows = "provider_error";
    await post({ command: "resolve_location", addressText: "Av. Bustillo 1200" });

    expect(control.errors).toContain("api-v1-welfare-reports/geocode");
    expect(control.errors.join(" | ")).not.toContain("Bustillo");
  });

  it("does NOT spend the denuncia budget to look up an address", async () => {
    // TEN DENUNCIAS AN HOUR is what `welfare_auth` buys. Spending it on address
    // lookups would let somebody who mistyped a street four times find they can
    // no longer REPORT.
    //
    // Kill it by moving `spendUserBudget` above the command switch in
    // `commands.ts`. Applied: `welfare_auth` appears and this fails.
    control.geocodeResults = [match()];
    await post({ command: "resolve_location", addressText: "Av. Bustillo 1200" });

    expect(control.spent.map((s) => s.endpoint)).toEqual(["api_v1_welfare_reports_ip"]);
  });

  it("writes nothing — it is a read wearing a POST", async () => {
    control.geocodeResults = [match()];
    await post({ command: "resolve_location", addressText: "Av. Bustillo 1200" });

    expect(control.inserted).toEqual([]);
    expect(control.cases).toEqual([]);
    expect(control.signals).toEqual([]);
  });

  it("refuses an address too short to mean anything, without asking the geocoder", async () => {
    const response = await post({ command: "resolve_location", addressText: "a" });
    expect(response.status).toBe(400);
    expect(control.geocodeQueries).toEqual([]);
  });

  it("still requires a live session — an address lookup is not a public door", async () => {
    control.live = () => ({ ok: false, reason: "ACCOUNT_ERASED" });
    const response = await post({ command: "resolve_location", addressText: "Av. Bustillo 1200" });

    expect(response.status).toBe(403);
    expect(control.geocodeQueries).toEqual([]);
  });

  it("refuses a body with no command at all", async () => {
    // The union's own backstop: `{ contactMode: "anonymous", … }` without
    // `command` was a VALID body before the location step landed, so a client
    // built against the older shape must be refused rather than silently filed.
    const response = await post({ contactMode: "anonymous", ...FACTS });
    expect(response.status).toBe(400);
    expect(control.inserted).toEqual([]);
  });
});

describe("the anonymous denuncia leaves no trace of who filed it", () => {
  it("writes NO user id anywhere — not the row, not the case, not the log, not the ack", async () => {
    // THE SWEEP. Kill it by changing one `null` in commands.ts:
    //   reporterUserId = input.contactMode === "anonymous" ? null : ctx.userId
    //     → reporterUserId = ctx.userId
    // Applied: this test fails on `inserted[0].reporterUserId` AND on the trace,
    // and so does the case's `openedByUserId`, because the use-case forwards it.
    const response = await post({ command: "file", contactMode: "anonymous", ...FACTS });
    expect(response.status).toBe(201);

    expect(control.inserted).toHaveLength(1);
    expect(control.inserted[0].reporterUserId).toBeNull();
    expect(control.cases).toHaveLength(1);
    expect(control.cases[0].openedByUserId).toBeNull();

    // …and the same fact stated once, over everything, so a NEW field carrying
    // the id is caught without anybody remembering to assert on it.
    expect(trace()).not.toContain(ME);
    expect(JSON.stringify(await response.json())).not.toContain(ME);
  });

  it("refuses to carry a contact the anonymous member does not declare", async () => {
    // THE STRUCTURAL HALF. The web's action reads `reporterContactEmail` out of
    // the FormData whatever `contactMode` says, so a hand-rolled browser POST can
    // pair "anonymous" with an address and have it stored. Here it cannot be
    // stored, and TWO independent things say so — which is why the mutation that
    // kills this test has two parts, and the honest thing is to name both:
    //
    //   1. THE SCHEMA. The anonymous member declares no contact field, so zod
    //      strips one before `commands.ts` ever sees it. Widening it alone leaves
    //      this test GREEN (measured), because guard 2 still holds — but it does
    //      NOT go unnoticed: `AnonymousCarriesNoContact` in
    //      `packages/contract/src/input/welfare-report.ts` is a COMPILE-TIME
    //      proof, and applying that half on its own fails `tsc` naming the field
    //      it grew. That is the fence for this layer; a runtime test cannot be
    //      one, because a client simply would not send what it cannot spell.
    //   2. THE HANDLER. `commands.ts` reads the contact off the DISCRIMINATED
    //      branch, so an anonymous body has nowhere for one to come from.
    //
    // Applied TOGETHER — widen the anonymous member AND replace the two
    // `contactMode === "with_contact" ? … : null` reads with a bare
    // `input.reporterContact*` — this test fails: the address reaches
    // `insertReportWithRetry`. Neither half alone does, and that is the property
    // being claimed rather than an accident.
    const response = await post({
      command: "file",
      contactMode: "anonymous",
      ...FACTS,
      reporterContactEmail: CONTACT_EMAIL,
      reporterContactPhone: CONTACT_PHONE,
    });

    expect(response.status).toBe(201);
    expect(control.inserted[0].reporterContactEmail).toBeNull();
    expect(control.inserted[0].reporterContactPhone).toBeNull();
    expect(trace()).not.toContain(CONTACT_EMAIL);
    expect(trace()).not.toContain(CONTACT_PHONE);
  });

  it("tells the authority signal there is no contact, which is the only bit it gets", async () => {
    // `signalWelfareReport` is the seam a real authority integration lands on.
    // It receives `hasContact` — a BOOLEAN — and never the address itself.
    //
    // Kill it by passing `hasContact: true` unconditionally in `commands.ts`'s
    // signal adapter. Applied: this test fails on the false.
    await post({ command: "file", contactMode: "anonymous", ...FACTS });
    expect(control.signals).toHaveLength(1);
    expect(control.signals[0].hasContact).toBe(false);
    expect(Object.keys(control.signals[0]).sort()).toEqual([
      "hasContact",
      "jurisdictionLocality",
      "jurisdictionProvince",
      "kind",
      "reportId",
      "severity",
    ]);
  });

  it("hands the error sink a scope and an error, never the caller or their words", async () => {
    // A log line is the classic place a privacy property dies, because nothing
    // renders it and no test reads it.
    //
    // Kill it by changing the insert arm in `commands.ts` to
    //   reportError(`api-v1-welfare-reports/insert:${ctx.userId}`, err)
    // Applied: this test fails on the `ME` assertion.
    control.insertThrows = true;
    const response = await post({ command: "file", contactMode: "anonymous", ...FACTS });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "welfare_report_failed" });
    expect(control.errors.length).toBeGreaterThan(0);
    expect(control.errors.join(" ")).not.toContain(ME);
    expect(control.errors.join(" ")).not.toContain(FACTS.description);
  });
});

describe("the receipt is the same for both contact modes", () => {
  it("answers a byte-identical ack whether or not the reporter left contact", async () => {
    // THE RULE `@dim/contract/api`'s welfare-report.ts states: the response body
    // must not be a place where the server writes down whether this person is
    // attached to this denuncia.
    //
    // Kill it by adding `anonymous: input.contactMode === "anonymous"` to
    // `buildWelfareReportFiledAck`'s output (and its argument). Applied: the two
    // bodies stop being equal and this fails.
    const anon = (await (
      await post({ command: "file", contactMode: "anonymous", ...FACTS })
    ).json()) as unknown;
    const named = (await (
      await post({
        command: "file",
        contactMode: "with_contact",
        reporterContactEmail: CONTACT_EMAIL,
        ...FACTS,
      })
    ).json()) as unknown;

    expect(anon).toEqual(named);
  });

  it("hands back the reference code and the web door, and nothing about the case", async () => {
    const body = (await (
      await post({ command: "file", contactMode: "anonymous", ...FACTS })
    ).json()) as WelfareReportFiledV1;

    expect(body.referenceCode).toBe("DEN-9KSC-MRMZ");
    expect(body.followUpUrl).toMatch(/\/denuncias\/codigo\/DEN-9KSC-MRMZ$/);
    // The uuid, the case id and its public code are the operator's handles. A
    // client that never needs one must never hold one.
    //
    // Kill it by returning `reportId` from `buildWelfareReportFiledAck`.
    // Applied: this fails on the key list.
    expect(Object.keys(body).sort()).toEqual([
      "command",
      "followUpUrl",
      "referenceCode",
      "version",
    ]);
    expect(JSON.stringify(body)).not.toContain("case-uuid");
    expect(JSON.stringify(body)).not.toContain("CAS-1234-5678");
    expect(JSON.stringify(body)).not.toContain("report-uuid");
  });
});

describe("the named denuncia attaches the account, and only then", () => {
  it("writes the caller's id and the contact they chose to leave", async () => {
    // The other direction of the same ternary — without this, a mutation that
    // hardcodes `reporterUserId = null` would pass every test above.
    //
    // Kill it with `reporterUserId = null` unconditionally in `commands.ts`.
    // Applied: this test fails.
    await post({
      command: "file",
      contactMode: "with_contact",
      reporterContactEmail: CONTACT_EMAIL,
      reporterContactPhone: CONTACT_PHONE,
      ...FACTS,
    });

    expect(control.inserted[0].reporterUserId).toBe(ME);
    expect(control.inserted[0].reporterContactEmail).toBe(CONTACT_EMAIL);
    expect(control.inserted[0].reporterContactPhone).toBe(CONTACT_PHONE);
    expect(control.cases[0].openedByUserId).toBe(ME);
    expect(control.signals[0].hasContact).toBe(true);
  });

  it("skips the auto-flag heuristics for an attributed submission, as the web does", async () => {
    // Spec R1: `computeFlagReasons` runs for anonymous submissions only.
    //
    // Kill it by dropping the `if (!reporterUserId)` guard in
    // `createWelfareReport`. Applied: this fails on the empty array.
    await post({
      command: "file",
      contactMode: "with_contact",
      reporterContactEmail: CONTACT_EMAIL,
      ...FACTS,
    });
    expect(control.flagInputs).toEqual([]);

    await post({ command: "file", contactMode: "anonymous", ...FACTS });
    expect(control.flagInputs).toHaveLength(1);
  });

  it("requires at least one channel when the reporter says they want to be reachable", async () => {
    // Kill it by deleting the `superRefine` on the `with_contact` member.
    // Applied: this returns 201 and the test fails.
    const response = await post({ command: "file", contactMode: "with_contact", ...FACTS });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.inserted).toEqual([]);
  });
});

describe("no attachments, and no way to pretend otherwise", () => {
  it("inserts no attachment rows and tells the moderation heuristics there are none", async () => {
    // `critical_without_evidence` fires on every critical denuncia from this
    // door, and that is correct rather than a false positive — see commands.ts.
    //
    // Kill it by passing `attachmentCount: 1` in `createWelfareReport`'s
    // `computeFlagReasons` call. Applied: this fails on the 0.
    await post({ command: "file", contactMode: "anonymous", ...FACTS });

    expect(control.attachments).toEqual([]);
    expect(control.flagInputs[0].attachmentCount).toBe(0);
  });

  it("does NOT fake the two browser bot heuristics", async () => {
    // `dwellTimeMs` and the honeypot measure a BROWSER. A native client would
    // have to invent them, and an invented `dwellTimeMs` is a field an abuser
    // sets to whatever passes.
    //
    // Kill it by sending `dwellTimeMs: 30_000` from `commands.ts`. Applied: this
    // fails on `toBeUndefined`.
    await post({ command: "file", contactMode: "anonymous", ...FACTS });

    expect(control.flagInputs[0].dwellTimeMs).toBeUndefined();
    expect(control.flagInputs[0].honeypotValue).toBe("");
  });

  it("ignores an `attachment` key a client sends anyway", async () => {
    const response = await post({
      command: "file",
      contactMode: "anonymous",
      ...FACTS,
      attachment: [{ storagePath: "welfare-evidence/x.heic", mimeType: "image/heic" }],
    });

    expect(response.status).toBe(201);
    expect(control.attachments).toEqual([]);
    // AND THE HEIC PATH NEVER REACHES STORAGE OR THE ROW. The declared, live
    // EXIF leak on the web's own form is what this door must not widen.
    expect(trace()).not.toContain("heic");
  });
});

describe("the subject is never a registered animal on this door", () => {
  it("refuses `registered_pet`, so no public token can aim a denuncia at a pet", async () => {
    // The public token is printed on the tag and published for every lost animal
    // on /perdidas. A token-addressed denuncia would let any holder append
    // `maltreatment_reported` to that animal's spine, which its owner reads.
    //
    // Kill it by adding "registered_pet" to `WELFARE_REPORT_SUBJECT_KINDS` in
    // the contract. Applied: this returns 201 and the test fails.
    const response = await post({
      command: "file",
      contactMode: "anonymous",
      ...FACTS,
      subjectKind: "registered_pet",
      subjectPetToken: "DIM-PAMP-0001",
    });

    expect(response.status).toBe(400);
    expect(control.inserted).toEqual([]);
  });

  it("STORES observed symptoms in the row, and still appends no pet event", async () => {
    // THE INVERSION OF THE TEST THAT STOOD HERE. Until migration 0209 there
    // was no column, the wire had no field, and this spot asserted the
    // discard out loud. The PO decided campo propio (2026-09-01): the field
    // is back on the wire, the INSERT is what stores it — and the
    // `symptom_observed` bridge stays unreachable on this door, because it
    // needs the registered pet this transport never passes. Both halves
    // matter: the value landing in the column, and the spine staying clean.
    await post({
      command: "file",
      contactMode: "anonymous",
      ...FACTS,
      observedSymptoms: "Costillas visibles, pelaje opaco",
    });
    expect(control.inserted[0].observedSymptoms).toBe("Costillas visibles, pelaje opaco");
    expect(control.petEvents).toEqual([]);
    // NON-VACUITY for the spine assertion: the use-case DOES append a
    // `symptom_observed` when it is given both a pet and a symptom, so an empty
    // `petEvents` means this door passed no pet rather than the bridge being
    // dead.
    expect(control.inserted[0].subjectPetId).toBeNull();
  });

  it("stores NULL when no symptoms were sent — absent is absent, not empty prose", async () => {
    await post({ command: "file", contactMode: "anonymous", ...FACTS });
    expect(control.inserted[0].observedSymptoms).toBeNull();
  });

  it("appends nothing to any pet's spine", async () => {
    // The bridge inside the use-case only fires for a resolved `subjectPetId`,
    // and this door always passes null.
    //
    // Kill it by passing a pet id in `commands.ts`'s `createWelfareReport` call
    // together with `subjectKind: "registered_pet"`. Applied: a
    // `maltreatment_reported` event appears and this fails.
    await post({ command: "file", contactMode: "anonymous", ...FACTS });
    expect(control.petEvents).toEqual([]);
    expect(control.inserted[0].subjectPetId).toBeNull();
  });
});

describe("the budgets are the ones the derivation named", () => {
  it("spends the per-IP bucket on the ADDRESS, before the liveness guard", async () => {
    // Kill it by keying the per-IP bucket on the user id
    //   spendBudget("api_v1_welfare_reports_ip", live.user.id, …)
    // Applied: the identifier assertion fails. This is the debt the turnos route
    // test carries; it is closed here rather than inherited.
    await post({ command: "file", contactMode: "anonymous", ...FACTS });

    expect(control.spent[0]).toEqual({
      endpoint: "api_v1_welfare_reports_ip",
      identifier: CALLER_IP,
    });
  });

  it("spends the per-IP bucket even when the liveness guard then REFUSES", async () => {
    // THE ORDERING CLAIM, MEASURED RATHER THAN ASSERTED. The header says the IP
    // bucket runs BEFORE the GoTrue round-trip so a caller with a well-formed
    // but invalid token cannot spend `auth.getUser()` calls unbounded — and the
    // test above only shows the bucket is spent FIRST on a request that
    // succeeds, which is also true of a handler that spends it after a guard
    // that happened to pass.
    //
    // A refused session is the case that separates the two. Kill it by moving
    // `spendBudget` below `requireLiveUser` in `route.ts`. Applied: `spent` is
    // empty and this fails.
    control.live = () => ({ ok: false, reason: "DEACTIVATED" });
    const response = await post({ command: "file", contactMode: "anonymous", ...FACTS });

    expect(response.status).toBe(403);
    expect(control.spent).toEqual([
      { endpoint: "api_v1_welfare_reports_ip", identifier: CALLER_IP },
    ]);
  });

  it("spends the WEB'S OWN per-user denuncia budget, keyed on the caller", async () => {
    // `welfare_auth` is the bucket `createWelfareReportAction` spends for an
    // authenticated browser submission. One budget for one act, whichever door.
    //
    // Kill it by renaming the bucket to `api_v1_welfare_reports_user`. Applied:
    // this fails — and the failure is the point, because a fresh bucket name is
    // a fresh budget a caller gets by switching transport.
    await post({ command: "file", contactMode: "anonymous", ...FACTS });

    expect(control.spent.map((s) => s.endpoint)).toEqual([
      "api_v1_welfare_reports_ip",
      "welfare_auth",
    ]);
    expect(control.spent[1].identifier).toBe(ME);
  });

  it("answers 429 and writes nothing when the per-user budget is exhausted", async () => {
    // Kill it by returning `true` from `spendUserBudget` on RateLimitError.
    // Applied: this returns 201 and the test fails.
    control.overLimit = new Set(["welfare_auth"]);
    const response = await post({ command: "file", contactMode: "anonymous", ...FACTS });

    expect(response.status).toBe(429);
    expect(control.inserted).toEqual([]);
  });

  it("FAILS OPEN when the limiter itself is broken — an abuse control may not stand between a person and an authority", async () => {
    // Five sibling files carry a test with this name and the turnos door's
    // documented fail-open has none, which is why its own debt row exists.
    //
    // Kill it by changing `return true` to `return false` in `spendUserBudget`'s
    // catch. Applied: this returns 429 and the test fails.
    control.limiterBroken = new Set(["welfare_auth"]);
    const response = await post({ command: "file", contactMode: "anonymous", ...FACTS });

    expect(response.status).toBe(201);
    expect(control.inserted).toHaveLength(1);
    // …and the outage is REPORTED rather than swallowed, so failing open does
    // not also mean failing silent.
    expect(control.errors.join(" ")).toContain("api-v1-welfare-reports/welfare_auth");

    // …and the REPORT DOES NOT CARRY THE CALLER, which is the assertion this
    // case was missing and the reason the stub above now throws production's
    // own message. The limiter's key embeds the identifier, so on the anonymous
    // branch the honest fail-open writes the reporter's uuid into the function
    // logs unless something takes it out. `redactCallerId` in `commands.ts` is
    // that something; delete it and this line goes red on its own, without the
    // sweep below having to reach a path it never exercises.
    expect(control.errors.join(" ")).not.toContain(ME);
    // NON-VACUITY: the message really is the one that would have carried it —
    // the bucket and the window survive, only the identity is gone.
    expect(control.errors.join(" ")).toContain("welfare_auth:«caller»:hour:");
  });

  it("FAILS OPEN on the per-IP bucket too, and the two arms are not the same arm", async () => {
    // NON-VACUITY for the pair above: `overLimit` and `limiterBroken` must
    // produce DIFFERENT outcomes on the same bucket, or the fail-open test is
    // only re-asserting that the stub was never asked to throw.
    control.limiterBroken = new Set(["api_v1_welfare_reports_ip"]);
    expect((await post({ command: "file", contactMode: "anonymous", ...FACTS })).status).toBe(201);

    control.limiterBroken = new Set();
    control.overLimit = new Set(["api_v1_welfare_reports_ip"]);
    expect((await post({ command: "file", contactMode: "anonymous", ...FACTS })).status).toBe(429);
  });
});

describe("the jurisdiction is resolved the way both of the web's intakes resolve it", () => {
  it("routes on the address text and carries the UNVERIFIED mark onto the row", async () => {
    // D.11: a row with a null province is invisible to every govt queue, so the
    // jurisdiction is recovered from the text and MARKED. The mark is not
    // bookkeeping — the triage row renders it.
    //
    // Kill it by hardcoding `jurisdictionUnverified: false` in `commands.ts`.
    // Applied: this fails.
    await post({ command: "file", contactMode: "anonymous", ...FACTS });

    expect(control.jurisdictionInputs[0]).toEqual({
      province: null,
      locality: null,
      localityId: null,
      addressText: FACTS.locationAddress,
      lat: FACTS.locationLat,
      lng: FACTS.locationLng,
    });
    expect(control.inserted[0].jurisdictionProvince).toBe("Río Negro");
    expect(control.inserted[0].jurisdictionLocality).toBe("San Carlos de Bariloche");
    expect(control.inserted[0].jurisdictionUnverified).toBe(true);
    expect(control.cases[0].jurisdictionProvince).toBe("Río Negro");
  });

  it("passes the PICKED candidate's jurisdiction to the gate instead of hardcoding nulls", async () => {
    // Walkthrough 2026-08-31 §2: `resolve_location` handed the phone candidates
    // CARRYING province and locality, the person picked one, and `file` dropped
    // the pair — commands.ts hardcoded nulls into the D.11 gate, so 100% of the
    // mobile channel landed "jurisdicción sin verificar" and the badge stopped
    // separating a careful address from a vague one. The echo now flows.
    //
    // Kill it by restoring `province: null` in commands.ts. Applied: red here.
    control.jurisdiction = {
      province: "CABA",
      locality: "Palermo",
      localityId: null,
      unverified: false,
    };
    await post({
      command: "file",
      contactMode: "anonymous",
      ...FACTS,
      locationProvince: "CABA",
      locationLocality: "Palermo",
    });

    expect(control.jurisdictionInputs[0]).toEqual({
      province: "CABA",
      locality: "Palermo",
      localityId: null,
      addressText: FACTS.locationAddress,
      lat: FACTS.locationLat,
      lng: FACTS.locationLng,
    });
    // And the row honors the gate's VERIFIED answer — the inference mark is for
    // rows whose pair really did come out of text, which this one did not.
    expect(control.inserted[0].jurisdictionUnverified).toBe(false);
  });

  it("canonicalizes the geocoder's long-form province BEFORE the gate's verified pass-through", async () => {
    // The case above pins the wiring with "CABA" — a spelling the phone never
    // sends. `resolve_location` echoes `address.state` as Nominatim spells it,
    // and for every point inside CABA that is the long form below; the catalog
    // and the CHECK on `welfare_reports.jurisdiction_province` (migration 0055)
    // hold "CABA". The gate's verified arm is a byte-identical pass-through, so
    // a raw echo would reach the insert as the long form and fail the CHECK —
    // a 500 on the one channel this phone has for a denuncia. The web runs the
    // same normalizer before the same gate; so does this door now.
    //
    // Kill it by handing `input.locationProvince ?? null` straight to the gate.
    // Applied: the gate sees the long form and the lookup never runs.
    control.localityAnswer = {
      province: "CABA",
      locality: "Palermo",
      canonical: true,
      localityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    };
    control.jurisdiction = {
      province: "CABA",
      locality: "Palermo",
      localityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      unverified: false,
    };
    await post({
      command: "file",
      contactMode: "anonymous",
      ...FACTS,
      locationProvince: "Ciudad Autónoma de Buenos Aires",
      locationLocality: "Palermo",
    });

    // The catalog lookup already receives the canonical province — the
    // normalizer resolves the name before it asks for the locality row.
    expect(control.localityLookups).toEqual([{ rawProvince: "CABA", rawLocality: "Palermo" }]);
    // And the gate receives the catalog pair WITH its FK, which the hardcoded
    // `localityId: null` of the previous wiring threw away.
    expect(control.jurisdictionInputs[0]).toEqual({
      province: "CABA",
      locality: "Palermo",
      localityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      addressText: FACTS.locationAddress,
      lat: FACTS.locationLat,
      lng: FACTS.locationLng,
    });
    expect(control.inserted[0].jurisdictionProvince).toBe("CABA");
    expect(control.inserted[0].localityId).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  });

  it("keeps the province canonical on a locality the catalog does not know — soft, like the web", async () => {
    // "soft" is the web's mode for both denuncia intakes: an unknown locality
    // is not a refusal (the person is reporting an animal, not filling a
    // census), so the raw locality text passes through with no FK — but the
    // province is canonical regardless, because THAT is what the CHECK and the
    // scoped queues compare. Kill it by passing `{ locality: "strict" }`.
    // Applied: nothing reaches the gate; the request fails instead.
    control.jurisdiction = {
      province: "CABA",
      locality: "Barrio inexistente",
      localityId: null,
      unverified: false,
    };
    await post({
      command: "file",
      contactMode: "anonymous",
      ...FACTS,
      locationProvince: "Ciudad Autónoma de Buenos Aires",
      locationLocality: "Barrio inexistente",
    });

    expect(control.jurisdictionInputs[0]).toEqual({
      province: "CABA",
      locality: "Barrio inexistente",
      localityId: null,
      addressText: FACTS.locationAddress,
      lat: FACTS.locationLat,
      lng: FACTS.locationLng,
    });
    expect(control.inserted[0].jurisdictionProvince).toBe("CABA");
    expect(control.inserted[0].localityId).toBeNull();
  });

  it("writes the coordinates through the shared point writer", async () => {
    // `welfare_reports.location_lat/lng` are numeric(10,7); the column takes a
    // string and `writePoint` is what produces it. Kill it by passing
    // `String(input.locationLat)`. Applied: the precision assertion fails.
    await post({ command: "file", contactMode: "anonymous", ...FACTS });

    expect(control.inserted[0].locationLat).toBe("-41.1350000");
    expect(control.inserted[0].locationLng).toBe("-71.3103000");
  });
});

describe("the refusals", () => {
  it("answers auth_required with no Authorization header at all", async () => {
    const response = await POST(
      new Request("https://x/api/v1/welfare-reports", {
        method: "POST",
        body: JSON.stringify({ command: "file", contactMode: "anonymous", ...FACTS }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "auth_required" });
    // AND IT SPENDS NO BUDGET. The header regex runs first, deliberately, in
    // every handler on this surface.
    expect(control.spent).toEqual([]);
  });

  it("refuses a DEACTIVATED account, stricter than the web page, and says why in the header", async () => {
    control.live = () => ({ ok: false, reason: "DEACTIVATED" });
    const response = await post({ command: "file", contactMode: "anonymous", ...FACTS });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "account_deactivated" });
  });

  it("refuses an ERASED account", async () => {
    control.live = () => ({ ok: false, reason: "ACCOUNT_ERASED" });
    const response = await post({ command: "file", contactMode: "anonymous", ...FACTS });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "account_erased" });
  });

  it("answers 503 with a retry-after during maintenance", async () => {
    control.live = () => ({ ok: false, reason: "MAINTENANCE" });
    const response = await post({ command: "file", contactMode: "anonymous", ...FACTS });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("refuses a description under the twenty-character floor the web enforces", async () => {
    const response = await post({
      command: "file",
      contactMode: "anonymous",
      ...FACTS,
      description: "no le dan agua",
    });
    expect(response.status).toBe(400);
    expect(control.inserted).toEqual([]);
  });

  it("refuses the severity a citizen wizard cannot produce", async () => {
    // `high` is a real column value and it is unreachable from a citizen
    // surface. Kill it by adding "high" to WELFARE_REPORT_CITIZEN_SEVERITIES.
    // Applied: this returns 201 and the test fails.
    const response = await post({
      command: "file",
      contactMode: "anonymous",
      ...FACTS,
      severity: "high",
    });
    expect(response.status).toBe(400);
  });

  it("refuses a kind outside the Ley 14.346 catalogue", async () => {
    const response = await post({
      command: "file",
      contactMode: "anonymous",
      ...FACTS,
      kind: "spam",
    });
    expect(response.status).toBe(400);
  });

  it("accepts every one of the nine kinds — the catalogue is not decorative", async () => {
    // NON-VACUITY for the assertion above: a schema that refused everything
    // would satisfy it. Runs the domain's own list, so a kind added to the
    // catalogue and forgotten in the contract fails here as well as in the
    // three-way pin.
    for (const kind of DOMAIN_KINDS) {
      const response = await post({ command: "file", contactMode: "anonymous", ...FACTS, kind });
      expect(response.status, kind).toBe(201);
    }
    expect(control.inserted).toHaveLength(DOMAIN_KINDS.length);
  });

  it("answers 500 when the case transaction fails, and does not forward the writer's prose", async () => {
    // The use-case's only failure sentence is about ATTACHMENTS, which this door
    // never sends — forwarding it would tell a person their photos failed to
    // save when they attached none.
    control.txThrows = true;
    const response = await post({ command: "file", contactMode: "anonymous", ...FACTS });

    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toEqual('{"error":"welfare_report_failed"}');
    expect(body).not.toContain("adjunt");
  });
});
