// Plain input/context shapes for the transfers domain layer.
// Zero external imports — this file must not pull in Drizzle, Next.js, or @/db.

// ---------------------------------------------------------------------------
// Owner-to-owner transfer
// ---------------------------------------------------------------------------

export const OWNER_TRANSFER_REASONS = ["sale", "gift", "inheritance", "other"] as const;
export type OwnerTransferReason = (typeof OWNER_TRANSFER_REASONS)[number];

export const TRANSFER_EXPIRY_DAYS = 7;

export type InitiateOwnerTransferInput = {
  petToken: string;
  toEmail: string;
  reason: string;
  note?: string | null;
};

export type PetStatusSnapshot = {
  status: string;
  inCustodyDispute: boolean;
};

// ---------------------------------------------------------------------------
// Cross-org transfer
// ---------------------------------------------------------------------------

export const CROSS_ORG_ALLOWED_REASONS = new Set([
  "space_constraint",
  "specialization_needed",
  "network_redistribution",
  "shelter_closing",
  "post_adoption_failed_return",
  "other",
]);

export const CROSS_ORG_EXPIRY_DAYS = 30;

export type ProposeCrossOrgInput = {
  senderOrgToken: string;
  petPublicToken: string;
  receiverOrgId: string;
  reason: string;
  notes?: string | null;
};

export type CrossOrgCaseSnapshot = {
  id: string;
  openedByOrganizationId: string | null;
  receiverOrganizationId: string | null;
};

export type ProposalEventPayload = {
  from_organization_id?: string;
  to_organization_id?: string;
  reason?: string;
};

// ---------------------------------------------------------------------------
// Direct org-to-org handoff (custody.transfer)
// ---------------------------------------------------------------------------

export const TRANSFERABLE_SOURCE_ROLES = ["shelter_custody", "owner"] as const;
export type TransferableRole = (typeof TRANSFERABLE_SOURCE_ROLES)[number];

export type TransferCustodyInput = {
  destinationOrgId: string;
  newRoleRaw: string;
  notes?: string | null;
};

// ---------------------------------------------------------------------------
// Shared domain result
// ---------------------------------------------------------------------------

export type DomainResult<T = void> = { ok: true; value: T } | { ok: false; error: string };
