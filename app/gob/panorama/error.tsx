"use client";

// Segment error boundary for /gob/panorama (RESILIENCE 2026-07-10, PO
// instrumented-review finding #1). Without it, a throw inside the streamed
// panorama board (the Suspense child in page.tsx) bubbled past the segment and,
// while the board was still streaming, left the operator on the parent
// "Cargando…" skeleton FOREVER (the server render never resolved into either a
// board or an error). A panorama-local boundary turns that into an honest,
// recoverable "algo salió mal · reintentar" state so a jurisdiction operator is
// never stranded.

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function GobPanoramaError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundary error={error} reset={reset} homeHref="/gob" homeLabel="Volver al panel" />;
}
