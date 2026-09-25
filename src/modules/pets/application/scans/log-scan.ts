// Use-case: logScan — record a credential_scanned event (strangler migration 58/61).
//
// Records a credential_scanned event whenever the public credential page is
// viewed. Called from a tiny client component on the page (via useEffect) so
// the page render itself stays a pure read.
//
// SCAN-LOCATION PRIVACY CONTRACT (Task #45, PO decision obs #733 — see also
// AGENTS.md §Privacidad → Scan events and lib/events/event-schemas.ts):
//   - Every scanner-role scan carries `scan_ip_area`: a coarse, city-precision
//     area derived from platform geo headers (lib/infra/scan-geo.ts). The raw
//     IP is never read into the payload. Explicit null off-Vercel.
//   - Scanner-role rows are HARD-ANONYMIZED: recorded_by_user_id is always
//     NULL, even for authenticated non-owner viewers. Read paths that resolve
//     recorded_by_user_id → display name (e.g. the gov welfare timeline in
//     lib/analytics/govt-dashboards.ts) must never be able to identify a
//     scanner. `viewer_authenticated` keeps the boolean signal without the link.
//   - No device GPS (W8, PO 2026-09-24): this use-case does not accept a
//     client coordinate at all any more — `scan_coords` / `scan_accuracy_m`
//     stay in the credential_scanned schema ONLY so pre-existing events (from
//     before this change) keep validating; nothing here writes them again.
//     scan_ip_area (above) is the only location signal a scan ever carries.
//   - Self-scans (owner viewing their own pet) keep recorded_by_user_id (it is
//     the owner's own history) but carry NO location fields: owner-role rows
//     are exempt from the 90-day purge, and indefinitely-retained location
//     linked to an identity is exactly what this contract forbids.
//   - Retention: location fields live only on author_role='scanner' rows,
//     which lib/infra/scan-retention.ts purges wholesale after 90 days.

import { headers } from "next/headers";

import { db, ownerships, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { notifyOwnerOfFirstStrangerScan } from "@/lib/infra/notify-owner-of-first-stranger-scan";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { ipAreaFromHeaders } from "@/lib/infra/scan-geo";
import { createClient } from "@/lib/supabase/server";
import { and, eq, isNull } from "drizzle-orm";

// WAVE D4 — abuse controls for the anonymous credential_scanned write.
//
// credential_scanned is an unauthenticated, append-only public write. Without a
// limit any client can call the server action in a loop and forge an unbounded
// number of scans, inflating a pet's public scan count. Two per-(token, IP)
// controls sit in front of the insert:
//
//   1. SCAN_LOG_LIMIT — a hard abuse cap. Generous enough that a handful of
//      legitimate refreshes always passes; tight enough that trivial inflation
//      is bounded.
//   2. Dedupe (maxPerMinute: 1) — collapses the same person's page re-renders
//      in a given minute into a single counted scan. Unconditional since W8
//      (PO, 2026-09-24): there is no longer a distinct GPS-follow-up scan to
//      exempt from it (this use-case accepts no client coordinate at all).
//
// Best-effort telemetry: on RateLimitError we DROP the scan silently; on any
// other (infra) error we fail open so a rate-limiter outage never loses a real
// scan.
const SCAN_LOG_ENDPOINT = "scan_log";
const SCAN_LOG_DEDUPE_ENDPOINT = "scan_log_dedupe";
const SCAN_LOG_LIMIT = { maxPerMinute: 10, maxPerHour: 60 } as const;

export async function logScan(publicToken: string): Promise<void> {
  if (!publicToken) return;

  // Resolve request headers once — reused for both rate limiting (trusted IP)
  // and the coarse IP-area floor (geo headers). callerIp reads x-real-ip / the
  // edge-appended x-forwarded-for hop; never a client-spoofable segment.
  const reqHeaders = await headers();
  const ip = callerIp(reqHeaders);

  // Abuse cap (WAVE D4) — enforced before any row is touched. Drop on throttle,
  // fail open on infra error.
  try {
    await enforceRateLimit(SCAN_LOG_ENDPOINT, `${publicToken}:${ip}`, SCAN_LOG_LIMIT);
  } catch (err) {
    if (err instanceof RateLimitError) return;
  }

  // ART. 16 (Ley 25.326) — a soft-deleted pet reads as NEVER REGISTERED to
  // civil surfaces. The public credential page already 404s for it, but this
  // use-case is reachable directly via the @no-auth-required logScanAction with
  // a token saved before deletion (an old QR). Without the isNull(deletedAt)
  // term the erased pet's row still returns here, so the scan would be logged
  // AND notifyOwnerOfFirstStrangerScan would fire at a surviving co-owner (the
  // erasure RPC soft-deletes the pet but never ends ownership rows) — telling a
  // live person about scan activity on a pet civil surfaces call never-existed.
  // Filtering deleted_at makes `if (!pet) return;` short-circuit the erased pet.
  const [pet] = await db
    .select({ id: pets.id, name: pets.name })
    .from(pets)
    .where(and(eq(pets.publicToken, publicToken), isNull(pets.deletedAt)))
    .limit(1);
  if (!pet) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Is the viewer the pet's current owner? Used to flag self-scans so the UI
  // can hide them from the default timeline.
  let isSelfScan = false;
  if (user) {
    const [ownership] = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, pet.id),
          eq(ownerships.ownerUserId, user.id),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    isSelfScan = !!ownership;
  }

  // Short-window dedupe (WAVE D4): a scan from the same (token, IP) within the
  // same minute is almost always the same person re-rendering — count it
  // once. Unconditional since W8 (no more GPS-follow-up exemption to make).
  try {
    await enforceRateLimit(SCAN_LOG_DEDUPE_ENDPOINT, `${publicToken}:${ip}`, {
      maxPerMinute: 1,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return;
  }

  const payload: Record<string, unknown> = {
    is_self_scan: isSelfScan,
    viewer_authenticated: !!user,
  };

  if (!isSelfScan) {
    // Guaranteed floor: coarse IP-area on every external scan (null when the
    // platform geo headers are absent, e.g. local dev). Never the raw IP.
    // The only location signal a scan carries — no device GPS (W8).
    payload.scan_ip_area = ipAreaFromHeaders(reqHeaders);
  }

  const now = new Date();
  const eventPayload = validateEventPayload("credential_scanned", payload);
  await db.insert(petEvents).values({
    petId: pet.id,
    eventType: "credential_scanned",
    occurredAt: now,
    recordedAt: now,
    // Scanner-role rows are hard-anonymized: no user id, no identity link.
    // Self-scans keep the owner's id — it is the owner's own history.
    recordedByUserId: isSelfScan ? (user?.id ?? null) : null,
    authorRole: isSelfScan ? "owner" : "scanner",
    payload: eventPayload,
  });

  // Owner-onboarding train: the first time an actual stranger scans this
  // pet's credential, tell the owner "así funciona el QR" — never for a
  // self-scan (the owner already knows what they're looking at). Idempotent
  // per (pet, owner) via a stable dedupeKey inside the notifier — see its
  // docblock for why this can safely run on EVERY external scan, not just
  // provably-the-first one. No relatedEventId (the insert above doesn't
  // `.returning()` — keeping it a plain insert avoids reshaping the write
  // this function is named for); the notifier's dedupeKey doesn't need it.
  if (!isSelfScan) {
    await notifyOwnerOfFirstStrangerScan({
      petId: pet.id,
      petName: pet.name,
      petPublicToken: publicToken,
    });
  }
}
