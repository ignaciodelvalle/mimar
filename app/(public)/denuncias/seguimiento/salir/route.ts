// User-side revocation for the accountless reporter session.
//
// WHY A ROUTE HANDLER AND NOT A SERVER ACTION. It was a server action first, and
// `pnpm lint:actions` (contract N3) was right to reject it: a `redirect()` inside
// a Server Action resolves and is then dropped by the client router — the cookie
// would be deleted and the browser would sit on a page still showing the
// denuncia. On a logout that is not a cosmetic bug, it is the failure mode the
// button exists to prevent.
//
// POST, not GET, and reached from a native <form method="post">. A GET logout is
// reachable by any prefetch — Next's <Link>, a browser, an extension — and would
// silently end sessions nobody asked to end. The native form also means the
// button still works with JS disabled, which matters on the low-end devices this
// flow is actually used from.
//
// Deleting the cookie is the whole operation: the session is stateless, so there
// is nothing else to tear down. The reporter is very often on a shared or
// borrowed device — a locutorio, a relative's phone, the counter at a shelter —
// and the 60-minute TTL is a floor, not a substitute for being able to leave.

import { reporterSessionCookie } from "@/lib/infra/denuncia-reporter-token";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// @no-auth-required: stateless log-out. The whole operation is deleting the
// reporter's own httpOnly cookie and redirecting; it reads nothing, writes
// nothing server-side, and reveals nothing. Requiring a valid session to leave
// would strand exactly the caller who most needs to — someone on a shared
// device whose cookie is already expired or malformed.
//
// The worst case is NOT "a cookie the caller already controls" — that reading
// assumed the caller is the cookie's owner, and this endpoint has no CSRF
// token, so it isn't necessarily. A cross-site page can auto-submit this POST
// and delete the VICTIM's reporter cookie. What that costs the victim is one
// forced logout of an accountless, freely re-obtainable session: they re-enter
// the tracking code from the denuncia receipt and continue. Nothing is read,
// nothing is written server-side, no state is destroyed — the session is
// stateless, so the cookie IS the session and a new one costs a form submit.
// Accepted at that price, because gating it trades a nuisance for stranding
// the shared-device caller this button exists for.
export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/denuncias/buscar", request.url), 303);
  // reporterSessionCookie(null) is the deletion form, built from the SAME
  // descriptor the writers use. A cookie deleted under a different `path` than it
  // was written under silently deletes nothing, and "Salir" would be a lie.
  response.cookies.set(reporterSessionCookie(null));
  return response;
}
