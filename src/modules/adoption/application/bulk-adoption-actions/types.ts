export type BulkAdoptionApproveInput = {
  orgToken: string;
  applicationEventIds: string[];
  notes?: string | null;
};

export type BulkAdoptionRejectInput = {
  orgToken: string;
  applicationEventIds: string[];
  reason: string;
};
