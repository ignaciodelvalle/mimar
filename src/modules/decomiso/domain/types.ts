// Domain types for the decomiso (Ley 14.346) module.
// Pure value shapes — no DB, no framework.

export type SeizureMotive =
  | "maltrato_fisico"
  | "abandono_extremo"
  | "acumulacion"
  | "trafico"
  | "sin_refugio_critico"
  | "pelea_de_perros"
  | "otro";

/** Descriptive fields for an unowned stray animal. */
export interface UnownedAnimalInput {
  species: string;
  sex: "male" | "female" | "unknown";
  breed?: string | null;
  color?: string | null;
  distinguishingFeatures?: string | null;
  approxAgeMonths?: number | null;
}

export interface ExecuteDecomisoInput {
  subjectKind: "registered_pet" | "unowned_animal";
  petPublicToken?: string | null;
  unownedAnimal?: UnownedAnimalInput | null;
  seizureMotive: SeizureMotive;
  seizureMotiveOtherDetail?: string | null;
  judicialProceedingReference?: string | null;
  originatingWelfareReportId?: string | null;
  intendedReceiverOrganizationId: string;
  intakeCondition?: string | null;
  attachmentFiles: File[];
}

export type GovtOrg = {
  id: string;
  displayName: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

export type ReceiverOrg = {
  id: string;
  displayName: string;
  verified: boolean | null;
  status: string;
  orgType: string;
};

export type NewNotification = {
  userId: string;
  notificationType: string;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "urgent";
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  relatedPetId?: string | null;
  relatedCaseId?: string | null;
};

export type UseCaseResult<T = void> =
  | { ok: true; value: T; notifications: NewNotification[] }
  | { ok: false; error: string };

// Per-file ceiling of decomiso evidence: 10 MiB, the `file_size_limit` of the
// `decomiso-evidence` bucket (db/migrations/0234) and MAX_DECOMISO_EVIDENCE_BYTES
// in lib/media/limits.ts (pinned equal in __tests__/storage-buckets-exist.test.ts).
// It said 25 MB (DC5) while every file above 5 MiB was refused anyway.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// History of this constant:
//
// FIXED 2026-08-10. This said "pet-attachments", a bucket that does not exist —
// verified against BOTH the local database and staging. Every decomiso uploads
// its evidence here before opening the transaction, and evidence is a hard
// server-side requirement (validateAttachments demands >= 2 files), so the
// entire flow died on its first step with `Bucket not found`. Nobody noticed
// because the 408 custody_episode rows in the seed were written by script,
// skipping the action.
//
// "event-attachments" is the right target, not just an existing one: it is the
// private bucket that lib/infra/storage.ts signs against
// (eventAttachmentSignedUrl). Pointing the upload anywhere else would have
// written rows into `attachments` that no surface could ever render.
//
// MOVED 2026-09-18 (PO decision D10): evidence now goes to its own private
// bucket, `decomiso-evidence` (0234), so the acta can be a PDF without widening
// the shared bucket every signed-in account may write to. The rendering
// constraint above still holds and is met differently: the row path carries the
// bucket as a prefix and lib/infra/storage.ts routes the signature by it
// (lib/infra/attachment-location.ts). Legacy evidence stays in
// event-attachments under `decomiso/` and keeps resolving.
export const ATTACHMENT_BUCKET = "decomiso-evidence";
export const ALLOWED_SPECIES = ["dog", "cat", "other"];
