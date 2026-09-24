// Shared non-redirect institutional gate for the /api/panorama/* route handlers.
//
// SECURITY (HIGH-2 + CRITICAL-1 exfil half): the three panorama API routes used
// to gate ONLY on `profile.role === 'admin' | 'govt'`. That skipped three of the
// invariants the PAGE guard (loadActiveInstitutionalProfile, lib/infra/auth-
// guards.ts) enforces, so a personal-account role='admin', a deactivated
// operator, or an erased operator could still read national panorama data
// through the API even though the page bounced them. This gate enforces the
// SAME full invariant set the page flow does, but answers with a status code
// (401/403) instead of redirecting — an API route can't redirect.
//
// Invariants enforced (identical to requireAdminOrGovtOrRedirect's page flow):
//   1. LIVENESS, via requireLiveUser, in its own precedence —
//        MAINTENANCE      (503)
//        NO_SESSION       (401)
//        ACCOUNT_ERASED   (401 — mirrors requireUserOrRedirect bouncing erased
//                          accounts to /login, Ley 25.326 art. 16)
//        DEACTIVATED      (403)
//        SHIFT_EXPIRED    (401 session_shift_expired)
//   2. profile exists                   (else 401)
//   3. role ∈ {admin, govt}             (else 403)
//   4. accountType === 'institutional'  (else 403)
//
// THE SHIFT REACHES A GET (B9, 2026-08-25). All six panorama routes are
// read-only, which is not an exemption: this surface answers with NATIONAL
// aggregate analytics, and the exposure a shared municipal desk creates is a
// console left populated on it overnight, not a write. The resolver's own
// doctrine put the shift on org READS for exactly this reason. See
// app/api/gob/_guard.ts, which carries the full argument.

import { NextResponse } from "next/server";

import { type GobReadRole, isGobReadRole } from "@/lib/domain/jurisdiction-canonical";
import { liveUserApiResponse } from "@/lib/infra/api-liveness";
import { requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";
import {
  type CachedJurisdiction,
  type CachedProfile,
  getJurisdictionsCached,
} from "@/lib/infra/request-cache";

// SECURITY (MED-2, pre-national security review): per-operator aggregate cap on
// the analytics fan-out. Each panorama query is bounded individually by
// withDbBudget, but the cache key varies on many caller-controllable dimensions
// (level, asOf, basis, verified, custom from/to, drill), so an authenticated
// institutional session could force cache misses and saturate the 2-connection
// analytics pool in aggregate. This per-profile cap is deliberately generous
// (well above any legitimate console interaction) — it only clips a burst abuse
// pattern, never a real operator paging through the map.
const PANORAMA_API_MAX_PER_MINUTE = 120;

export type PanoramaActor = {
  profile: CachedProfile;
  role: GobReadRole;
  // Empty for admin and national (universal read scope); populated for govt
  // with active tuples.
  jurisdictions: CachedJurisdiction[];
};

export type PanoramaGuardResult =
  | { ok: true; actor: PanoramaActor }
  | { ok: false; response: NextResponse };

/**
 * Resolve the caller as an ACTIVE INSTITUTIONAL admin/govt, or return the
 * NextResponse to send (401/403). Callers do:
 *
 *   const auth = await resolveInstitutionalPanoramaActor();
 *   if (!auth.ok) return auth.response;
 *   const { role, jurisdictions } = auth.actor;
 */
export async function resolveInstitutionalPanoramaActor(): Promise<PanoramaGuardResult> {
  // Maintenance, session, erasure, deactivation and the 8-hour shift, in that
  // order — and the profile comes back already resolved, so the liveness set is
  // the same one request-memoized read this guard used to make by itself.
  const live = await requireLiveUser();
  if (!live.ok) return { ok: false, response: liveUserApiResponse(live.reason) };

  // Mid-signup: auth.users exists, the profile row does not yet.
  const profile = live.profile;
  if (!profile) {
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }

  // Role + account type — the two checks liveness does not make. Erasure and
  // deactivation are no longer repeated here; requireLiveUser refused both.
  //
  // Read-only routes, so the read-only `national` role is admitted alongside
  // admin | govt — the same set requireGobReadAccessOrRedirect admits for the
  // panorama pages that call them.
  if (!isGobReadRole(profile.role) || profile.accountType !== "institutional") {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }

  // Aggregate per-operator request cap (MED-2). Applied AFTER auth resolves so
  // only authenticated institutional actors are counted, keyed on profile id so
  // it bounds a single account (or a stolen session) regardless of source IP.
  // On breach, answer 429 rather than throwing (an API route can't redirect).
  try {
    await enforceRateLimit("panorama_api", profile.id, {
      maxPerMinute: PANORAMA_API_MAX_PER_MINUTE,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "rate_limited" },
          { status: 429, headers: { "Retry-After": "60" } },
        ),
      };
    }
    throw err;
  }

  const role = profile.role;
  const jurisdictions = role === "govt" ? await getJurisdictionsCached(profile.id) : [];

  return { ok: true, actor: { profile, role, jurisdictions } };
}
