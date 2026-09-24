// Domain types for the return-to-owner module.
// Pure value shapes — no DB, no framework, no external imports.

export type ProposeReturnResult = { ok: true; eventId: string } | { error: string };

export type OwnerProposeReturnToOrgResult = { ok: true; eventId: string } | { error: string };

export type AcceptReturnResult =
  | { ok: true }
  | { ok: true; autoCancelled: true; reason: string }
  | { error: string };

export type RejectReturnResult = { ok: true } | { error: string };

export type CancelProposalResult = { ok: true } | { error: string };

export type OrgAcceptOwnerReturnResult = { ok: true } | { error: string };

export type OrgRejectOwnerReturnResult = { ok: true } | { error: string };
