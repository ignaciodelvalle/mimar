export type AcceptReturnFormState = {
  error: string | null;
  autoCancelled?: boolean;
  autoCancelReason?: string;
};

export type RejectReturnFormState = {
  error: string | null;
  success?: boolean;
};

export type OwnerProposeReturnToOrgFormState = {
  error: string | null;
  success?: boolean;
};

export type CancelProposalFormState = {
  error: string | null;
  success?: boolean;
};
