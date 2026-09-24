// Shared cron request authentication helper.
//
// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` on every invocation.
// This helper accepts BOTH that header (primary contract) AND the legacy
// `x-cron-secret` header so existing manual ops / curl scripts keep working
// without changes.
//
// Security properties:
//   - Uses crypto.timingSafeEqual for the comparison (constant-time).
//   - Fails CLOSED in production when CRON_SECRET is unset.
//   - In non-production with no CRON_SECRET set: allows the request and logs
//     a warning (preserves existing dev-fallback behaviour).

import { timingSafeEqual } from "node:crypto";

/**
 * Returns `null` when the request is authorized, or an object with
 * `{ ok: false, error, status }` that the caller route can pass directly to
 * `NextResponse.json(authError, { status: authError.status })`.
 *
 * Accepted patterns (checked in order):
 *   1. `Authorization: Bearer <CRON_SECRET>`  — Vercel Cron contract
 *   2. `x-cron-secret: <CRON_SECRET>`         — legacy / curl scripts
 */
export function authorizeCronRequest(req: {
  headers: { get(name: string): string | null };
}): { ok: false; error: string; status: number } | null {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, error: "CRON_SECRET not configured in production", status: 401 };
    }
    // Non-production with no secret: warn and allow (dev-only fallback).
    console.warn("[cron-auth] CRON_SECRET not set — allowing request in non-production");
    return null;
  }

  // Check both accepted header formats.
  const bearerHeader = req.headers.get("authorization");
  const legacyHeader = req.headers.get("x-cron-secret");

  const bearerToken = bearerHeader?.startsWith("Bearer ")
    ? bearerHeader.slice("Bearer ".length)
    : null;

  const candidate = bearerToken ?? legacyHeader;

  if (!candidate) {
    return { ok: false, error: "Unauthorized", status: 401 };
  }

  // Constant-time comparison. Guard length first so timingSafeEqual doesn't
  // throw on mismatched buffer sizes — a length mismatch is already a failure.
  if (!safeEqual(candidate, cronSecret)) {
    return { ok: false, error: "Unauthorized", status: 401 };
  }

  return null;
}

function safeEqual(a: string, b: string): boolean {
  // Guard on BYTE length, not JS char length: timingSafeEqual throws on
  // mismatched buffer sizes, and a multibyte char (e.g. 'é' = 2 bytes) makes
  // a.length === b.length while the buffers differ — which would 500 the
  // route instead of returning 401. A length mismatch is already a failure.
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
