// Exported types for the PPP CABA export use-case.

export type GeneratePppExportResult =
  | { ok: true; signedUrl: string; expiresAt: Date }
  | { ok: false; error: string };
