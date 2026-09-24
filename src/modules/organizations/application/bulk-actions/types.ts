export type BulkResult = {
  bulkActionId: string;
  succeeded: string[];
  failed: { id: string; reason: string }[];
};

export type BulkApproveInput = {
  requestPublicTokens: string[];
  decisionNotes?: string | null;
};

export type BulkRejectInput = {
  requestPublicTokens: string[];
  reason: string;
};

export type BulkRevokeKind = "vet" | "org" | "govt_assignment";

export type BulkRevokeInput = {
  targetIds: string[];
  targetKind: BulkRevokeKind;
  motivo: string;
  attachmentIds: string[];
};
