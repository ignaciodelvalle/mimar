// SC-6 (audit 2026-07-26, red #3) — "Urgencia" must rank the WHOLE filtered
// set, not the page the server already picked by date.
//
// THE BUG, stated as the fixture states it: a 400-day-old bite incident is the
// most urgent case in the jurisdiction by a factor of 400, and it is also the
// OLDEST — so under the date order it sits on page 2, and a client-side sort of
// page 1 could never surface it. The queue's headline said "orden: Urgencia"
// over a list that did not contain the most urgent case.
//
// These tests are live-DB on purpose: the fix is an ORDER BY (and an OFFSET
// walk over it), so the only thing worth asserting is what Postgres actually
// returns. A mocked query would be a test of the mock.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db } from "@/db";
import { listCasesForAdmin } from "@/lib/infra/case-queries";
import { withMutationOverride } from "./_helpers/db-overrides";

// A jurisdiction of our own, so the fixtures are the only rows the queries can
// return no matter what else lives in the dev DB. The province must be one of
// the 24 canonical names (migration 0055's check constraint); the locality is
// free text, so it carries the fixture marker.
const PROVINCE = "Tierra del Fuego";
const LOCALITY = "SC6-URGENCIA-FIXTURE";
const CODE_PREFIX = "SC6-URG-";

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

// Kinds picked for their SEVERITY WEIGHT (CASE_KIND_SEVERITY_WEIGHT):
//   bite_incident   → 3
//   adoption_listing → 1
// Scores below are age-days × weight, the exact quantity caseUrgencyScoreSql
// computes.
const FIXTURES = [
  // code       kind                openedAt      score  (date rank / urgency rank)
  { code: "D", kind: "adoption_listing", days: 1 }, //     1   (1st by date / 4th)
  { code: "A", kind: "adoption_listing", days: 2 }, //     2   (2nd by date / 3rd)
  { code: "B", kind: "adoption_listing", days: 3 }, //     3   (3rd by date / 2nd)
  { code: "C", kind: "bite_incident", days: 400 }, //   1200   (LAST by date / 1st)
] as const;

// Fixtures are PET-LESS: `cases_open_per_pet_kind_idx` (migration 0033) caps a
// pet at one open case per kind, and NULL primary_pet_id is outside that index.
// Neither the ordering nor the filters read the pet, so nothing is lost.
async function seed(input: {
  code: string;
  kind: string;
  openedAt: Date;
  closedAt?: Date;
}): Promise<void> {
  await db.insert(cases).values({
    publicCode: `${CODE_PREFIX}${input.code}`,
    caseKind: input.kind,
    primarySubjectKind: "general",
    status: input.closedAt ? "closed" : "open",
    closedAt: input.closedAt ?? null,
    openedAt: input.openedAt,
    jurisdictionProvince: PROVINCE,
    jurisdictionLocality: LOCALITY,
  });
}

async function cleanup(): Promise<void> {
  await withMutationOverride(async (tx) => {
    await tx.delete(cases).where(sql`${cases.publicCode} LIKE ${`${CODE_PREFIX}%`}`);
  });
}

const FILTERS = { province: PROVINCE, locality: LOCALITY, status: null } as const;

/** Strip the fixture prefix so assertions read as the fixture table above. */
const codes = (rows: Array<{ publicCode: string }>) =>
  rows.map((r) => r.publicCode.replace(CODE_PREFIX, ""));

beforeAll(async () => {
  await cleanup();
  for (const f of FIXTURES) {
    await seed({ code: f.code, kind: f.kind, openedAt: daysAgo(f.days) });
  }
});

afterAll(cleanup);

describe("case queue ordering — urgency is ranked in SQL, over the whole set", () => {
  it("the most urgent case is NOT on page 1 of the date order (the bug's precondition)", async () => {
    const page1 = await listCasesForAdmin({ limit: 2, sort: "recientes", filters: FILTERS });
    // Newest-opened first, exactly as before this change.
    expect(codes(page1)).toEqual(["D", "A"]);
    // C — score 1200, the single most urgent row — is nowhere in the page a
    // client-side sort would have had to work with.
    expect(codes(page1)).not.toContain("C");
  });

  it("surfaces that same buried case FIRST under the urgency sort", async () => {
    const page1 = await listCasesForAdmin({ limit: 2, sort: "urgencia", filters: FILTERS });
    expect(codes(page1)[0]).toBe("C");
    // Full page: the two highest scores across the set (1200, then 3).
    expect(codes(page1)).toEqual(["C", "B"]);
  });

  it("walks the SAME ranking across offset pages — no page re-ranked against itself", async () => {
    const page1 = await listCasesForAdmin({ limit: 2, sort: "urgencia", filters: FILTERS });
    const page2 = await listCasesForAdmin({
      limit: 2,
      offset: 2,
      sort: "urgencia",
      filters: FILTERS,
    });
    expect(codes(page2)).toEqual(["A", "D"]);
    // The two pages partition the set: nothing repeated, nothing dropped. This
    // is the property the old per-page client sort could not have — page 2's
    // first row used to be able to outrank page 1's last.
    expect([...codes(page1), ...codes(page2)].sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("ignores a keyset cursor under urgency ordering rather than mixing the two", async () => {
    // A cursor built from the date order names a point in a DIFFERENT ranking.
    // Honouring it would silently intersect two orders; the query drops it.
    const [firstByDate] = await listCasesForAdmin({
      limit: 1,
      sort: "recientes",
      filters: FILTERS,
    });
    const cursor = Buffer.from(
      `${firstByDate.openedAt.toISOString()}|${firstByDate.id}`,
      "utf8",
    ).toString("base64url");

    const withCursor = await listCasesForAdmin({
      limit: 2,
      cursor,
      sort: "urgencia",
      filters: FILTERS,
    });
    expect(codes(withCursor)).toEqual(["C", "B"]);
  });

  it("sinks a closed case below every open one, however old it is", async () => {
    // Older than C and the same severity-3 kind — under the raw age×weight
    // formula it would outrank everything. Closed scores 0 instead: resolved is
    // never urgent (caseUrgencyScore's own rule, now mirrored in SQL).
    await seed({
      code: "E",
      kind: "bite_incident",
      openedAt: daysAgo(900),
      closedAt: daysAgo(1),
    });
    try {
      const all = await listCasesForAdmin({ limit: 10, sort: "urgencia", filters: FILTERS });
      expect(codes(all)).toEqual(["C", "B", "A", "D", "E"]);
    } finally {
      await withMutationOverride(async (tx) => {
        await tx.delete(cases).where(sql`${cases.publicCode} = ${`${CODE_PREFIX}E`}`);
      });
    }
  });
});
