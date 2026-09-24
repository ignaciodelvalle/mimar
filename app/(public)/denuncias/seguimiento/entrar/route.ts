// Redemption endpoint for the emailed access link.
//
// WHY A ROUTE HANDLER AND NOT THE PAGE. A React Server Component cannot write
// cookies in Next 15, and the exchange has to happen server-side in one hop:
// verify the `access_link` token, mint a `session`, park it in an httpOnly
// cookie, and redirect to a URL that no longer carries the capability.
//
// THAT LAST PART IS THE POINT. The live token exists only in the inbox and in
// this single request. After the 303 the browser sits on a clean
// /denuncias/seguimiento — so the capability is not in the address bar to be
// screenshotted, not in browser history, not in a bookmark, and not in a
// `Referer` header on any outbound click. (The subtree also ships
// `Referrer-Policy: no-referrer` from next.config.ts, which covers THIS URL
// while it is briefly the referrer.)
//
// The token is single-use in practice, not by bookkeeping: it stays valid for
// its 30 minutes, but every redemption issues a fresh session and nothing is
// gained by replaying it. Persisting a used-token table would buy strict
// single-use at the cost of a migration and a reaper; the 30-minute TTL plus the
// httpOnly session was judged the better trade for a surface that mints nothing
// but a read.

import { reporterSessionCookie, validateReporterToken } from "@/lib/infra/denuncia-reporter-token";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// @no-auth-required: this endpoint IS the authentication step for the
// accountless reporter flow. The caller has no session yet — that is the point:
// it redeems the emailed capability token, and validateReporterToken() is the
// authorization check (a constant-time MAC over reportId + purpose + TTL). A
// session guard here would deny the exact request the route exists to serve.
// Forged-token replay is bounded by the IP rate limit below (10/min, 60/hour),
// and success and failure land on the same URL so the endpoint is not a MAC
// oracle.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const reportId = url.searchParams.get("r") ?? "";
  const token = url.searchParams.get("t") ?? "";

  // Caps offline-forged token replay attempts. A failure and a success are
  // indistinguishable to the caller (both land on /denuncias/seguimiento, which
  // renders the same "no access" screen when there is no valid session), so the
  // limit is the only thing standing between an attacker and a MAC oracle.
  try {
    await enforceRateLimit("denuncia_reporter_entrar", callerIp(request.headers), {
      maxPerMinute: 10,
      maxPerHour: 60,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.redirect(new URL("/denuncias/seguimiento", request.url), 303);
    }
    throw err;
  }

  const target = new URL("/denuncias/seguimiento", request.url);
  const response = NextResponse.redirect(target, 303);

  if (!validateReporterToken("access_link", reportId, token)) {
    // No cookie, no error detail, same destination. The seguimiento page will
    // explain that the link expired without confirming whether it was ever real.
    return response;
  }

  response.cookies.set(reporterSessionCookie(reportId));
  return response;
}
