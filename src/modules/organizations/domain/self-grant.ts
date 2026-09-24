// Nobody hands themselves a permission — the one rule, shared by both writers.
//
// WHY THIS EXISTS (H2, top-10 review 2026-08-22)
// ---------------------------------------------------------------------------
// `capability.grant` exists to DELEGATE: a shelter coordinator clears the
// team's permission requests without having to be an admin. Neither
// `decideCapability` nor `grantCapability` compared the beneficiary against the
// actor, so that coordinator could ask for `custody.transfer` or
// `adoption.finalize` for themselves, open /org/{token}/admin/permisos, find
// their OWN request sitting there with a working Approve button, and take it —
// or skip the request and grant it to themselves directly. Including
// `capability.grant` itself, which turns one delegation into a permanent one.
//
// The part that makes it a defect rather than a missing hardening idea: THE
// CONTROL ALREADY EXISTED, on the wrong side of the trust boundary.
// CapabilityMatrix.tsx renders a dash titled "No podés concederte permisos a
// vos mismo" over the caller's own row, with a comment saying it is there to
// "block self-grant in empty cells". The browser refused; the server never
// asked. Three sibling use cases in this same module DO ask on the server
// ("No podés cambiar tu propio rol", "No podés quitarte a vos mismo").
//
// COMPARE THE PERSON, NOT THE SEAT
// The obvious implementation compares membership ids, and it is wrong. Leaving
// an organization and rejoining mints a NEW `organization_memberships` row, so
// one human can hold two memberships in the same org — and nothing stops an
// admin from creating a second seat for someone. Comparing seats lets that
// person approve their own request from their other seat, and the system would
// record it as four eyes. The identity that matters is `profiles.id`.
//
// A null beneficiary (a membership row whose user cannot be resolved) is NOT
// treated as self: the actor always has an id, so it cannot be them. The
// callers already skip the recipient notification in that case.

export const SELF_GRANT_REFUSAL =
  "No podés concederte permisos a vos mismo. Pedíselo a otro administrador de la organización.";

export type SelfGrantCheck = { ok: true } | { ok: false; error: string };

/** True when the beneficiary of a capability decision IS the actor. */
export function isSelfGrant(actorUserId: string, beneficiaryUserId: string | null): boolean {
  return beneficiaryUserId !== null && beneficiaryUserId === actorUserId;
}

/**
 * The guard both use cases run BEFORE they open their transaction — a refused
 * self-grant must leave no row, no status change and no audit entry describing
 * a decision that did not happen.
 */
export function assertNotSelfGrant(
  actorUserId: string,
  beneficiaryUserId: string | null,
): SelfGrantCheck {
  if (isSelfGrant(actorUserId, beneficiaryUserId)) {
    return { ok: false, error: SELF_GRANT_REFUSAL };
  }
  return { ok: true };
}
