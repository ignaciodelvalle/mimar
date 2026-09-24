"use client";

// Export CTA for /viaje (movilidad Fase 1, R4.1/R5). Calls the travel export
// action; on success surfaces the 24h signed URL as a download link.
//
// The bucket `travel-exports` is owner-created ops (R5.2) — if it is missing
// in an environment, the action returns storage_upload_failed and the user
// sees the es-AR error line, not a crash.

import { useState, useTransition } from "react";

import { generateTravelExportAction } from "@/app/actions/travel-export";

const ERROR_MESSAGES: Record<string, string> = {
  not_found: "No encontramos la mascota o no tenés permiso para exportar.",
  no_movement_context: "Registrá un movimiento o viaje antes de exportar.",
  pdf_render_failed: "No pudimos generar el PDF. Probá de nuevo en unos minutos.",
  storage_upload_failed: "No pudimos guardar el PDF. Probá de nuevo en unos minutos.",
  signed_url_failed: "No pudimos generar el enlace de descarga. Probá de nuevo.",
};

export function TravelExportButton({ petPublicToken }: { petPublicToken: string }) {
  const [isPending, startTransition] = useTransition();
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleExport() {
    setError(null);
    startTransition(async () => {
      const result = await generateTravelExportAction(petPublicToken);
      if (result.ok) {
        setSignedUrl(result.signedUrl);
      } else {
        setSignedUrl(null);
        setError(ERROR_MESSAGES[result.error] ?? "Error inesperado al exportar.");
      }
    });
  }

  return (
    <section aria-label="Exportar documentación de viaje" className="space-y-2">
      <button
        type="button"
        onClick={handleExport}
        disabled={isPending}
        className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] px-4 py-2 text-sm font-semibold disabled:opacity-60"
      >
        {isPending ? "Generando PDF…" : "Descargar documentación de viaje (PDF)"}
      </button>
      {signedUrl && (
        <p className="text-sm">
          <a
            href={signedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-[var(--color-ln-azul)]"
          >
            Abrir el PDF generado
          </a>{" "}
          <span className="text-xs text-[var(--color-ln-mute)]">(enlace válido por 24 horas)</span>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-[var(--color-ln-err)]">
          {error}
        </p>
      )}
    </section>
  );
}
