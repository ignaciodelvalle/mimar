// Shared non-redirect institutional gate for the /api/gob/* route handlers.
//
// The govt inspector (task #12) fetches case + pet detail through client-side
// API routes instead of a full navigation. An API route cannot redirect, so it
// must enforce the SAME full invariant set the PAGE guard
// (loadActiveInstitutionalProfile, lib/infra/auth-guards.ts →
// requireAdminOrGovtOrRedirect) enforces, but answer with a status code.
//
// This mirrors app/api/panorama/_guard.ts EXACTLY (same five invariants, same
// per-operator aggregate cap) — kept as a SIBLING rather than reused so the
// two API families rate-limit under distinct buckets ("gob_api" vs
// "panorama_api") and read as self-documenting call sites.
//
// Invariants enforced (identical to requireAdminOrGovtOrRedirect's page flow):
//   1. LIVENESS, via requireLiveUser, in its own precedence —
//        MAINTENANCE      (503)
//        NO_SESSION       (401)
//        ACCOUNT_ERASED   (401)
//        DEACTIVATED      (403)
//        SHIFT_EXPIRED    (401 session_shift_expired)
//   2. profile exists                   (else 401)
//   3. role ∈ {admin, govt}             (else 403)
//   4. accountType === 'institutional'  (else 403)
//
// Jurisdiction-scope enforcement is the CALLER's responsibility (per-row 404,
// never leak existence) — this gate only resolves WHO the actor is and their
// active assignment tuples.
//
// THE SHIFT REACHES A GET, AND THAT IS THE POINT (B9, 2026-08-25)
// ---------------------------------------------------------------------------
// All seven routes behind these two guards are read-only, and until now that
// looked like a reason to leave them alone. It is the opposite. The resolver's
// own doctrine already says why, in the sentence that put the shift on org
// READS: "leaving org reads open would leave the console populated on the
// shared desk, which is the whole exposure." An inspector console showing
// national case and pet detail — reached by a `fetch` from a municipal machine
// nobody signed out of — IS the exposure. A read that renders PII on an
// unattended screen at 3am is not made safe by writing nothing.
//
// The bare `auth.getUser()` this file used to open with could not apply it, and
// could not apply the maintenance kill-switch either. Both arrive by routing the
// identity step through the one liveness guard instead of re-deriving three of
// its four questions from a profile read.

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

// Per-operator aggregate cap on the inspector fan-out (mirrors panorama MED-2).
// Generous — clips a burst-abuse pattern, never a real operator browsing a
// queue. Keyed on profile id so it bounds a single account (or a stolen
// session) regardless of source IP.
const GOB_API_MAX_PER_MINUTE = 120;

export type GobApiActor = {
  profile: CachedProfile;
  role: GobReadRole;
  // Empty for admin and national (universal read scope); populated for govt
  // with active tuples.
  jurisdictions: CachedJurisdiction[];
};

export type GobApiGuardResult =
  | { ok: true; actor: GobApiActor }
  | { ok: false; response: NextResponse };

/**
 * Resolve the caller as an ACTIVE INSTITUTIONAL admin/govt, or return the
 * NextResponse to send (401/403/429). Callers do:
 *
 *   const auth = await resolveInstitutionalGobActor();
 *   if (!auth.ok) return auth.response;
 *   const { role, jurisdictions } = auth.actor;
 */
export async function resolveInstitutionalGobActor(): Promise<GobApiGuardResult> {
  // Maintenance, session, erasure, deactivation and the 8-hour shift, in that
  // order. The profile it hands back is the same request-memoized read this
  // guard used to make on its own, so the liveness set costs nothing extra.
  const live = await requireLiveUser();
  if (!live.ok) return { ok: false, response: liveUserApiResponse(live.reason) };

  // Mid-signup: auth.users exists, the profile row does not yet. Not an
  // operator, and 401 rather than 403 because there is no resolved principal
  // to forbid anything to.
  const profile = live.profile;
  if (!profile) {
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }

  // Role + account type — the two questions liveness does not answer. Erasure
  // and deactivation are NOT re-checked here: requireLiveUser refused both
  // above, and a second copy of a check is a second thing to drift.
  //
  // These routes are READ-ONLY, so the read-only `national` role is admitted
  // alongside admin | govt — the same set requireGobReadAccessOrRedirect admits
  // for the pages that call these routes.
  if (!isGobReadRole(profile.role) || profile.accountType !== "institutional") {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }

  // Aggregate per-operator request cap. Applied AFTER auth resolves so only
  // authenticated institutional actors are counted, keyed on profile id.
  try {
    await enforceRateLimit("gob_api", profile.id, { maxPerMinute: GOB_API_MAX_PER_MINUTE });
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
