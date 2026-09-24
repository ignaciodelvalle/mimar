// The public credential read — the one endpoint this app calls with no bearer.
//
// It is a thin layer over `api/client.ts`, and the thinness is the point: the
// transport, the timeout, the separate-try-blocks discipline, the closed error
// vocabulary and the es-AR copy all live there, once, shared with every
// authenticated call. What is genuinely SPECIFIC to this endpoint is one thing,
// and it is why the file still exists:
//
//   A 503 HERE CARRIES A READABLE BODY. The contract calls answering 404 to a
//   read failure "the worst lie a public surface can tell", and the client half
//   of that promise is this: a 503 is NOT folded into the not-found arm, and its
//   body is KEPT, because the degraded envelope still carries the animal's name
//   and the lost-report CTAs. Every other endpoint's 503 is a bare `{ error }`
//   and the generic layer is right to treat it as one.
//
// RATE LIMITS ARE A DESIGN INPUT, NOT AN ERROR TO RETRY. The endpoint runs two
// limiters: 20/min per (token, IP) and 600/min per IP across the surface. This
// module performs exactly one request per call, with NO retry, NO backoff loop
// and no polling timer anywhere in this app. A `setInterval` here would spend a
// shared budget that, on a lost pet, real finders in the street are also
// spending.

import {
  PUBLIC_CREDENTIAL_PAYLOAD_VERSION,
  type PublicCredentialV1,
  type PublicCredentialV1Degraded,
} from "@dim/contract/api";

import { type ApiResult, apiFailureMessage, performRequest } from "../api/client";
import { apiV1ErrorCode } from "../api/error-copy";

/**
 * Everything `apiRequest` can answer, plus the degraded arm.
 *
 * Written as a union WITH `ApiResult` rather than as a hand-copied list of arms:
 * an outcome added to the shared result type arrives here automatically, and
 * `fetchFailureMessage` stops compiling until it is handled. A copied list would
 * silently stay one arm short.
 */
export type CredentialFetchResult =
  | { outcome: "degraded"; payload: PublicCredentialV1Degraded }
  | ApiResult<PublicCredentialV1>;

/** `GET /api/v1/pets/{token}/credential`. One request, no retry. */
export async function fetchCredential(publicToken: string): Promise<CredentialFetchResult> {
  const raw = await performRequest({
    path: `/api/v1/pets/${encodeURIComponent(publicToken)}/credential`,
  });

  if (raw.transport === "unreachable") return { outcome: "unreachable", detail: raw.detail };
  if (raw.transport === "malformed") return { outcome: "malformed", detail: raw.detail };

  // Checked BEFORE the generic error arm precisely because its body is not a
  // bare `{ error }`.
  if (raw.status === 503) {
    const degraded = raw.body as PublicCredentialV1Degraded;
    if (degraded?.payloadVersion === PUBLIC_CREDENTIAL_PAYLOAD_VERSION) {
      return { outcome: "degraded", payload: degraded };
    }
    return {
      outcome: "api-error",
      code: "temporarily_unavailable",
      retryAfterSeconds: raw.retryAfterSeconds,
    };
  }

  if (raw.status < 200 || raw.status >= 300) {
    // An unrecognised code is a contract violation, not something to display
    // raw. Anything unexpected reads as a failed read, never as 404.
    return {
      outcome: "api-error",
      code: apiV1ErrorCode(raw.body) ?? "temporarily_unavailable",
      retryAfterSeconds: raw.retryAfterSeconds,
    };
  }

  const payload = raw.body as PublicCredentialV1;
  if (payload?.payloadVersion !== PUBLIC_CREDENTIAL_PAYLOAD_VERSION) {
    // An old build should say "actualizá la app", not render half a credential
    // from a shape it is guessing at.
    const received = typeof payload?.payloadVersion === "number" ? payload.payloadVersion : null;
    return { outcome: "unsupported-version", received };
  }

  return { outcome: "ok", payload };
}

/**
 * es-AR copy for each failure. `null` only for the two arms that are not one.
 *
 * The degraded arm returns `null` because it is NOT a failure: the screen
 * renders what survived, with its own "lectura degradada" explanation. Every
 * other arm is delegated to the shared message function, so there is still
 * exactly one copy of the error vocabulary in this app.
 */
export function fetchFailureMessage(result: CredentialFetchResult): string | null {
  if (result.outcome === "degraded") return null;
  return apiFailureMessage(result);
}
