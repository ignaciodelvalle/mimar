// Four eyes on an approval — the one rule, shared by every decision writer.
//
// WHY THIS EXISTS (H3, top-10 review 2026-08-22)
// ---------------------------------------------------------------------------
// Creating an organization requires no role at all: any live user with a
// declared DNI can do it, and the creator becomes its admin. So a government
// officer could found a shelter in their own barrio, walk into their own
// approvals queue, and verify it themselves. `organizations.verified` is not a
// badge: it is the requirement for receiving decomisos, for being a rehome
// destination, and for appearing in the public directory. One human, end to
// end, with no external review.
//
// That this is an OVERSIGHT rather than a decision is provable from the repo
// itself: the identical control already exists in revoke-govt-locality.ts,
// whose comment calls it "Self-revocation footgun". Nothing here is a new idea;
// it is the same idea, applied where it was forgotten.
//
// THREE IDENTITIES, NOT ONE
// `approval_requests` carries three people, and any of them being the decider
// collapses the four eyes into two:
//   · applicantUserId    — whose request it is (the org's own verification
//                          request has the founder as applicant);
//   · targetUserId       — who receives the privilege (an authority-initiated
//                          upgrade names a target who never applied);
//   · initiatedByUserId  — who proposed it, when an authority filed on somebody
//                          else's behalf.
//
// WHAT THE SKEPTICS TOOK OFF THE TABLE, and why the rule still stands:
//   · "propose + approve a vet upgrade is an escalation" — it is NOT. A govt
//     can already approve any vet upgrade in their jurisdiction unilaterally;
//     the propose→approve chain saves the beneficiary a form, it grants no new
//     power. The rule still applies, because the value of four eyes is that the
//     record shows two people, not that the second one was strictly necessary.
//   · "a govt can self-approve their own vet upgrade" — that one is
//     counterproductive, not an escalation: it overwrites their own role with
//     `vet` and they LOSE their authority. Refusing it is still right, and now
//     it fails with a sentence instead of with a demotion.
//
// ORDER MATTERS. The callers run this AFTER their scope check, deliberately: an
// out-of-scope authority must keep receiving the jurisdiction refusal, which is
// the accurate one, rather than being told the request happens to be their own.
//
// NOT IN SCOPE — the solo-vet clinic auto-verification at org creation
// (upgrade/create-organization.ts, decision D1). That path verifies with
// `verifiedByUserId: null` on purpose: it is a system decision keyed on the
// creator's already-verified matrícula, not a person approving themselves.
// There is no decider to compare, and adding one would break a sanctioned flow.

/** The three identities on an approval request that must never be the decider. */
export type ApprovalParties = {
  applicantUserId: string | null;
  targetUserId: string | null;
  initiatedByUserId: string | null;
};

export type TwoPersonCheck = { ok: true } | { ok: false; error: string };

export const TWO_PERSON_REFUSAL =
  "No podés decidir una solicitud en la que sos parte. La tiene que resolver otra persona con autoridad en la jurisdicción.";

export const TWO_PERSON_ORG_REFUSAL =
  "No podés verificar una organización que creaste vos. La tiene que verificar otra persona.";

/** True when the actor is any of the request's three parties. */
export function isPartyToRequest(actorUserId: string, parties: ApprovalParties): boolean {
  return (
    parties.applicantUserId === actorUserId ||
    parties.targetUserId === actorUserId ||
    parties.initiatedByUserId === actorUserId
  );
}

/**
 * The guard every approval-decision writer runs after its scope check and
 * before it opens a transaction.
 *
 * A null party is never the actor: the actor always has an id, and the FKs are
 * `ON DELETE SET NULL` (migration 0080), so a null means "this person's profile
 * is gone", not "this person is you".
 */
export function assertTwoPersonRule(actorUserId: string, parties: ApprovalParties): TwoPersonCheck {
  return isPartyToRequest(actorUserId, parties)
    ? { ok: false, error: TWO_PERSON_REFUSAL }
    : { ok: true };
}

/**
 * The direct-verification mirror the finding missed. `verify-org.ts` sets
 * `verified = true` without ever comparing the actor against the organization's
 * creator, so a fix confined to the three approval-decision writers would leave
 * that door open — same outcome, different route.
 */
export function assertNotOwnOrganization(
  actorUserId: string,
  createdByUserId: string | null,
): TwoPersonCheck {
  return createdByUserId !== null && createdByUserId === actorUserId
    ? { ok: false, error: TWO_PERSON_ORG_REFUSAL }
    : { ok: true };
}
