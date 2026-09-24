// Exported types for the service-dog use-cases.

import type { ServiceDogType, ServiceDogVisibility } from "@/db";

export type UpsertServiceDogInput = {
  petPublicToken: string;
  serviceType: ServiceDogType;
  trainingCenter: string;
  trainingCertDate?: string | null;
  rupgaCredential?: string | null;
  credentialIssueDate?: string | null;
  credentialExpiryDate?: string | null;
  notes?: string | null;
  publicVisibility?: ServiceDogVisibility;
};

export type UpsertServiceDogResult = { ok: true } | { error: string };

export type SubmitVerificationInput = {
  petPublicToken: string;
};

export type SubmitVerificationResult = { approvalRequestPublicToken: string } | { error: string };

export type RevokeServiceDogInput = {
  petPublicToken: string;
  motivo: string;
};
