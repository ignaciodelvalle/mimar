// The ONE way a `/api/v1` handler answers (RN-1 G1-G3, 2026-08-22).
//
// WHY A SHARED HELPER AND NOT A PRIVATE ONE PER ROUTE
// ---------------------------------------------------------------------------
// The first endpoint funnelled its four status codes through a file-local
// `credentialJson()` so that no branch could forget `cache-control: no-store`.
// That is the right shape for ONE file and exactly nothing for the second: the
// next route would have to know to copy the helper, and the one that did not
// would be the one that reopened the stale "SE BUSCA + owner phone" class
// closed on 2026-07-07 (api-invariants.md §4 — `no-store` is NOT inherited;
// middleware stamps it from a path-prefix allowlist `/api/` is not on).
//
// So the discipline moves out of the file and into a module every `/api/v1`
// route MUST use — enforced by scripts/check-api-v1-envelope.ts
// (`pnpm lint:api-v1`), which refuses any v1 route that builds a response by
// hand (`NextResponse.json(`, `new NextResponse(`, `new Response(`,
// `Response.json(`) or does not import these helpers.
//
// WHAT EACH ONE GUARANTEES
//   apiV1Json     — `cache-control: no-store` (unoverridable) and
//                   `content-type: application/json; charset=utf-8` on EVERY
//                   response. The charset is spelled out so a native JSON
//                   parser never guesses the encoding of "María" or "Ushuaia".
//   apiV1Error    — the single-key `{ error }` envelope (§2), typed against the
//                   contract package's vocabulary (§3) so a route cannot invent
//                   a code a client cannot import.
//   apiV1Envelope — `payloadVersion` / `issuedAt` / `staleAfter` (§6), the
//                   three fields every READ carries, success or degraded.
//
// WHAT THIS IS NOT. It is not a framework: no wrapping of handlers, no
// middleware, no implicit rate limiting. A route still names its own bucket as
// a literal at its own call site (the throttle coverage fence requires it) and
// still decides its own status codes. These are three small functions whose
// whole value is that the fence can see whether a route used them.

import type { ApiV1Error, ApiV1ErrorCode } from "@dim/contract/api";
import { NextResponse } from "next/server";

/** Headers no `/api/v1` response may be without, and no caller may override. */
const MANDATORY_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

export type ApiV1JsonInit = {
  status: number;
  /** Extra headers (`retry-after`, …). The mandatory two win on conflict. */
  headers?: HeadersInit;
};

/**
 * A JSON response with the mandatory `/api/v1` headers.
 *
 * Built on `NextResponse.json` so the body is serialised exactly as every other
 * handler's, then the two mandatory headers are set LAST — after the caller's
 * — so nothing a route passes can opt a `/api/v1` response back into a CDN.
 */
export function apiV1Json(body: unknown, init: ApiV1JsonInit): NextResponse {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(MANDATORY_HEADERS)) headers.set(name, value);
  return NextResponse.json(body, { status: init.status, headers });
}

/**
 * The error envelope: one key, always `error`, from the agreed vocabulary.
 *
 * `extraHeaders` exists for the 503's `retry-after`. It is NOT for a 429:
 * api-invariants.md §10 records why the two rate-limit branches carry none —
 * only one of them could set an honest value, and the pair must stay
 * byte-identical so the response never says which budget ran out.
 */
export function apiV1Error(
  code: ApiV1ErrorCode,
  status: number,
  extraHeaders?: HeadersInit,
): NextResponse {
  const body: ApiV1Error = { error: code };
  return apiV1Json(body, { status, headers: extraHeaders });
}

export type ApiV1EnvelopeInput<V extends number> = {
  /** The payload's schema version, from the contract package. */
  payloadVersion: V;
  /** The instant the snapshot was taken. Defaults to now. */
  issuedAt?: Date;
  /** How long the snapshot may be presented as current — a policy constant from the contract package. */
  staleAfterMs: number;
};

export type ApiV1Envelope<V extends number = number> = {
  payloadVersion: V;
  issuedAt: string;
  staleAfter: string;
};

/**
 * The three envelope fields §6 requires on every read, success or degraded.
 *
 * `staleAfter` is NOT a cache-control directive — the response is `no-store`
 * regardless. It is what a client shows the user next to "esto es lo que el
 * servidor sabía a las 14:32", because a native client holding a copy has no
 * CDN to invalidate and needs an explicit expiry instead.
 *
 * Generic over the version LITERAL so a payload type that pins
 * `payloadVersion: typeof PUBLIC_CREDENTIAL_PAYLOAD_VERSION` still type-checks.
 */
export function apiV1Envelope<V extends number>({
  payloadVersion,
  issuedAt = new Date(),
  staleAfterMs,
}: ApiV1EnvelopeInput<V>): ApiV1Envelope<V> {
  return {
    payloadVersion,
    issuedAt: issuedAt.toISOString(),
    staleAfter: new Date(issuedAt.getTime() + staleAfterMs).toISOString(),
  };
}
