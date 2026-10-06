// A redirect that cannot leave the request's origin (notificaciones-destinos
// security review S1, 2026-10).
//
// Notification destinations are same-origin paths by construction, and this is
// the backstop that does not trust that: an unsafe path (a scheme, `//host`, a
// backslash, an ASCII control character) or one that RESOLVES to another origin
// against the request — `new URL("/\t/evil.com", base)` is `https://evil.com/` —
// lands on `fallback` instead, which is itself a constant same-origin path.

import { NextResponse } from "next/server";

import { isSafeInternalPath } from "@dim/contract/notifications";

/** `path` when it stays on `requestUrl`'s origin, `fallback` otherwise. */
export function sameOriginPath(requestUrl: string, path: string, fallback: string): string {
  if (!isSafeInternalPath(path)) return fallback;
  try {
    return new URL(path, requestUrl).origin === new URL(requestUrl).origin ? path : fallback;
  } catch {
    return fallback;
  }
}

export function sameOriginRedirect(request: Request, path: string, fallback: string): NextResponse {
  return NextResponse.redirect(new URL(sameOriginPath(request.url, path, fallback), request.url));
}
