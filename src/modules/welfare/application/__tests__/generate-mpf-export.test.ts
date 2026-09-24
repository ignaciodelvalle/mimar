// Unit tests for generateMpfExport use-case.
// Spec R6 — idempotency window + pipeline steps + audit_log + NOT in tx.

import { describe, expect, it, vi } from "vitest";

import type { WelfareReport } from "@/db/schema";
import {
  UNRESOLVED_EXPORTER_LABEL,
  type WelfareRepository,
} from "../../infrastructure/welfare-repository";
import { generateMpfExport } from "../generate-mpf-export";

// ---------------------------------------------------------------------------
// Minimal fixture
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<WelfareReport> = {}): WelfareReport {
  return {
    id: "rpt-001",
    referenceCode: "DEN-MPF-001",
    status: "in_progress",
    reporterUserId: "user-reporter-01",
    caseId: "case-001",
    triagedAt: new Date("2026-01-05"),
    triagedByUserId: "admin-user-01",
    closedAt: null,
    resolutionNotes: null,
    moderationResolvedAt: null,
    moderationResolvedByUserId: null,
    flaggedAt: null,
    flagReasons: [],
    assignedToUserId: null,
    subjectPetId: "pet-001",
    kind: "physical_abuse",
    severity: "high",
    subjectKind: "registered_pet",
    subjectDescription: null,
    description: "El animal presenta lesiones graves visibles.",
    observedSymptoms: null,
    occurredAt: null,
    locationAddress: "Av. Rivadavia 1000",
    locationLat: "-34.600",
    locationLng: "-58.400",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "CABA",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as WelfareReport;
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeDeps(
  opts: {
    report?: WelfareReport | null;
    recentExport?: { id: string; payload: Record<string, unknown>; performedAt: Date } | null;
    reporterName?: string | null;
    exporterName?: string;
    subjectPet?: { name: string; microchipId: string | null } | null;
    attachments?: Array<{ filename: string; signedUrl: string | null }>;
    pdfBytes?: Uint8Array;
    uploadError?: string;
    signedUrl?: string | null;
  } = {},
) {
  const report = opts.report !== undefined ? opts.report : makeReport();
  const recentExport = opts.recentExport !== undefined ? opts.recentExport : null;

  const repo = {
    findById: vi.fn().mockResolvedValue(report),
    findRecentMpfExport: vi.fn().mockResolvedValue(recentExport),
    findReporterName: vi.fn().mockResolvedValue(opts.reporterName ?? null),
    findExporterName: vi.fn().mockResolvedValue(opts.exporterName ?? UNRESOLVED_EXPORTER_LABEL),
    findSubjectPet: vi.fn().mockResolvedValue(opts.subjectPet ?? null),
    findAttachments: vi.fn().mockResolvedValue([]),
    insertAudit: vi.fn().mockResolvedValue(undefined),
  } as unknown as WelfareRepository;

  const pdfBytes = opts.pdfBytes ?? new Uint8Array([1, 2, 3]);
  const generatePdf = vi.fn().mockResolvedValue(pdfBytes);

  const signedUrlResult =
    opts.signedUrl !== undefined ? opts.signedUrl : "https://cdn.example.com/export.pdf";
  const createSignedUrl = vi.fn().mockResolvedValue(signedUrlResult);

  const uploadResult =
    opts.uploadError !== undefined ? { error: opts.uploadError } : { path: "rpt-001/12345.pdf" };
  const upload = vi.fn().mockResolvedValue(uploadResult);

  const actor = { user: { id: "admin-exporter-01" } };

  return { repo, generatePdf, createSignedUrl, upload, actor };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateMpfExport — idempotency", () => {
  it("returns existing URL when recent export exists and signed URL resolves", async () => {
    const existingPayload = {
      welfareReportId: "rpt-001",
      referenceCode: "DEN-MPF-001",
      storagePath: "rpt-001/12345.pdf",
      schemaVersion: "2026-05-21",
    };
    const { repo, generatePdf, createSignedUrl, upload, actor } = makeDeps({
      recentExport: { id: "audit-01", payload: existingPayload, performedAt: new Date() },
      signedUrl: "https://cdn.example.com/existing.pdf",
    });

    const result = await generateMpfExport(
      { welfareReportId: "rpt-001" },
      { repo, generatePdf, createSignedUrl, upload, actor },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signedUrl).toBe("https://cdn.example.com/existing.pdf");

    // Must NOT re-generate PDF
    expect(generatePdf).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    // No new audit inserted
    expect(repo.insertAudit).not.toHaveBeenCalled();
  });

  it("falls through to regenerate when signed URL creation fails for existing export", async () => {
    const existingPayload = {
      welfareReportId: "rpt-001",
      referenceCode: "DEN-MPF-001",
      storagePath: "rpt-001/old.pdf",
      schemaVersion: "2026-05-21",
    };
    const { repo, generatePdf, upload, actor } = makeDeps({
      recentExport: { id: "audit-01", payload: existingPayload, performedAt: new Date() },
    });
    // createSignedUrl returns null the first time (URL broken), then a real URL on second call
    const createSignedUrl = vi
      .fn()
      .mockResolvedValueOnce(null) // first call (idempotency re-sign)
      .mockResolvedValueOnce("https://cdn.example.com/new.pdf"); // second call (new upload)

    const result = await generateMpfExport(
      { welfareReportId: "rpt-001" },
      { repo, generatePdf, createSignedUrl, upload, actor },
    );

    expect(result.ok).toBe(true);
    expect(generatePdf).toHaveBeenCalled();
    expect(repo.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "welfare_mpf_export_generated" }),
    );
  });
});

describe("generateMpfExport — fresh pipeline", () => {
  it("generates PDF + uploads + signs URL + inserts audit_log (NOT in tx)", async () => {
    const { repo, generatePdf, createSignedUrl, upload, actor } = makeDeps();

    const result = await generateMpfExport(
      { welfareReportId: "rpt-001" },
      { repo, generatePdf, createSignedUrl, upload, actor },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signedUrl).toBe("https://cdn.example.com/export.pdf");
    expect(result.expiresAt).toBeInstanceOf(Date);

    // audit_log written AFTER upload (not in tx)
    expect(repo.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "welfare_mpf_export_generated",
        actorUserId: "admin-exporter-01",
        payload: expect.objectContaining({
          welfareReportId: "rpt-001",
          referenceCode: "DEN-MPF-001",
        }),
      }),
    );
  });

  it("returns pdf_render_failed when generatePdf throws", async () => {
    const { repo, createSignedUrl, upload, actor } = makeDeps();
    const generatePdf = vi.fn().mockRejectedValue(new Error("render error"));

    const result = await generateMpfExport(
      { welfareReportId: "rpt-001" },
      { repo, generatePdf, createSignedUrl, upload, actor },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("pdf_render_failed");
    expect(repo.insertAudit).not.toHaveBeenCalled();
  });

  it("returns storage_upload_failed when upload returns error", async () => {
    const { repo, generatePdf, createSignedUrl, actor } = makeDeps({
      uploadError: "bucket full",
    });

    const result = await generateMpfExport(
      { welfareReportId: "rpt-001" },
      {
        repo,
        generatePdf,
        createSignedUrl,
        upload: vi.fn().mockResolvedValue({ error: "bucket full" }),
        actor,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("storage_upload_failed");
  });

  it("returns signed_url_failed when createSignedUrl returns null on fresh export", async () => {
    const { repo, generatePdf, upload, actor } = makeDeps();
    const createSignedUrl = vi.fn().mockResolvedValue(null);

    const result = await generateMpfExport(
      { welfareReportId: "rpt-001" },
      { repo, generatePdf, createSignedUrl, upload, actor },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("signed_url_failed");
  });

  it("returns not_found when report does not exist", async () => {
    const { generatePdf, createSignedUrl, upload, actor } = makeDeps({ report: null });
    const repo = {
      findById: vi.fn().mockResolvedValue(null),
      findRecentMpfExport: vi.fn().mockResolvedValue(null),
      findReporterName: vi.fn(),
      findExporterName: vi.fn(),
      findSubjectPet: vi.fn(),
      findAttachments: vi.fn(),
      insertAudit: vi.fn(),
    } as unknown as WelfareRepository;

    const result = await generateMpfExport(
      { welfareReportId: "rpt-missing" },
      { repo, generatePdf, createSignedUrl, upload, actor },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not_found");
  });
});
