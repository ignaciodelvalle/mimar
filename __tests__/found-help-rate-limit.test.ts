// P4 — the per-IP limit on the public plan-B lookup (lib/infra/found-help-limits.ts).
//
// The use case's own test proves an over-limit caller reads nothing; this one
// proves the REAL gate charges its own bucket and refuses past the ceiling.
// The key is read back from the table rather than rebuilt here, so the test
// does not depend on which address the limiter sees outside a request.

import { like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, rateLimitBuckets } from "@/db";
import {
  FOUND_HELP_LOOKUP_BUCKET,
  FOUND_HELP_LOOKUP_LIMIT,
  isFoundHelpLookupThrottled,
} from "@/lib/infra/found-help-limits";

const PREFIX = `${FOUND_HELP_LOOKUP_BUCKET}:%`;

async function clear(): Promise<void> {
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucketKey, PREFIX));
}

beforeAll(clear);
afterAll(clear);

describe("isFoundHelpLookupThrottled", () => {
  it("has its own bucket and a minute and an hour ceiling", () => {
    expect(FOUND_HELP_LOOKUP_BUCKET).toBe("found_help_lookup");
    expect(FOUND_HELP_LOOKUP_LIMIT.maxPerMinute).toBeGreaterThan(0);
    expect(FOUND_HELP_LOOKUP_LIMIT.maxPerHour).toBeGreaterThan(
      FOUND_HELP_LOOKUP_LIMIT.maxPerMinute ?? 0,
    );
  });

  it("lets a caller under the ceiling through, and refuses one at it", async () => {
    // Positive control: a first lookup is allowed and charges the bucket.
    expect(await isFoundHelpLookupThrottled()).toBe(false);
    const charged = await db
      .select({ key: rateLimitBuckets.bucketKey, count: rateLimitBuckets.count })
      .from(rateLimitBuckets)
      .where(like(rateLimitBuckets.bucketKey, PREFIX));
    expect(charged.map((r) => /:(minute|hour):\d+$/.exec(r.key)?.[1]).sort()).toEqual([
      "hour",
      "minute",
    ]);
    expect(charged.every((r) => r.count === 1)).toBe(true);
    // The key names the bucket and the caller's address — never a place.
    for (const r of charged) expect(r.key).not.toMatch(/-\d{2}\.\d/);

    // Fill both windows to their ceiling: the next lookup is refused.
    await db.execute(sql`
      UPDATE public.rate_limit_buckets
         SET count = CASE WHEN bucket_key LIKE '%:minute:%'
                          THEN ${FOUND_HELP_LOOKUP_LIMIT.maxPerMinute ?? 0}
                          ELSE ${FOUND_HELP_LOOKUP_LIMIT.maxPerHour ?? 0} END
       WHERE bucket_key LIKE ${PREFIX}
    `);
    expect(await isFoundHelpLookupThrottled()).toBe(true);
  });
});
