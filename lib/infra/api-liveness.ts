// One mapping from a liveness refusal to an HTTP answer, for the institutional
// route-handler guards.
//
// WHY IT IS SHARED WHEN THE TWO GUARDS ARE DELIBERATELY NOT
// ---------------------------------------------------------------------------
// `app/api/gob/_guard.ts` and `app/api/panorama/_guard.ts` are siblings on
// purpose and say so in their own headers: they are kept separate so the two API
// families rate-limit under distinct buckets ("gob_api" vs "panorama_api") and
// read as self-documenting call sites. That argument is about the BUCKETS. It
// says nothing about the status code a maintenance window deserves, and letting
// each guard answer that question for itself is how two surfaces end up
// disagreeing about what a shift-expired operator is told.
//
// So the buckets stay apart and this stays together.
//
// WHY A ROUTE HANDLER ANSWERS DIFFERENTLY FROM A PAGE
// ---------------------------------------------------------------------------
// A page guard REDIRECTS: /mantenimiento, /iniciar-sesion, and — for a shift
// that ran out — /turno-vencido, which signs the operator out (see that route's
// header: the session is still valid at GoTrue, so refusing without ending it
// rebuilds the 2026-07-04 redirect loop). An API route cannot redirect and must
// not try: its caller is a `fetch` from an already-rendered console, and a 302
// to an HTML page would be parsed as a failed JSON read.
//
// It answers with a CODE instead, and the code is the client's instruction:
//
//   session_shift_expired → 401. NOT auth_expired, and the distinction is the
//     whole reason the code exists. The token is still valid — the WORKDAY
//     ended — so a client that reads this as "refresh and retry" will refresh
//     successfully and be refused again, forever. This is the native form of
//     the same redirect loop the web paid for. `/api/v1` already speaks this
//     exact code (app/api/v1/me/revoke-sessions/route.ts and siblings), and the
//     mobile client already treats it as "end the session, never refresh"; the
//     operator API now says the same word for the same state.
//   maintenance → 503 with Retry-After. The kill-switch is an env read that
//     happens before any client or query, because the database may be the thing
//     under repair.
//   unauthorized (401) / forbidden (403) — unchanged from what both guards
//     already answered for a missing session, an erased account and a
//     deactivated one.

import { NextResponse } from "next/server";

import type { LiveUserFailureReason } from "@/lib/infra/live-user";

/** Seconds a client should wait before retrying a maintenance-window refusal. */
const MAINTENANCE_RETRY_AFTER_SECONDS = 30;

/**
 * The response an institutional API guard sends for a liveness refusal.
 *
 * EXHAUSTIVE over LiveUserFailureReason, with a `never` assignment in the
 * default arm: a sixth refusal added to the guard becomes a COMPILE error here
 * rather than a silent fall-through to some default status. That is the one
 * property this function has that a lookup object would not.
 */
export function liveUserApiResponse(reason: LiveUserFailureReason): NextResponse {
  switch (reason) {
    case "NO_SESSION":
    case "ACCOUNT_ERASED":
      // Erasure answers 401 and not 403 for the same reason the page flow
      // bounces it to /login rather than to an access-denied screen: the
      // account is gone (Ley 25.326 art. 16), so there is no identity left to
      // forbid something to.
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    case "DEACTIVATED":
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    case "SHIFT_EXPIRED":
      return NextResponse.json({ error: "session_shift_expired" }, { status: 401 });
    case "MAINTENANCE":
      return NextResponse.json(
        { error: "maintenance" },
        {
          status: 503,
          headers: { "Retry-After": String(MAINTENANCE_RETRY_AFTER_SECONDS) },
        },
      );
    default: {
      const unhandled: never = reason;
      throw new Error(`Unhandled liveness refusal: ${JSON.stringify(unhandled)}`);
    }
  }
}
