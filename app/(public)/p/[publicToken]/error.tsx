"use client";

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function PublicCredentialError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundary error={error} reset={reset} homeHref="/" homeLabel="Volver al inicio" />;
}
