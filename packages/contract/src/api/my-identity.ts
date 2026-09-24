// `POST /api/v1/me/identity` — signup step 2, answered by the server the app is
// already talking to instead of by a browser the app cannot hand its session to.
//
// WHY THIS ENDPOINT EXISTS (PO decision, 2026-09-05)
// ---------------------------------------------------------------------------
// A fresh native signup lands on `profilePending: true`, and until now the only
// door out of that state was the web: `identidad-pendiente` printed
// `IDENTITY_COMPLETION_URL` and asked the person to open a browser, SIGN IN
// AGAIN — the app holds a bearer token and the web resolves a cookie, so the
// browser opens signed out — and type their name there.
//
// Pilot testers read that second login as "confirm your email". The GoTrue log
// for one hour on 2026-09-05 carries 8 invalid-credential attempts and 2
// duplicate signups on that web step. The handoff was not a rough edge; it was
// the drop-off.
//
// WHAT MOVED, AND WHAT DID NOT
// ---------------------------------------------------------------------------
// The NAME moved. `completeIdentityInputSchema` (`@dim/contract/input`) is the
// whole request: `firstName` and `lastName`, nothing else.
//
// The DNI did not move with it, and as of 2026-09-07 it is not collected at
// signup on EITHER side: the web form dropped the field and the mobile screen
// dropped the browser link that led to it (PO decision — official identity waits
// for Mi Argentina). This paragraph used to say the link "still offers" that
// affordance; it does not. The reasoning that screen used to give for refusing a
// native form ENTIRELY — the hashing, the Ley 25.326 consent copy, the Mi
// Argentina federation path — was right about the DNI and overshot on the name.
// A name is not a claim about a national
// registry; it is the field `handle_new_user` guesses at from an email address
// and that every other surface renders the person as.
//
// THE RESPONSE IS THE FRESH `MeV1User`, AND THAT IS THE POINT OF THE SHAPE
// ---------------------------------------------------------------------------
// The obvious payload here is `{ saved: true }` — what `POST /api/v1/me/profile`
// answers, and what a write endpoint usually says. It is the wrong one, for a
// reason specific to this act: the caller's ENTIRE REASON for calling is that it
// is currently `profilePending: true`, and a `{ saved: true }` leaves the client
// holding a session state it now knows to be stale with no way to correct it
// except a second round trip to `/me`. Two calls, a window in between where the
// gate still refuses, and a redirect that fires only after the second lands.
//
// So the write returns the same union the shell read returns — `LoginV1.user` IS
// `MeV1User` for the same reason — and the client swaps its stored user for the
// one in the body. `profilePending: false` arrives in the response to the act
// that made it false.
//
// IT IS A BARE PAYLOAD, no `payloadVersion` / `issuedAt` / `staleAfter`: §2 of
// api-invariants.md reserves the envelope for READS, because a write is not a
// snapshot of anything. `MeV1User` inside it is the same type `MeV1` wraps, not
// a copy of it.

import type { MeV1User } from "./auth.ts";

/**
 * The answer to a completed identity.
 *
 * `user.profilePending` is `false` in every 200 this endpoint produces — the
 * write is refused rather than performed when the resulting display name would
 * still read as provisional (`identity_name_provisional`), so there is no
 * success arm in which this field can come back `true`. Stated because the type
 * is the shared union and therefore cannot say so structurally.
 */
export type IdentityCompletedV1 = { user: MeV1User };
