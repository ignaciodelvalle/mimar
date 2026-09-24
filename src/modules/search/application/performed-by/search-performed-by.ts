// search-performed-by.ts — use-case moved verbatim from app/actions/performed-by.ts
// (strangler 60/61). Rate limiting and __resetPerformedByRateLimitForTests are
// co-located so the reset helper resets the same state the search uses.
//
// Auth guard (requireUserOrRedirect) is enforced by the caller (shim). This
// function receives the already-resolved userId.
//
// Rate limiting is DB-backed (enforceRateLimit / rate_limit_buckets) — the
// former in-memory rateLimitMap was per-worker and reset on every cold start,
// so on Vercel each lambda instance granted a fresh 60/min budget and the
// limit never actually held. Same migration as search-localities.ts. FAIL-OPEN
// on limiter infrastructure failure: a broken limiter write must not take down
// the typeahead — only a genuine RateLimitError throttles.

import { type SearchJurisdiction, searchVetsAndClinics } from "@/lib/infra/performed-by-search";
import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";

import type { SearchPerformedByResult } from "./types";

// Same budget the in-memory limiter enforced: 60 searches per minute per user.
const RATE_LIMIT_ENDPOINT = "performed_by_search";
const RATE_LIMIT_CONFIG = { maxPerMinute: 60 } as const;

/** True → proceed; false → throttled. Never throws (fail-open on infra error). */
async function checkRateLimit(identifier: string): Promise<boolean> {
  try {
    await enforceRateLimit(RATE_LIMIT_ENDPOINT, identifier, RATE_LIMIT_CONFIG);
    return true;
  } catch (err) {
    if (err instanceof RateLimitError) return false;
    reportError("performed-by/rate-limit", err, { identifier });
    return true;
  }
}

// @no-auth-required: test-only utility, prefixed with `__` to mark non-public surface.
// Deletes THIS endpoint's persistent buckets only — the reset resets the same
// state the search uses.
export async function __resetPerformedByRateLimitForTests(): Promise<void> {
  const { db } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  await db.execute(
    sql`delete from rate_limit_buckets where bucket_key like ${`${RATE_LIMIT_ENDPOINT}:%`}`,
  );
}

export async function searchVetsAndClinicsAction(
  userId: string,
  input: {
    query: string;
    jurisdiction?: SearchJurisdiction;
  },
): Promise<SearchPerformedByResult> {
  if (!(await checkRateLimit(userId))) return { error: "rate_limited" };
  const results = await searchVetsAndClinics(input.query, input.jurisdiction);
  return { results };
}
