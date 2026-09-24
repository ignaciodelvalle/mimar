// The lookup's answer, as the wire carries it.
//
// ONE FUNCTION, AND ITS WHOLE JOB IS TO DROP THINGS. `ClaimLookupVariant` is a
// discriminated union where each arm carries only the fields that arm has; the
// wire shape is FLAT, because a native client switching on `variant` should not
// also have to narrow a union to find out whether `petName` exists. Flattening
// means deciding, for every arm, which fields become `null` — and that decision
// is a disclosure decision, which is why it lives in its own file with the
// reasons written next to it rather than inline in a handler.

import type { PetClaimLookupAckV1 } from "@dim/contract/api";

import type { ClaimLookupVariant } from "@/src/modules/pets/application/claim/types";

/**
 * Turn the use-case's variant into the flat ack.
 *
 * `canClaim` IS `variant === "free"` AND IT IS COMPUTED HERE ON PURPOSE.
 *
 * The temptation is to say "the client can do that itself" and drop the field.
 * The contract's own docblock argues why not, and the short version is that the
 * rule behind "free" is an authorization rule owned by
 * `submitFreeClaimForUser` — no active custody of ANY role, re-checked under
 * `SELECT … FOR UPDATE` inside the claiming transaction, plus three status
 * gates. A client deriving the affordance would be keeping a second copy of a
 * rule it cannot see, on the most consequential act on this surface.
 *
 * `petToken` TRAVELS ONLY FOR `lost`, and that is one step TIGHTER than the
 * web's own action, which hands a token back for `free` and `active_owner` too.
 * A token opens `/p/{token}`, so it goes only where this client has somewhere to
 * go — and the only such place is the avistaje form a lost animal routes to.
 * The `free` arm does not need it: the CLAIM's ack carries the token the writer
 * resolved, and that is the one to navigate with.
 *
 * `ownerInitials` is `deriveInitials`'s output verbatim — up to two initials,
 * or `null` when there is nobody to name. It is `null` in two different
 * situations and a client must not print a word over it: the animal may be held
 * by a refugio under `shelter_custody` with no owner row at all, in which case
 * the variant is still `active_owner` and there are no initials to show.
 *
 * NO CHIP AND NO TATTOO CODE COME BACK, on any arm. The caller supplied one and
 * echoing it would be free; `confirm-chip-match-vecino.ts` records what that
 * costs — an endpoint that returns the canonical code is a chip oracle, and this
 * one answers to any account that signed itself up.
 */
export function buildPetClaimLookupAck(variant: ClaimLookupVariant): PetClaimLookupAckV1 {
  switch (variant.variant) {
    case "not_found":
      return {
        command: "lookup",
        variant: "not_found",
        petName: null,
        petToken: null,
        ownerInitials: null,
        canClaim: false,
      };
    case "free":
      return {
        command: "lookup",
        variant: "free",
        petName: variant.petName,
        petToken: null,
        ownerInitials: null,
        canClaim: true,
      };
    case "lost":
      return {
        command: "lookup",
        variant: "lost",
        petName: variant.petName,
        petToken: variant.petToken,
        ownerInitials: null,
        canClaim: false,
      };
    case "deceased":
      return {
        command: "lookup",
        variant: "deceased",
        petName: variant.petName,
        petToken: null,
        ownerInitials: null,
        canClaim: false,
      };
    case "active_owner":
      return {
        command: "lookup",
        variant: "active_owner",
        petName: variant.petName,
        petToken: null,
        ownerInitials: variant.ownerInitials,
        canClaim: false,
      };
    default: {
      // A sixth variant added to the use-case reaches this line rather than
      // falling into a permissive default. `canClaim` has no safe guess.
      const unhandled: never = variant;
      throw new Error(`Unhandled claim lookup variant: ${JSON.stringify(unhandled)}`);
    }
  }
}
