// app/sitemap.ts is an anonymous, force-dynamic route that reads three feeds
// from the database. These tests pin what bounds that work (audit 2026-09-fresh,
// A03-G2/G3/G8) and that nothing it emits is a URL app/robots.ts tells a
// crawler not to fetch (A03-G1).
//
// WHAT WAS WRONG. Every GET /sitemap.xml ran a three-way fan-out with no
// deadline, no cache window and no `.limit()` on the organizations select, and
// the lost feed was handed a page size its reader multiplies by five: 5,000
// became a 25,000-row ordered scan, under a comment claiming both feeds were
// "already bounded". No test imported the module, so nothing could have seen
// any of it.
//
// Every expected number below is written out here rather than imported: a test
// that reads the constant it is checking agrees with any value the constant
// takes.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { cacheRegistration, mockQueryAdoption, mockQueryLost, orgQuery } = vi.hoisted(() => ({
  cacheRegistration: {
    keys: null as unknown,
    options: null as { revalidate?: unknown; tags?: unknown } | null,
  },
  mockQueryAdoption: vi.fn(),
  mockQueryLost: vi.fn(),
  orgQuery: {
    limitCalls: [] as number[],
    rows: [] as Array<{ token: string; updatedAt: Date }>,
  },
}));

// The Data Cache needs a Next request context; here it is a pass-through that
// records how it was registered, which is the part under test.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown, keys: unknown, options: { revalidate?: unknown }) => {
    cacheRegistration.keys = keys;
    cacheRegistration.options = options;
    return fn;
  },
}));

vi.mock("@/src/modules/adoption/infrastructure/adoption-listing-read", () => ({
  queryAdoptionListing: mockQueryAdoption,
}));

vi.mock("@/src/modules/lost/infrastructure/lost-listing-read", () => ({
  queryLostListing: mockQueryLost,
}));

// The real schema under a mocked client, so `organizations` is the real table
// object and only the query chain is fake. `.limit()` is the chain's terminal
// call: a select that loses it resolves to the chain object, not to rows, and
// the render fails on `.map` — so removing the bound cannot pass quietly.
vi.mock("@/db", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema")>("@/db/schema");
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async (n: number) => {
      orgQuery.limitCalls.push(n);
      return orgQuery.rows;
    },
  };
  return { ...schema, db: { select: () => chain } };
});

// loadWithTimeout reports a missed deadline; the report itself is not the
// subject here.
vi.mock("@/lib/observability/report-error", () => ({
  reportError: vi.fn(),
  buildErrorReport: vi.fn(),
}));

import robots from "@/app/robots";
import * as sitemapModule from "@/app/sitemap";

const sitemap = sitemapModule.default;

const LISTED_AT = new Date("2026-09-01T12:00:00.000Z");
const LOST_AT = new Date("2026-09-10T08:30:00.000Z");
const ORG_UPDATED_AT = new Date("2026-08-20T00:00:00.000Z");

beforeEach(() => {
  vi.useRealTimers();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://mimar.example.ar");
  mockQueryAdoption.mockReset().mockResolvedValue({
    items: [{ petPublicToken: "DIM-ADPT-2345", adoptionListedAt: LISTED_AT }],
    nextCursor: null,
  });
  mockQueryLost.mockReset().mockResolvedValue({
    items: [{ petPublicToken: "DIM-LOST-2345", markedLostAt: LOST_AT }],
    nextCursor: null,
  });
  orgQuery.limitCalls = [];
  orgQuery.rows = [{ token: "ORG-REFU-2345", updatedAt: ORG_UPDATED_AT }];
});

describe("app/sitemap.ts — every read is bounded", () => {
  it("hands the lost feed its cap as the FOURTH argument, so 5,000 stays 5,000", async () => {
    // queryLostListing's superset cap is max(500, pageSize * 5) unless the
    // fourth argument overrides it. With three arguments this call scanned
    // 25,000 rows.
    await sitemap();
    expect(mockQueryLost).toHaveBeenCalledTimes(1);
    expect(mockQueryLost).toHaveBeenCalledWith({}, null, 5000, 5000);
  });

  it("keeps the adoption feed at the same ceiling (its reader already limits by page size)", async () => {
    await sitemap();
    expect(mockQueryAdoption).toHaveBeenCalledWith({}, null, 5000);
  });

  it("limits the organizations select, which had no bound at all", async () => {
    await sitemap();
    expect(orgQuery.limitCalls).toEqual([5000]);
  });

  it("caches the reads with a real revalidate window, and declares none on the route", async () => {
    // `export const revalidate` beside `dynamic = "force-dynamic"` is ignored by
    // Next — the route stays revalidate 0 — so the window has to live on the
    // data. Asserting the route export is ABSENT is what stops somebody adding
    // the fictional one and reading it as a cache.
    expect(cacheRegistration.options?.revalidate).toBe(900);
    expect(sitemapModule.dynamic).toBe("force-dynamic");
    expect((sitemapModule as Record<string, unknown>).revalidate).toBeUndefined();
  });

  it("fails the route when the reads miss their deadline, instead of shipping four URLs", async () => {
    // A crawler that gets a 5xx keeps the sitemap it already has; one that gets
    // a 200 with only the static entries takes it as the new truth.
    vi.useFakeTimers();
    mockQueryLost.mockReturnValue(new Promise(() => {}));

    const pending = sitemap();
    const settled = pending.then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(10_000);

    const outcome = await settled;
    expect(outcome).toBeInstanceOf(Error);
    expect(String((outcome as Error).message)).toMatch(/sitemap: listing reads unavailable/);
  });

  it("still emits one URL per row, from the contract's deep-link shapes", async () => {
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);

    expect(urls).toContain("https://mimar.example.ar/adoptar/DIM-ADPT-2345");
    expect(urls).toContain("https://mimar.example.ar/p/DIM-LOST-2345");
    expect(urls).toContain("https://mimar.example.ar/refugios/ORG-REFU-2345");
    // Four static entries plus one per row.
    expect(entries).toHaveLength(7);

    // lastModified survives as the same instant whether it arrived as a Date
    // (a cache miss) or as the JSON string a cache hit returns.
    const lost = entries.find((e) => e.url.endsWith("/p/DIM-LOST-2345"));
    expect(new Date(String(lost?.lastModified)).toISOString()).toBe(LOST_AT.toISOString());
  });
});

// ---------------------------------------------------------------------------
// robots.txt against the sitemap (A03-G1)
// ---------------------------------------------------------------------------
//
// A Disallow value is a PREFIX of the raw path (RFC 9309 §2.2.2), and when an
// Allow and a Disallow both match, the longer one wins, with a tie going to
// Allow. `"/r"` therefore matched `/refugios/{token}`, and the sitemap spent a
// priority-0.8 line on every verified shelter that robots.txt then forbade.
// The existing robots test in public-credential-retention.test.tsx checked
// three surfaces by hand and /refugios was not one of them; this one checks
// whatever the sitemap actually emits.

type RobotsRules = { allow: string[]; disallow: string[] };

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** The rules app/robots.ts serves to `User-agent: *`. */
function liveRules(): RobotsRules {
  const result = robots();
  const groups = Array.isArray(result.rules) ? result.rules : [result.rules];
  const star = groups.filter((g) => asList(g.userAgent).includes("*"));
  return {
    allow: star.flatMap((g) => asList(g.allow)),
    disallow: star.flatMap((g) => asList(g.disallow)),
  };
}

/** RFC 9309 matching for plain prefixes: longest match wins, a tie goes to Allow. */
function isDisallowed(path: string, rules: RobotsRules): boolean {
  const longest = (patterns: string[]) =>
    patterns.filter((p) => path.startsWith(p)).reduce((best, p) => Math.max(best, p.length), -1);
  return longest(rules.disallow) > longest(rules.allow);
}

describe("robots.txt never forbids what the sitemap advertises", () => {
  it("uses plain prefixes only — the matcher above models nothing else", () => {
    // `*` and `$` change the matching rules. If one ever lands in the file, this
    // test's model is wrong, and it should say so instead of passing.
    const { allow, disallow } = liveRules();
    for (const pattern of [...allow, ...disallow]) {
      expect(pattern, `${pattern} is not a plain prefix`).not.toMatch(/[*$]/);
    }
    expect(disallow.length).toBeGreaterThan(0);
  });

  it("allows every URL the sitemap emits", async () => {
    const entries = await sitemap();
    const paths = entries.map((e) => new URL(e.url).pathname);
    // NON-VACUITY: every shape the sitemap can emit is in this run — the four
    // static pages and one of each token-bearing kind.
    expect(paths).toEqual(
      expect.arrayContaining([
        "/",
        "/adoptar",
        "/perdidas",
        "/denuncias/nueva",
        "/adoptar/DIM-ADPT-2345",
        "/p/DIM-LOST-2345",
        "/refugios/ORG-REFU-2345",
      ]),
    );

    const rules = liveRules();
    const blocked = paths.filter((p) => isDisallowed(p, rules));
    expect(blocked).toEqual([]);
  });

  it("leaves the shelter directory and every shelter profile crawlable", () => {
    const rules = liveRules();
    expect(isDisallowed("/refugios", rules)).toBe(false);
    expect(isDisallowed("/refugios/ORG-REFU-2345", rules)).toBe(false);
  });

  it("still closes the capability-bearing paths the two entries were written for", () => {
    // The fix is a trailing slash, not a deletion: /t/{serial} and
    // /r/invite/{token} stay out of every index.
    const rules = liveRules();
    expect(isDisallowed("/t/TAG-ABCD-2345", rules)).toBe(true);
    expect(isDisallowed("/r/invite/INV-ABCD-2345", rules)).toBe(true);
    expect(isDisallowed("/libreta/compartir/SHR-ABCD-2345", rules)).toBe(true);
  });

  it("the matcher bites: the old bare '/r' entry blocks /refugios", () => {
    // RED control, against the list as it was. A matcher that could not see
    // this would pass the assertions above over any robots.txt at all.
    const old: RobotsRules = { allow: ["/"], disallow: ["/libreta", "/t", "/r"] };
    expect(isDisallowed("/refugios/ORG-REFU-2345", old)).toBe(true);
    expect(isDisallowed("/refugios", old)).toBe(true);
  });
});
