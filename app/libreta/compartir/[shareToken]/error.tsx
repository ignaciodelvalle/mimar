"use client";

// Segment error boundary for the shared libreta view (error-path audit
// 2026-07-04 N5/E2). This surface is vet-facing (or any third party holding
// the link) — usually not logged in and unfamiliar with internal miMAR
// navigation, so it keeps ErrorBoundary's generic default copy/escape ("Volver
// al inicio" → "/") instead of a portal-specific label that would only make
// sense to an owner or operator.

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function LibretaCompartirError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundary error={error} reset={reset} />;
}
