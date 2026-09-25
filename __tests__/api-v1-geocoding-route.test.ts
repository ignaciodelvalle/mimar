// `POST /api/v1/geocoding` — the app's map, server side (M17).
//
// Pinned: the door (bearer, the route's own IP bucket), the two commands over
// the WEB's own geocoding helpers, the server-side jurisdiction derivation, and
// that a geocoder failure is a 503 — never an empty list that reads as "that
// street does not exist".

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  spent: [] as string[],
  searchQueries: [] as string[],
  searchResult: [] as Array<Record<string, unknown>>,
  searchThrows: null as null | "rate" | "provider",
  reverseCalls: [] as Array<[number, number]>,
  reverseResult: null as null | Record<string, unknown>,
  resolvable: true,
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
    reverseGeocodePublicAction: async (lat: number, lng: number) => {
      control.reverseCalls.push([lat, lng]);
      return control.reverseResult;
    },
  };
});

vi.mock("@/lib/infra/jurisdiction-validation", () => ({
  resolveCanonicalJurisdiction: async (input: { rawProvince: string; rawLocality: string }) => {
    if (!control.resolvable) throw new Error("INVALID_LOCALITY");
    return {
      province: { code: "AR-L", name: "La Pampa" },
      locality: { localityName: input.rawLocality, indecId: "42021010" },
    };
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
  control.resolvable = true;
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
        },
      ],
    });
  });

  it("carries no jurisdiction when the pair does not resolve — no guess", async () => {
    control.resolvable = false;
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
    });
    expect(control.reverseCalls).toEqual([[-36.62, -64.29]]);
  });

  it("says it has no address rather than inventing one", async () => {
    control.reverseResult = null;
    const response = await post({ command: "reverse", lat: -36.62, lng: -64.29 });
    expect(await response.json()).toEqual({
      command: "reverse",
      version: 1,
      label: null,
      jurisdiction: null,
    });
  });

  it("refuses a point off the planet", async () => {
    expect((await post({ command: "reverse", lat: 91, lng: 0 })).status).toBe(400);
  });
});
