// Travel export use-case types (movilidad-jurisdiccional Fase 1).

export type GenerateTravelExportResult =
  | { ok: true; signedUrl: string; expiresAt: Date }
  | {
      ok: false;
      error:
        | "not_found"
        | "no_movement_context"
        | "pdf_render_failed"
        | "storage_upload_failed"
        | "signed_url_failed";
    };
