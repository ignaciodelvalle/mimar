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
//   - Precise GPS (`scan_coords` + `scan_accuracy_m`) is stored ONLY when the
//     pet is currently lost AND the caller passed coords, which the client
//     collects exclusively through an explicit browser-geolocation grant with
//     visible consent copy (ScanLogger.tsx). The lost check happens HERE so a
//     forged client call cannot attach coords to a non-lost pet.
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
//   1. SCAN_LOG_LIMIT — a hard abuse cap. Generous enough that the legitimate
//      lost-pet flow (base scan + one GPS follow-up) plus a handful of refreshes
//      always passes; tight enough that trivial inflation is bounded.
//   2. Dedupe (maxPerMinute: 1) — collapses the same person's page re-renders in
//      a given minute into a single counted scan. The lost-pet GPS follow-up is
//      the one event exempt from dedupe (it is a distinct, just-granted fix).
//
// Best-effort telemetry: on RateLimitError we DROP the scan silently; on any
// other (infra) error we fail open so a rate-limiter outage never loses a real
// scan.
const SCAN_LOG_ENDPOINT = "scan_log";
const SCAN_LOG_DEDUPE_ENDPOINT = "scan_log_dedupe";
const SCAN_LOG_LIMIT = { maxPerMinute: 10, maxPerHour: 60 } as const;

/** GPS fix passed by the client after an explicit geolocation grant. */
export type ScanCoords = {
  lat: number;
  lng: number;
  /** GeolocationCoordinates.accuracy, meters. */
  accuracyM?: number;
};

/**
 * Server-side coords validation — never trust the client. Returns null (drop
 * coords, still log the scan) on any out-of-range or non-finite value.
 */
function sanitizeCoords(
  coords: ScanCoords | undefined,
): { lat: number; lng: number; accuracyM: number | null } | null {
  if (!coords) return null;
  const { lat, lng, accuracyM } = coords;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  const accuracy =
    typeof accuracyM === "number" && Number.isFinite(accuracyM) && accuracyM >= 0
      ? Math.min(Math.round(accuracyM), 1_000_000)
      : null;
  return { lat, lng, accuracyM: accuracy };
}

export async function logScan(publicToken: string, opts?: { coords?: ScanCoords }): Promise<void> {
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
    .select({ id: pets.id, status: pets.status, name: pets.name })
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

  // Precise GPS is stored ONLY for a lost pet, never on self-scans, and only
  // when the client passed a valid fix (server-side re-validation). Computing it
  // here also determines whether this scan is exempt from dedupe below.
  const storedCoords = !isSelfScan && pet.status === "lost" ? sanitizeCoords(opts?.coords) : null;

  // Short-window dedupe (WAVE D4): a base scan (no stored GPS) from the same
  // (token, IP) within the same minute is almost always the same person
  // re-rendering — count it once. The GPS follow-up on a lost pet is the sole
  // exemption: it is a distinct, just-granted fix that must always record.
  if (!storedCoords) {
    try {
      await enforceRateLimit(SCAN_LOG_DEDUPE_ENDPOINT, `${publicToken}:${ip}`, {
        maxPerMinute: 1,
      });
    } catch (err) {
      if (err instanceof RateLimitError) return;
    }
  }

  const payload: Record<string, unknown> = {
    is_self_scan: isSelfScan,
    viewer_authenticated: !!user,
  };

  if (!isSelfScan) {
    // Guaranteed floor: coarse IP-area on every external scan (null when the
    // platform geo headers are absent, e.g. local dev). Never the raw IP.
    payload.scan_ip_area = ipAreaFromHeaders(reqHeaders);

    if (storedCoords) {
      payload.scan_coords = { lat: storedCoords.lat, lng: storedCoords.lng };
      if (storedCoords.accuracyM !== null) payload.scan_accuracy_m = storedCoords.accuracyM;
    }
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
