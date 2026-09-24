// What a screen does when a RELOAD fails and it already has an answer on it.
//
// THE RULE, IN ONE SENTENCE
// ---------------------------------------------------------------------------
// Only the FIRST load may draw a full-screen error. Every read after that keeps
// the last good payload and reports the failure as a banner over it.
//
// WHAT IT COST NOT TO HAVE THIS (S-2, measured on a device 2026-09-06, shots
// 137-140). Airplane mode on, pull to refresh on "Mis mascotas": the two pets
// that were on screen and the "Registrar otra mascota" button were replaced by a
// full-screen "no pudimos conectarnos". Airplane mode off: the offline banner
// cleared in about nine seconds and the list STAYED empty until the person
// found the "Volver a intentar" button. Nine screens had this shape —
// notificaciones, turnos, transferencias, compartir, postulaciones, la lista de
// mascotas, el documento, la libreta y editar mi perfil — and on every one of
// them a failed refresh deleted data the phone was still holding.
//
// It is worst exactly where the app is most useful: a vet with one bar reading a
// libreta, somebody at a shelter with the pet list open. The data was fetched
// seconds ago and is still true; the network is what failed, and the network is
// not the subject of any of those screens.
//
// WHY A REDUCER AND NOT A HOOK
// ---------------------------------------------------------------------------
// The screens already own their `useState` and their `load()`; a hook would have
// to take both over to add one rule to one transition. This is that transition,
// as a pure function two call sites long — which is also what makes the rule
// testable without rendering nine screens.
//
// THE STALE FAILURE IS NOT AN ERROR STATE. `staleFailure` sits ON the ready arm:
// the payload is still rendered, still interactive, and the banner says why what
// is on screen may be old. A screen that hides its content behind the banner has
// re-implemented the bug with extra steps.
//
// "KEEP THE LAST GOOD PAYLOAD" IS NOT UNCONDITIONAL, AND THE FIRST VERSION OF
// THIS FILE MADE IT SO (lote 1b review, F3)
// ---------------------------------------------------------------------------
// The rule branched on the CURRENT state and never on WHY the read failed, so a
// 403 and a dead spot were the same event. A pet transferred away, a caretaker
// grant that ended, a share somebody revoked — every one of them came back as a
// refusal, and every one of them left the whole live credential on screen (chip,
// owner, QR, sections) under "Lo que ves es lo último que pudimos leer."
//
// That sentence is true of an outage and false of a revocation. An authorization
// change presented as a refresh hiccup, on the screen whose subject IS current
// custody, is the same class of lie the rule was written to stop — pointed the
// other way. So the payload survives only failures that are about the NETWORK or
// the SERVER, and any refusal about this reader's access to this thing empties
// the screen, which is the honest answer when access is what changed.

import type { ApiV1ErrorCode } from "@dim/contract/api";

import type { ApiResult } from "../api/client";

/**
 * The `/api/v1` codes that mean "the server could not answer right now".
 *
 * IT MIRRORS `client.ts`'s SPLIT RATHER THAN INVENTING A SECOND TAXONOMY.
 * `sessionEndingReason` there decides which refusals end a session; the same
 * reading applies here one level down — a refusal is ABOUT this reader and this
 * resource, an outage is about neither, and only the second may be reported as
 * "we could not refresh".
 */
const OUTAGE_CODES: ReadonlySet<ApiV1ErrorCode> = new Set<ApiV1ErrorCode>([
  "temporarily_unavailable",
  "rate_limited",
]);

/**
 * Is this failure about the connection or the server, rather than about the
 * reader's access to what is on screen?
 *
 * Exhaustive on `outcome`, with no `default`: a new outcome does not compile
 * until somebody decides which side of this line it falls on.
 */
export function isOutageShaped(result: ApiResult<unknown>): boolean {
  switch (result.outcome) {
    case "ok":
      return false;
    case "unreachable":
    case "malformed":
      return true;
    case "unsupported-version":
      // The server changed shape under an old build. Keeping stale content under
      // a banner invites somebody to go on using an app that can no longer read
      // this surface; "actualizá la app" is an instruction they must see.
      return false;
    case "api-error":
      return OUTAGE_CODES.has(result.code);
  }
}

/** The ready arm every reloadable screen shares. `T` is its payload. */
export type ReadyState<T> = {
  phase: "ready";
  view: T;
  /** `null` while the last read succeeded; the failure's sentence otherwise. */
  staleFailure: string | null;
};

/** A landed read. Clears any stale banner, because this one worked. */
export function loaded<T>(view: T): ReadyState<T> {
  return { phase: "ready", view, staleFailure: null };
}

/**
 * A read that did not land.
 *
 * TWO THINGS DECIDE, and the second one is the fix described in the header:
 *   · `current` — with nothing on screen there is nothing to keep, and the full
 *     error is the only thing the screen can honestly say.
 *   · `result` — with a payload on screen it survives an OUTAGE and not a
 *     REFUSAL. See `isOutageShaped`: "lo último que pudimos leer" over a 403 is
 *     a revocation dressed as a hiccup.
 *
 * `message` stays a separate parameter rather than being derived here: each
 * screen owns its own sentence per arm ("No pudimos leer tus notificaciones",
 * "No pudimos leer el modo perdida"), and folding that in would flatten nine
 * voices into one generic shrug.
 *
 * The generic keeps whatever else a screen's ready arm carries (SharesScreen's
 * revealed token, the document's face) instead of flattening it.
 */
export function reloadFailed<R extends { phase: "ready"; staleFailure: string | null }>(
  current: R | { phase: "loading" } | { phase: "failed"; message: string },
  result: ApiResult<unknown>,
  message: string,
): R | { phase: "failed"; message: string } {
  if (current.phase === "ready" && isOutageShaped(result)) {
    return { ...current, staleFailure: message };
  }
  return { phase: "failed", message };
}
