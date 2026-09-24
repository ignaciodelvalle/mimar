"use client";

// Root-level error boundary (Next.js App Router convention). Renders ONLY when
// an error escapes the root layout itself — it must supply its own <html>/<body>
// because the root layout did not render. Kept dependency-free and self-styled
// (no app providers, no shared chrome) so it works even when the app shell is
// the thing that crashed. The richer per-segment errors are handled by nested
// error.tsx boundaries; this is the last-resort fallback. Colors reference the
// design-system CSS variables (globals.css is loaded at the document level).

import { useEffect, useState } from "react";

import { reportError } from "@/lib/observability/report-error";

// PO quick win B4 (2026-07-24): "sin código" fallback — mirrors
// components/ErrorBoundary.tsx's contract; this file stays dependency-free
// (no shared component import) since it renders even when the app shell
// itself crashed, but the copy/behavior should read as the SAME surface.
const NO_CODE_LABEL = "sin código";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Production digests are also logged server-side by Next so support can
    // correlate via the digest; this is the client-side observability seam.
    reportError(error, { route: "global-error" });
  }, [error]);

  const code = error.digest ?? NO_CODE_LABEL;
  const [copied, setCopied] = useState(false);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — the code is already visible on-screen.
    }
  };

  return (
    <html lang="es-AR">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          fontFamily: "system-ui, sans-serif",
          background: "var(--color-ln-paper, #fbfaf5)",
          color: "var(--color-ln-ink, #1b2a33)",
          padding: "24px",
        }}
      >
        <main style={{ maxWidth: "28rem", textAlign: "center" }}>
          <p
            style={{
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--color-ln-mute, #616e77)",
              margin: "0 0 8px",
            }}
          >
            Algo salió mal
          </p>
          <h1 style={{ fontSize: "22px", fontWeight: 600, margin: "0 0 12px" }}>
            No pudimos cargar la página
          </h1>
          <p
            style={{
              fontSize: "14px",
              lineHeight: 1.5,
              color: "var(--color-ln-mute, #616e77)",
              margin: "0 0 20px",
            }}
          >
            Ocurrió un error inesperado. Probá de nuevo; si el problema persiste, volvé al inicio.
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              marginBottom: "16px",
            }}
          >
            <span style={{ fontSize: "12px", color: "var(--color-ln-mute, #616e77)" }}>
              Código de error: <code>{code}</code>
            </span>
            <button
              type="button"
              onClick={copyCode}
              style={{
                border: "none",
                background: "none",
                padding: 0,
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--color-ln-azul, #0e5a99)",
              }}
            >
              {copied ? "Copiado" : "Copiar código"}
            </button>
          </div>
          <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                minHeight: "44px",
                padding: "0 20px",
                borderRadius: "8px",
                border: "none",
                cursor: "pointer",
                fontSize: "14px",
                fontWeight: 600,
                color: "var(--color-ln-card, #ffffff)",
                background: "var(--color-ln-azul, #0e5a99)",
              }}
            >
              Reintentar
            </button>
            <a
              href="/"
              style={{
                minHeight: "44px",
                display: "inline-flex",
                alignItems: "center",
                padding: "0 20px",
                borderRadius: "8px",
                border: "1px solid var(--color-ln-line, #e4dfd3)",
                textDecoration: "none",
                fontSize: "14px",
                fontWeight: 600,
                color: "var(--color-ln-ink, #1b2a33)",
              }}
            >
              Volver al inicio
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
