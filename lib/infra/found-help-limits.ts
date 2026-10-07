// Per-IP ceiling for the finder's plan-B lookup on /encontre-un-animal
// (findNearbyHelpAction, P4 — design note
// docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md §4).
//
// WHAT IT BOUNDS. Each call is three or four indexed reads, and the answer is
// a list of organizations near a locality the caller names — so an unbounded
// caller could walk the ~4,500 catalogue localities and rebuild the map of
// every receiving organization (and, via the coarse distances, approximate
// where each one is). The lists themselves are public; the bound is on how
// fast one address can enumerate them.
//
// THE NUMBERS. One finder picks a locality, maybe corrects it, maybe asks
// again for the vets: three to five lookups. Behind one carrier IPv4 (the
// 1,000-subscriber planning figure lib/infra/public-browse-limits.ts uses)
// several finders can be active in the same minute without the board being
// anyone's habit. 30/min leaves six simultaneous finders; 300/hour is sixty
// finders an hour from one gateway — far above anything this page sees — and
// one sweep of the catalogue takes over fifteen hours.
//
// FAILS OPEN, like every caller of isPublicTokenReadThrottled: the limiter is
// itself a DB write, and on a degraded database it must not be what stops a
// person holding an animal from seeing who can take it.
//
// /p/{token}/encontre does not use this bucket: its submit action is already
// limited per (IP, token) and per token (lib/infra/anonymous-report-limits.ts),
// and the plan-B list rides on that same request.

import { isPublicTokenReadThrottled } from "@/lib/infra/public-token-throttle";
import type { RateLimitConfig } from "@/lib/infra/rate-limit";

export const FOUND_HELP_LOOKUP_BUCKET = "found_help_lookup";

export const FOUND_HELP_LOOKUP_LIMIT: RateLimitConfig = {
  maxPerMinute: 30,
  maxPerHour: 300,
};

/** True when the caller's address is over the limit. Charges one lookup. */
export function isFoundHelpLookupThrottled(): Promise<boolean> {
  return isPublicTokenReadThrottled(FOUND_HELP_LOOKUP_BUCKET, FOUND_HELP_LOOKUP_LIMIT);
}
