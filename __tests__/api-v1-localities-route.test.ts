// GET /api/v1/localities — the INDEC typeahead a native client needs BEFORE it
// can register anything.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE PROJECTION. `LocalitySearchResult` carries the `ar_localities` uuid
//      (the app's structural FK) and a `matchKind` ranking signal, and neither
//      belongs on a wire. The uuid buys a client nothing — the write endpoint
//      re-resolves the pair itself — and `matchKind` invites a client to re-sort
//      and disagree with the server about which result is best.
//   2. A SHORT QUERY IS A 200, NOT AN ERROR. A typeahead fires on every
//      keystroke; the first one is not a client error, and reporting it as one
//      makes every native search box flash a message on its way to working.
//   3. It is PUBLIC and BOUNDED — its own per-IP bucket, not the module's shared
//      `__public__` sentinel, so one scraper cannot starve the web's anonymous
//      filter bars and "which surface is being hammered" stays answerable.
//   4. `cache-control: no-store` on every branch.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  limiterThrows: null as null | (() => never),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  /** Arguments the search received, in order. */
  searches: [] as Array<{ query: string; provinceCode?: string }>,
  /** When set, replaces the search's answer. */
  search: null as null | (() => unknown),
}));

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.limits.push({ endpoint, identifier });
      control.limiterThrows?.();
    },
  };
});

vi.mock("@/src/modules/localities/application/search/search-localities", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/src/modules/localities/application/search/search-localities")
    >();
  return {
    ...actual,
    runLocalitySearch: async (input: { query: string; provinceCode?: string }) => {
      control.searches.push(input);
      return control.search ? control.search() : { results: [] };
    },
  };
});

import { RateLimitError } from "@/lib/infra/rate-limit";
import { LOCALITIES_PAYLOAD_VERSION } from "@dim/contract/api";

import { GET } from "@/app/api/v1/localities/route";

const CATALOG_ROW = {
  id: "99999999-9999-4999-8999-999999999999",
  indecId: "02007010",
  provinceCode: "AR-C",
  departmentName: "Comuna 15",
  departmentCode: "007",
  localityName: "Villa Crespo",
  localitySlug: "villa-crespo",
  category: "E" as const,
  provinceName: "Ciudad Autónoma de Buenos Aires",
  matchKind: "prefix" as const,
};

function req(search: string) {
  return new Request(`http://localhost:3000/api/v1/localities${search}`, {
    headers: { "x-real-ip": "203.0.113.77" },
  });
}

beforeEach(() => {
  control.limiterThrows = null;
  control.limits = [];
  control.searches = [];
  control.search = null;
});

describe("GET /api/v1/localities — the query", () => {
  it("passes the trimmed q through to the search", async () => {
    await GET(req("?q=%20Villa%20Crespo%20"));
    expect(control.searches[0]).toEqual({ query: "Villa Crespo" });
  });

  it("passes an optional province narrowing through", async () => {
    await GET(req("?q=Villa&province=AR-C"));
    expect(control.searches[0]).toEqual({ query: "Villa", provinceCode: "AR-C" });
  });

  it("omits the province entirely when it is blank, rather than sending an empty string", async () => {
    await GET(req("?q=Villa&province="));
    expect(control.searches[0]).toEqual({ query: "Villa" });
  });

  it("answers 200 with an empty list for a query too short to search", async () => {
    // NOT a 400. A typeahead fires on the first keystroke and that is not a
    // client error; the underlying search returns `{ results: [] }` for anything
    // under two characters and this endpoint reports it as the ordinary answer.
    control.search = () => ({ results: [] });

    const res = await GET(req("?q=V"));

    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([]);
  });

  it("answers 200 with an empty list when there is simply no q at all", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(200);
  });

  it("answers invalid_request for a province code the catalogue does not know", async () => {
    control.search = () => ({ error: "invalid_province" });

    const res = await GET(req("?q=Villa&province=AR-ZZZ"));

    // A client that asked for one province and silently got every province would
    // render the wrong list with no way to notice.
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });
});

describe("GET /api/v1/localities — the wire shape", () => {
  it("carries the three envelope fields §6 requires on every read", async () => {
    const body = (await (await GET(req("?q=Villa"))).json()) as Record<string, unknown>;

    expect(body.payloadVersion).toBe(LOCALITIES_PAYLOAD_VERSION);
    expect(Date.parse(body.staleAfter as string)).toBeGreaterThan(
      Date.parse(body.issuedAt as string),
    );
  });

  it("projects a catalogue row to exactly the six fields a client renders and sends back", async () => {
    control.search = () => ({ results: [CATALOG_ROW] });

    const body = (await (await GET(req("?q=Villa"))).json()) as {
      results: Array<Record<string, unknown>>;
    };

    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toEqual({
      // SIX, NOT FIVE, since A2-alta-asentar-03. `indecId` is INDEC's own
      // published identifier and it is the field that makes a choice between two
      // homonyms mean anything: the catalogue ships 68 (province, name)
      // collisions, the picker disambiguates them by department, and a write
      // carrying only the name resolved to the alphabetically first department
      // regardless of the row tapped.
      indecId: "02007010",
      localityName: "Villa Crespo",
      localitySlug: "villa-crespo",
      provinceCode: "AR-C",
      provinceName: "Ciudad Autónoma de Buenos Aires",
      departmentName: "Comuna 15",
    });
  });

  it("drops the ar_localities uuid and the matchKind ranking signal", async () => {
    // THE UUID STILL DOES NOT TRAVEL, and that distinction is the point of this
    // case now that `indecId` does: the uuid is the APP'S structural FK
    // (migration 0147), private to our schema; the INDEC id is a published
    // national identifier a client is meant to hand back.
    control.search = () => ({ results: [CATALOG_ROW] });

    const body = JSON.stringify(await (await GET(req("?q=Villa"))).json());

    expect(body).not.toContain(CATALOG_ROW.id);
    expect(body).not.toContain("matchKind");
  });

  it("keeps a null departmentName as null — CABA barrios genuinely have none", async () => {
    control.search = () => ({ results: [{ ...CATALOG_ROW, departmentName: null }] });
    const body = (await (await GET(req("?q=Villa"))).json()) as {
      results: Array<{ departmentName: string | null }>;
    };
    expect(body.results[0].departmentName).toBeNull();
  });
});

describe("GET /api/v1/localities — bounded, not authorized", () => {
  it("serves an anonymous caller — a native signup asks where you live before there is a session", async () => {
    const res = await GET(req("?q=Villa"));
    expect(res.status).toBe(200);
  });

  it("spends its OWN per-IP bucket, not the module's shared __public__ sentinel", async () => {
    await GET(req("?q=Villa"));
    expect(control.limits).toEqual([{ endpoint: "api_v1_localities", identifier: "203.0.113.77" }]);
  });

  it("bounds BEFORE it searches", async () => {
    // A limiter placed after the read bounds nothing. The assertion is on order.
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "test");
    };

    const res = await GET(req("?q=Villa"));

    expect(res.status).toBe(429);
    expect(control.searches).toEqual([]);
  });

  it("FAILS OPEN when the limiter itself is broken", async () => {
    // This endpoint stands between a citizen and a completed registration, and
    // a false throttle costs a pet its credential. The data is public INDEC
    // reference data; there is no secret behind the limit.
    control.limiterThrows = () => {
      throw new Error("rate_limit_buckets is on fire");
    };
    expect((await GET(req("?q=Villa"))).status).toBe(200);
  });

  it.each([
    ["success", "?q=Villa"],
    ["short query", "?q=V"],
  ])("sets cache-control: no-store on the %s branch", async (_label, search) => {
    const res = await GET(req(search));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("sets cache-control: no-store on the throttled branch too", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "test");
    };
    const res = await GET(req("?q=Villa"));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
