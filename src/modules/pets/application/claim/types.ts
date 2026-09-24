// Exported types for the claim use-cases.

/**
 * WHY a claim step refused, next to the es-AR sentence that says it in words.
 *
 * THE SENTENCE IS FOR A BROWSER; THE CODE IS FOR EVERYTHING ELSE. Both writers
 * below have always answered `{ error: string }` — Spanish prose written for the
 * claim wizard's own error paragraph — and that is api-invariants.md §3's
 * "untyped failure arm", the thing `/api/v1` routes cannot put on a wire. A
 * second door over the same use-case would otherwise have to MATCH THE PROSE to
 * pick a status code, and a copy edit would then silently turn a 409 into a 500.
 *
 * ADDITIVE, and the browser's behaviour is byte-identical: `ClaimWizard` reads
 * `result.error` and nothing else, so the field it does not know about changes no
 * pixel. What the REQUIRED (not optional) field buys is that a new refusal arm
 * cannot land without deciding which of these five it is — the compiler asks.
 *
 * Same instrument `AmendEventFailureCode` is, for the same reason and after the
 * same finding (WU-J review FI-7): before it, every refusal that use-case
 * produced was a 500 because prose was all there was to go on.
 *
 * - `rate_limited`      — the shared `claim_lookup` budget, spent by the lookup
 *                         and the claim TOGETHER so a burst of probes counts as
 *                         one. The web spends the same one.
 * - `identifier_invalid`— the value cannot resolve to anything: empty, or a
 *                         microchip that is not exactly fifteen digits. Refused
 *                         before any budget is spent and before any transaction.
 * - `not_found`         — the identifier resolved to no active row. Intended to
 *                         be indistinguishable from an erased pet (art. 16),
 *                         and TRUE OF THE LOOKUP ONLY — see the note below.
 * - `not_claimable`     — the animal exists and is not free: deceased, lost, in
 *                         an open custody dispute, or already held by somebody
 *                         under a custody of ANY role.
 * - `failed`            — the transaction itself failed. Nothing is half written.
 *
 * THE ART. 16 CLAIM ABOVE HOLDS FOR `lookupForClaimForUser` AND NOT FOR
 * `submitFreeClaimForUser`. Recorded here, in the file that makes the claim,
 * rather than only on the board — a promise and the note that it is half kept
 * have to travel together or the promise is the only half anyone reads.
 *
 * `lookup-for-claim.ts` resolves the animal with
 * `innerJoin(pets, and(eq(pets.id, petIdentifications.petId), isNull(pets.deletedAt)))`,
 * so an erased pet answers `not_found` exactly like a chip that was never
 * registered. `submit-free-claim.ts` resolves the SAME identifier and then
 * selects the pet with a bare `eq(pets.id, ident.petId)` — no `deletedAt`
 * filter — because `pet_identifications` rows stay `status = 'active'` after an
 * erasure. Measured 2026-08-30 against real Postgres: an erased pet's chip
 * answers `not_claimable` (409) where an unregistered chip answers `not_found`
 * (404), so a self-registered account can tell "erased" from "never existed" off
 * the status line; and if that erased pet has no active custody the claim
 * SUCCEEDS — it returns the animal's name and token, writes the ownership,
 * appends `ownership_claimed` to the spine, notifies and audits, while the
 * lookup on the same door still says the animal is not there.
 *
 * The hole is PRE-EXISTING and the web's own wizard has it identically: this is
 * one guard missing from a shared writer, not something the bearer door
 * introduced. It is written down instead of patched because the fix changes
 * behaviour for the browser too and belongs with a test, and because no fence
 * goes red for it — it is an ABSENCE, not a mutable predicate, which is the
 * category this repo has been bitten by before. Owner and the shape of the fix
 * are on the board under "Declared debts".
 */
export const CLAIM_FAILURE_CODES = [
  "rate_limited",
  "identifier_invalid",
  "not_found",
  "not_claimable",
  "failed",
] as const;

export type ClaimFailureCode = (typeof CLAIM_FAILURE_CODES)[number];

/** A refusal, in words for a browser and in a code for everybody else. */
export type ClaimRefusal = { error: string; code: ClaimFailureCode };

export type ClaimLookupVariant =
  | { variant: "not_found" }
  | { variant: "active_owner"; petToken: string; petName: string; ownerInitials: string | null }
  | { variant: "lost"; petToken: string; petName: string }
  | { variant: "deceased"; petName: string }
  | { variant: "free"; petToken: string; petName: string };

export type ClaimLookupResult = ClaimLookupVariant | ClaimRefusal;

// The dispute is authorized by the PRIVATE identifier, never by a pet token.
// A public token is not evidence: /perdidas lists every lost animal with a link
// to /p/{token} and no login, so tokens harvest in bulk, while /p/[publicToken]
// deliberately renders "Microchip: Sí/No" and never the number. Carrying the
// identifier here mirrors submitFreeClaimForUser, the sibling step of the SAME
// wizard, which already resolves its pet from the identifier and calls that
// "the evidence". The dispute step was the outlier.
export type ClaimDisputeInput = {
  identifierKind: "microchip" | "tattoo";
  identifierValue: string;
  reason: string;
};

// `petToken` is the token RESOLVED from the identifier server-side — callers
// revalidate with this, never with a caller-supplied value.
export type ClaimDisputeResult = { disputeToken: string; petToken: string } | { error: string };

export type FreeClaimResult = { petToken: string; petName: string } | ClaimRefusal;
