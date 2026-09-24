// Use-case: generate (or reuse) the welfare denuncia MPF (fiscalía) PDF
// export. Jurisdiction-compliance (2026-07-22): available to every
// jurisdiction, not just CABA — the exported format is resolved per
// jurisdiction via a cascade (resolveBusinessRule("mpf_export_format", ...)),
// wired at the action layer (src/modules/welfare/actions.ts).
//
// Migrated from app/actions/welfare-export-mpf.ts::generateMpfExportAction.
// Auth (requireAdminOrGovtOrRedirect + jurisdiction scope) handled by caller.
//
// Design decisions (preserved from original):
//   F-D2: No PKI. Traceability via referenceCode + audit_log + signed URL.
//   F-D5: audit_log action = "welfare_mpf_export_generated" (snake_case).
//   F-D6: storage bucket = "welfare-exports".
//   NOT wrapped in db.transaction (storage + audit sequential, parity).
//
// Idempotency: if audit_log row exists for this welfareReportId within 24h
//   AND signed URL is still resolvable → return existing URL (no regen).
//   If URL creation fails → fall through to regenerate.
//
// Pipeline:
//   1. Load report (not found → 'not_found').
//   2. Idempotency check.
//   3. Load ancillary data (reporter name, exporter name, subject pet, attachments).
//   4. Build DTO + render PDF.
//   5. Upload to welfare-exports bucket.
//   6. Create signed URL (24h).
//   7. Insert audit_log (NOT in tx).
//   8. Return signedUrl + expiresAt.

import { MPF_EXPORT_SCHEMA_VERSION } from "@/lib/analytics/welfare-exports";
import type { WelfareMpfAttachmentInfo, WelfareMpfDto } from "@/lib/analytics/welfare-exports";
import { formatDate } from "@/lib/utils/format";
import type { WelfareRepository } from "../infrastructure/welfare-repository";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ATTACHMENT_URL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (for PDF embeds)
const EXPORT_URL_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
};

/**
 * Injectable PDF generation function — matches lib/welfare-exports::generateWelfareMpfPdf.
 */
type GeneratePdfFn = (dto: WelfareMpfDto) => Promise<Uint8Array>;

/**
 * Injectable upload function — matches lib/welfare-exports::uploadExportToStorage.
 * Returns { storagePath } on success or { error } on failure.
 */
type UploadFn = (
  bucket: string,
  path: string,
  bytes: Uint8Array,
) => Promise<{ storagePath: string } | { error: string }>;

/**
 * Injectable signed URL creation — matches lib/welfare-exports::createSignedExportUrl.
 * Returns null on failure (expired or file removed).
 */
type CreateSignedUrlFn = (
  bucket: string,
  path: string,
  expiresIn: number,
) => Promise<string | null>;

/**
 * Injectable attachment signed URL resolver — matches lib/storage::welfareAttachmentSignedUrl.
 */
type AttachmentUrlFn = (storagePath: string, expiresIn: number) => Promise<string | null>;

type Deps = {
  repo: Pick<
    WelfareRepository,
    | "findById"
    | "findRecentMpfExport"
    | "findReporterName"
    | "findExporterName"
    | "findSubjectPet"
    | "findAttachments"
    | "insertAudit"
  >;
  generatePdf: GeneratePdfFn;
  createSignedUrl: CreateSignedUrlFn;
  upload: UploadFn;
  actor: Actor;
  /** Optional: injectable attachment URL resolver. Default: always returns null (tests). */
  attachmentUrl?: AttachmentUrlFn;
};

export type GenerateMpfExportInput = {
  welfareReportId: string;
  /**
   * MPF export format cascade (jurisdiction-compliance, 2026-07-22) —
   * optional so existing callers/tests that predate the cascade still
   * type-check. When provided, stamps the resolved format + its provenance
   * onto the audit_log payload so the cascade resolution is traceable, not
   * just visible on the PDF itself.
   */
  mpfExportFormat?: string;
  mpfExportFormatSource?: string;
};

export type GenerateMpfExportResult =
  | { ok: true; signedUrl: string; expiresAt: Date }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function generateMpfExport(
  input: GenerateMpfExportInput,
  deps: Deps,
): Promise<GenerateMpfExportResult> {
  const { repo, generatePdf, createSignedUrl, upload, actor, attachmentUrl } = deps;

  // 1. Load report.
  const report = await repo.findById(input.welfareReportId);
  if (!report) return { ok: false, error: "not_found" };

  // 2. Idempotency check.
  const existingExport = await repo.findRecentMpfExport(
    input.welfareReportId,
    IDEMPOTENCY_WINDOW_MS,
  );
  if (existingExport) {
    const storagePath =
      typeof existingExport.payload.storagePath === "string"
        ? existingExport.payload.storagePath
        : null;
    if (storagePath) {
      const existingUrl = await createSignedUrl(
        "welfare-exports",
        storagePath,
        EXPORT_URL_TTL_SECONDS,
      );
      if (existingUrl) {
        return {
          ok: true,
          signedUrl: existingUrl,
          expiresAt: new Date(Date.now() + EXPORT_URL_TTL_SECONDS * 1000),
        };
      }
      // URL creation failed (file may have been deleted) — fall through to regenerate.
    }
  }

  // 3. Load ancillary data.
  const [reporterDisplayName, exportedByDisplayName, subjectPet, attachmentRows] =
    await Promise.all([
      repo.findReporterName(report.reporterUserId),
      repo.findExporterName(actor.user.id),
      repo.findSubjectPet(report.subjectPetId),
      repo.findAttachments(input.welfareReportId),
    ]);

  const resolveAttachmentUrl = attachmentUrl ?? (async (_path: string, _ttl: number) => null);
  const attachments: WelfareMpfAttachmentInfo[] = await Promise.all(
    attachmentRows.map(async (a) => ({
      filename: a.originalFilename ?? a.storagePath.split("/").pop() ?? "adjunto",
      signedUrl: await resolveAttachmentUrl(a.storagePath, ATTACHMENT_URL_TTL_SECONDS),
    })),
  );

  const exportGeneratedAt = new Date();

  // 4. Build DTO + render PDF.
  // welfareReportToMpfDto is a pure function from lib/welfare-exports — imported at the
  // action layer to keep the use-case free of the pdf-lib import chain (use-cases
  // receive the injectable generatePdf fn).
  // We call the mapper inline here because the DTO shape is tight to the use-case logic.
  // (The action passes generatePdf as a dep; the DTO shape is tested via the action.)

  // Build DTO manually (mirrors welfareReportToMpfDto without importing pdf-lib chain here).
  // For type-safety we reconstruct it; the action will use the real mapper.
  // In tests, generatePdf is mocked so DTO correctness is tested via integration.

  let pdfBytes: Uint8Array;
  try {
    // The action builds the DTO and passes it via `generatePdf(dto)` — here we receive
    // the already-assembled DTO via the injectable. To keep this use-case testable without
    // the real pdf-lib chain, the `generatePdf` dep accepts the DTO type; the action
    // constructs it and passes the fully wired fn.
    //
    // IMPORTANT: the action wraps generateWelfareMpfPdf + welfareReportToMpfDto into
    // a single closure so the use-case only holds the "give me bytes" contract.
    // See actions.ts for wiring.
    pdfBytes = await generatePdf({
      referenceCode: report.referenceCode,
      reportId: report.id,
      kindLabel: report.kind,
      severityLabel: report.severity,
      description: report.description,
      observedSymptoms: report.observedSymptoms,
      // AR-pinned (bug 4) — note the production action ignores this inline DTO
      // and rebuilds via welfareReportToMpfDto (the real mapper, also fixed);
      // kept consistent so no ambient-zone formatting survives anywhere.
      occurredAtLabel: report.occurredAt ? formatDate(report.occurredAt) : "no especificada",
      jurisdictionProvince: report.jurisdictionProvince,
      jurisdictionLocality: report.jurisdictionLocality,
      locationAddress: report.locationAddress,
      locationLat: report.locationLat,
      locationLng: report.locationLng,
      subjectKindLabel: report.subjectKind,
      subjectDescription: report.subjectDescription,
      subjectPet,
      reporterDisplayName,
      reporterIsAnonymous: report.reporterUserId === null,
      reporterContactEmail: null,
      reporterContactPhone: null,
      attachments,
      exportGeneratedAt: exportGeneratedAt.toISOString(),
      reportCreatedAt: report.createdAt.toISOString(),
      exportedByDisplayName,
      // task #77: placeholder — the production action rebuilds the DTO via the real
      // welfareReportToMpfDto mapper (which computes the knowledge gap), so this
      // inline value never reaches the PDF. Kept null to satisfy the type contract
      // without pulling the pdf-lib chain into the use-case.
      knowledgeGapLabel: null,
      // MPF export format cascade (jurisdiction-compliance, 2026-07-22) —
      // same placeholder rationale as knowledgeGapLabel above: the production
      // action rebuilds the DTO via welfareReportToMpfDto with the real
      // resolveBusinessRule("mpf_export_format", ...) result, so these inline
      // values never reach the PDF.
      fiscalUnitLabel: "Unidad Fiscal de Maltrato Animal (placeholder — no usado en producción)",
      mpfFormatLabel: "Estándar nacional (PDF libre, Ley 14.346)",
      mpfFormatProvenanceLabel: "Default nacional",
    });
  } catch (err) {
    console.error("[welfare/generate-mpf-export] PDF render failed:", err);
    return { ok: false, error: "pdf_render_failed" };
  }

  // 5. Upload to storage.
  const timestamp = exportGeneratedAt.getTime();
  const storagePath = `${input.welfareReportId}/${timestamp}.pdf`;

  const uploadResult = await upload("welfare-exports", storagePath, pdfBytes);
  if ("error" in uploadResult) {
    console.error("[welfare/generate-mpf-export] Storage upload failed:", uploadResult.error);
    return { ok: false, error: "storage_upload_failed" };
  }

  // 6. Create signed URL.
  const signedUrl = await createSignedUrl("welfare-exports", storagePath, EXPORT_URL_TTL_SECONDS);
  if (!signedUrl) {
    return { ok: false, error: "signed_url_failed" };
  }

  // 7. Insert audit_log (NOT in tx — storage isn't transactional, parity F-D).
  await repo.insertAudit({
    actorUserId: actor.user.id,
    action: "welfare_mpf_export_generated",
    payload: {
      welfareReportId: input.welfareReportId,
      referenceCode: report.referenceCode,
      storagePath,
      schemaVersion: MPF_EXPORT_SCHEMA_VERSION,
      // MPF export format cascade (jurisdiction-compliance, 2026-07-22) —
      // traceability twin of the PDF's own "Formato del export" line. Omitted
      // when the caller doesn't pass it (predates the cascade).
      ...(input.mpfExportFormat ? { mpfExportFormat: input.mpfExportFormat } : {}),
      ...(input.mpfExportFormatSource
        ? { mpfExportFormatSource: input.mpfExportFormatSource }
        : {}),
    },
  });

  return {
    ok: true,
    signedUrl,
    expiresAt: new Date(Date.now() + EXPORT_URL_TTL_SECONDS * 1000),
  };
}
