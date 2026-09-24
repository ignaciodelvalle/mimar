// search-localities.ts — use-cases moved verbatim from app/actions/localities.ts
// (strangler 46/61). Rate limiting and __resetRateLimitForTests are co-located
// so the reset helper resets the same state the searches use.
//
// Auth guard (requireUserOrRedirect) for searchLocalitiesAction is enforced by
// the caller (shim). This function receives the already-resolved userId.
//
// Rate limiting is DB-backed (enforceRateLimit / rate_limit_buckets) — the
// former in-memory rateLimitMap was per-worker and reset on every cold start,
// so on Vercel each lambda instance granted a fresh 60/min budget and the
// limit never actually held. The persistent limiter is atomic and
// cross-worker, same as every other anonymous public surface (see
// lib/infra/rate-limit.ts). FAIL-OPEN on limiter infrastructure failure: a
// broken limiter write must not take down the typeahead — only a genuine
// RateLimitError throttles.

import { searchLocalities } from "@/lib/infra/ar-localidades";
import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { type ProvinceCode, provinceByCode } from "@/lib/reference/ar-provincias";

import type { SearchLocalitiesResult } from "./types";

// Same budget the in-memory limiter enforced: 60 searches per minute per key
// (userId for the auth-gated variant, one shared sentinel for anonymous use).
const RATE_LIMIT_ENDPOINT = "localities_search";
const RATE_LIMIT_CONFIG = { maxPerMinute: 60 } as const;

/** True → proceed; false → throttled. Never throws (fail-open on infra error). */
async function checkRateLimit(identifier: string): Promise<boolean> {
  try {
    await enforceRateLimit(RATE_LIMIT_ENDPOINT, identifier, RATE_LIMIT_CONFIG);
    return true;
  } catch (err) {
    if (err instanceof RateLimitError) return false;
    reportError("localities/rate-limit", err, { identifier });
    return true;
  }
}

// @no-auth-required: test-only utility, prefixed with `__` to mark non-public surface.
// Exposed so a test can reset between cases. Deletes THIS endpoint's persistent
// buckets only — the reset resets the same state the searches use.
export async function __resetRateLimitForTests(): Promise<void> {
  const { db } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  await db.execute(
    sql`delete from rate_limit_buckets where bucket_key like ${`${RATE_LIMIT_ENDPOINT}:%`}`,
  );
}

/** Results per search. One number, one place — every caller gets the same page. */
const SEARCH_LIMIT = 20;

/**
 * The search itself, with NO rate limiting: validate the province, refuse a
 * query too short to be a search, hand the rest to the catalogue.
 *
 * WHY IT IS SEPARATE FROM THE LIMITER (WU-B)
 * -------------------------------------------------------------------------
 * The two action variants below spend the SAME `localities_search` bucket under
 * different identifiers, and they were byte-identical apart from that
 * identifier — so a fix to one (the min-length, the province validation, the
 * page size) reached the other only if someone remembered. That is now
 * structural: they share this body.
 *
 * It is exported because `GET /api/v1/localities` needs the search WITHOUT this
 * module's bucket. That endpoint runs its own per-IP limiter, named as a literal
 * at its own call site (the `/api/v1` envelope fence requires it), because a
 * native typeahead and the web's `perdidas` filter bar are different surfaces
 * and "which surface is being hammered" has to stay answerable from the
 * limiter's own storage. A caller that reaches for THIS function is therefore
 * declaring it bounds itself — the two wrappers below are the proof of what that
 * looks like.
 */
export async function runLocalitySearch(input: {
  provinceCode?: string;
  query: string;
}): Promise<SearchLocalitiesResult> {
  if (input.query.length < 2) return { results: [] };

  let provinceCode: ProvinceCode | undefined;
  if (input.provinceCode) {
    const province = provinceByCode(input.provinceCode);
    if (!province) return { error: "invalid_province" };
    provinceCode = province.code as ProvinceCode;
  }

  const results = await searchLocalities({
    provinceCode,
    query: input.query,
    limit: SEARCH_LIMIT,
  });

  return { results };
}

export async function searchLocalitiesAction(
  userId: string,
  input: {
    provinceCode?: string;
    query: string;
  },
): Promise<SearchLocalitiesResult> {
  if (!(await checkRateLimit(userId))) {
    return { error: "rate_limited" };
  }
  return runLocalitySearch(input);
}

// Public variant — identical logic but no auth guard. Safe because ar_localities
// is INDEC reference data (locality names only, no PII). Rate-limited by a
// dedicated bucket keyed on a fixed sentinel so anonymous callers share one
// window (generous enough for real typeahead use, tight enough against scraping).
const PUBLIC_RATE_LIMIT_SENTINEL = "__public__";

// @no-auth-required: ar_localities is public INDEC reference data (locality
// names only, no PII). Rate-limited via the shared __public__ bucket. Powers the
// public filter typeaheads (perdidas / adoptar) where there is no session.
export async function searchLocalitiesPublicAction(input: {
  provinceCode?: string;
  query: string;
}): Promise<SearchLocalitiesResult> {
  if (!(await checkRateLimit(PUBLIC_RATE_LIMIT_SENTINEL))) {
    return { error: "rate_limited" };
  }
  return runLocalitySearch(input);
}
