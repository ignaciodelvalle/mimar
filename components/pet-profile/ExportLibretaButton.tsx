"use client";

// ExportLibretaButton — Item 14.3.
//
// Opens /api/mis-mascotas/[publicToken]/libreta-export in a new tab. That
// route returns print-ready HTML (Content-Type: text/html, no
// Content-Disposition) and auto-triggers window.print() on load — the PDF
// is produced by the browser's own print-to-PDF, not the server. There is
// no server-side PDF generation; the label reflects that (real
// server-generated PDF export is a tracked follow-up, not this button's
// behavior). No persistence (pet_attachments deferred).
//
// Empty libreta edge: the export route renders an empty-state section —
// no broken print view.

export function ExportLibretaButton({ petPublicToken }: { petPublicToken: string }) {
  function handlePrint() {
    const url = `/api/mis-mascotas/${petPublicToken}/libreta-export`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <button
      type="button"
      onClick={handlePrint}
      className="cursor-pointer font-ln-mono text-xs uppercase tracking-[.06em] text-[var(--color-ln-azul)] hover:underline print:hidden"
    >
      Imprimir libreta (PDF)
    </button>
  );
}
