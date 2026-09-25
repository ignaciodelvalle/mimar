// The claim commands' answers, as the wire carries them.
//
// THE LOOKUP'S BUILDER'S WHOLE JOB IS TO DROP THINGS. `ClaimLookupVariant` is a
// discriminated union where each arm carries only the fields that arm has; the
// wire shape is FLAT, because a native client switching on `variant` should not
// also have to narrow a union to find out whether `petName` exists. Flattening
// means deciding, for every arm, which fields become `null` — and that decision
// is a disclosure decision, which is why it lives in its own file with the
// reasons written next to it rather than inline in a handler.

import type {
  PetClaimDisputeAckV1,
  PetClaimEvidenceTicketV1,
  PetClaimLookupAckV1,
} from "@dim/contract/api";

import type { ClaimLookupVariant } from "@/src/modules/pets/application/claim/types";

/**
 * The staging ticket, field for field — the denuncia's ticket shape, because it
 * is the same capability over the same bucket (`welfare-evidence-staging.ts`).
 */
export function buildPetClaimEvidenceTicketAck(ticket: {
  uploadUrl: string;
  token: string;
  stagedPath: string;
  bucket: string;
  validForSeconds: number;
}): PetClaimEvidenceTicketV1 {
  return {
    command: "request_evidence_ticket",
    uploadUrl: ticket.uploadUrl,
    token: ticket.token,
    stagedPath: ticket.stagedPath,
    bucket: ticket.bucket,
    validForSeconds: ticket.validForSeconds,
  };
}

/**
 * The dispute's receipt: the reference the web prints, and nothing else.
 *
 * TAKES ONLY THE TOKEN, so the resolved `petToken` the use-case also returns
 * (for the web's `revalidatePath`) cannot be widened onto the wire by a later
 * edit without changing a signature somebody has to look at.
 */
export function buildPetClaimDisputeAck(disputeToken: string): PetClaimDisputeAckV1 {
  return { command: "dispute", changed: true, disputeToken };
}

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
 * `canDispute` IS `variant === "active_owner"`, AND IS COMPUTED HERE FOR THE
 * SAME REASON. It is the web wizard's own rule — its variant-B panel is the only
 * one that offers "Iniciar disputa" — and the writer (`submitClaimDisputeForUser`)
 * re-resolves the animal and re-runs every refusal, so it is a hint and not the
 * gate. A client that drew the dispute form from its own reading of the variant
 * would be the second copy of a rule the paragraph above refuses to let it keep.
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
        canDispute: false,
      };
    case "free":
      return {
        command: "lookup",
        variant: "free",
        petName: variant.petName,
        petToken: null,
        ownerInitials: null,
        canClaim: true,
        canDispute: false,
      };
    case "lost":
      return {
        command: "lookup",
        variant: "lost",
        petName: variant.petName,
        petToken: variant.petToken,
        ownerInitials: null,
        canClaim: false,
        canDispute: false,
      };
    case "deceased":
      return {
        command: "lookup",
        variant: "deceased",
        petName: variant.petName,
        petToken: null,
        ownerInitials: null,
        canClaim: false,
        canDispute: false,
      };
    case "active_owner":
      return {
        command: "lookup",
        variant: "active_owner",
        petName: variant.petName,
        petToken: null,
        ownerInitials: variant.ownerInitials,
        canClaim: false,
        canDispute: true,
      };
    default: {
      // A sixth variant added to the use-case reaches this line rather than
      // falling into a permissive default. `canClaim` has no safe guess.
      const unhandled: never = variant;
      throw new Error(`Unhandled claim lookup variant: ${JSON.stringify(unhandled)}`);
    }
  }
}
