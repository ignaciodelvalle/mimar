// `POST /api/v1/geocoding` — the app's map, server side (M17).
//
// Pinned: the door (bearer, the route's own IP bucket), the two commands over
// the WEB's own geocoding helpers, the server-side jurisdiction derivation, and
// that a geocoder failure is a 503 — never an empty list that reads as "that
// street does not exist". Since localidades-por-id B3 the derivation is the one
// place resolver's: a jurisdiction only for exactly ONE row, and a name two rows
// share comes back `ambiguous`, with the rows as candidates — never the first.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  spent: [] as string[],
  searchQueries: [] as string[],
  searchResult: [] as Array<Record<string, unknown>>,
  searchThrows: null as null | "rate" | "provider",
  reverseCalls: [] as Array<[number, number]>,
  reverseResult: null as null | Record<string, unknown>,
  /** What the place resolver answers: one row, two homonyms, or nothing. */
  answer: "resolved" as "resolved" | "ambiguous" | "unresolved",
  /** The pin each reverse resolution was asked about, and the geocoder's answer. */
  pinResolutions: [] as Array<{ point: unknown; reversed: unknown }>,
  reverseRateLimited: false,
}));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () => ({
      ok: true,
      supabase: {},
      user: { id: "11111111-1111-4111-8111-111111111111" },
      profile: null,
    }),
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string) => {
      control.spent.push(endpoint);
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

vi.mock("@/lib/infra/report-error", () => ({ reportError: () => undefined }));

vi.mock("@/src/modules/localities/application/geocoding/geocoding", async () => {
  const { RateLimitError } = await import("@/lib/infra/rate-limit");
  return {
    geocodeAddressPublicOrThrow: async (query: string) => {
      control.searchQueries.push(query);
      if (control.searchThrows === "rate") throw new RateLimitError(new Date(), "geocode_public");
      if (control.searchThrows === "provider") throw new Error("provider_error");
      return control.searchResult;
    },
    reverseGeocodePublicOrThrow: async (lat: number, lng: number) => {
      control.reverseCalls.push([lat, lng]);
      if (control.reverseRateLimited) throw new RateLimitError(new Date(), "geocode_public");
      return control.reverseResult;
    },
  };
});

const MECHITA_ALBERTI = {
  localityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  indecId: "06021030",
  provinceCode: "AR-B",
  localityName: "Mechita",
  departmentName: "Alberti",
};
const MECHITA_BRAGADO = {
  localityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  indecId: "06112080",
  provinceCode: "AR-B",
  localityName: "Mechita",
  departmentName: "Bragado",
};

function answerFor(locality: string | null) {
  const base = { reason: null, indecId: null, localityId: null, method: "unresolved" };
  if (control.answer === "resolved" && locality) {
    return {
      ...base,
      status: "resolved",
      provinceCode: "AR-L",
      province: "La Pampa",
      locality,
      localityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      indecId: "42021010",
      method: "exact_name_unique",
      candidates: [],
    };
  }
  if (control.answer === "ambiguous") {
    return {
      ...base,
      status: "ambiguous",
      reason: "ambiguous",
      provinceCode: "AR-B",
      province: "Buenos Aires",
      locality: null,
      candidates: [MECHITA_ALBERTI, MECHITA_BRAGADO],
    };
  }
  return {
    ...base,
    status: "unresolved",
    reason: "not_in_catalogue",
    provinceCode: null,
    province: null,
    locality: null,
    candidates: [],
  };
}

vi.mock("@/lib/place/resolve-place", () => ({
  resolveName: async (_code: string, locality: string) => answerFor(locality),
  resolveGeocodedPin: async (point: unknown, reversed: { locality: string | null } | null) => {
    control.pinResolutions.push({ point, reversed });
    return answerFor(reversed?.locality ?? null);
  },
}));

import { POST } from "@/app/api/v1/geocoding/route";

function post(body: unknown, headers: Record<string, string> = { authorization: "Bearer t" }) {
  return POST(
    new Request("https://x/api/v1/geocoding", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  control.spent = [];
  control.searchQueries = [];
  control.searchResult = [
    {
      lat: -36.62,
      lng: -64.29,
      display_name: "Avenida San Martín 100, Santa Rosa, La Pampa",
      province: "La Pampa",
      locality: "Santa Rosa",
    },
  ];
  control.searchThrows = null;
  control.reverseCalls = [];
  control.reverseResult = {
    display_name: "Avenida San Martín 120, Santa Rosa, La Pampa",
    province: "La Pampa",
    locality: "Santa Rosa",
  };
  control.answer = "resolved";
  control.pinResolutions = [];
  control.reverseRateLimited = false;
});

describe("POST /api/v1/geocoding — the door", () => {
  it("refuses a request with no bearer before spending a counter", async () => {
    const response = await post({ command: "search", query: "San Martín 100" }, {});
    expect(response.status).toBe(401);
    expect(control.spent).toEqual([]);
  });

  it("spends its own IP bucket, and refuses a malformed body", async () => {
    const response = await post({ command: "search", query: "ab" });
    expect(response.status).toBe(400);
    expect(control.spent).toEqual(["api_v1_geocoding_ip"]);
  });
});

describe("search", () => {
  it("answers the web helper's candidates with a server-derived INDEC jurisdiction", async () => {
    const response = await post({ command: "search", query: "San Martín 100, Santa Rosa" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      command: "search",
      version: 1,
      matches: [
        {
          label: "Avenida San Martín 100, Santa Rosa, La Pampa",
          lat: -36.62,
          lng: -64.29,
          jurisdiction: {
            provinceCode: "AR-L",
            provinceName: "La Pampa",
            localityName: "Santa Rosa",
            localityIndecId: "42021010",
          },
          place: { status: "resolved", candidates: [] },
        },
      ],
    });
  });

  it("carries no jurisdiction when the pair does not resolve — no guess", async () => {
    control.answer = "unresolved";
    const body = (await (await post({ command: "search", query: "Calle 1" })).json()) as {
      matches: Array<{ jurisdiction: unknown }>;
    };
    expect(body.matches[0]?.jurisdiction).toBeNull();
  });

  it("answers 429 on the shared budget and 503 on a geocoder failure — never an empty list", async () => {
    control.searchThrows = "rate";
    expect((await post({ command: "search", query: "San Martín 100" })).status).toBe(429);
    control.searchThrows = "provider";
    expect((await post({ command: "search", query: "San Martín 100" })).status).toBe(503);
  });
});

describe("reverse", () => {
  it("names the point under the pin", async () => {
    const response = await post({ command: "reverse", lat: -36.62, lng: -64.29 });
    expect(await response.json()).toMatchObject({
      command: "reverse",
      label: "Avenida San Martín 120, Santa Rosa, La Pampa",
      jurisdiction: { provinceCode: "AR-L", localityName: "Santa Rosa" },
      place: { status: "resolved", candidates: [] },
    });
    expect(control.reverseCalls).toEqual([[-36.62, -64.29]]);
    // The PIN is what is resolved, with the geocoder's answer for it: the door
    // does not spend a second geocoder call.
    expect(control.pinResolutions).toEqual([
      {
        point: { lat: -36.62, lng: -64.29 },
        reversed: expect.objectContaining({ locality: "Santa Rosa" }),
      },
    ]);
  });

  // localidades-por-id B3 (P1): the old derivation took the alphabetically
  // first department of a homonym; an app pin in Bragado's Mechita came back
  // as Alberti's.
  it("a name two rows share is ambiguous: no jurisdiction, both rows by department", async () => {
    control.answer = "ambiguous";
    control.reverseResult = {
      display_name: "Mechita, Buenos Aires",
      province: "Buenos Aires",
      locality: "Mechita",
    };
    const body = (await (await post({ command: "reverse", lat: -35.07, lng: -60.4 })).json()) as {
      jurisdiction: unknown;
      place: { status: string; candidates: Array<Record<string, unknown>> };
    };
    expect(body.jurisdiction).toBeNull();
    expect(body.place.status).toBe("ambiguous");
    expect(body.place.candidates).toEqual([
      {
        provinceCode: "AR-B",
        provinceName: "Buenos Aires",
        localityName: "Mechita",
        localityIndecId: "06021030",
        departmentName: "Alberti",
      },
      {
        provinceCode: "AR-B",
        provinceName: "Buenos Aires",
        localityName: "Mechita",
        localityIndecId: "06112080",
        departmentName: "Bragado",
      },
    ]);
  });

  it("says it has no address rather than inventing one", async () => {
    control.reverseResult = null;
    control.answer = "unresolved";
    const response = await post({ command: "reverse", lat: -36.62, lng: -64.29 });
    expect(await response.json()).toEqual({
      command: "reverse",
      version: 1,
      label: null,
      jurisdiction: null,
      place: { status: "unresolved", candidates: [] },
    });
  });

  it("answers 429 when the shared budget is spent — not 'no address here'", async () => {
    control.reverseRateLimited = true;
    const response = await post({ command: "reverse", lat: -36.62, lng: -64.29 });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
  });

  it("refuses a point off the planet", async () => {
    expect((await post({ command: "reverse", lat: 91, lng: 0 })).status).toBe(400);
  });
});
