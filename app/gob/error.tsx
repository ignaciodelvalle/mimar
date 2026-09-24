"use client";

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function GobPortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorBoundary error={error} reset={reset} homeHref="/gob" homeLabel="Volver al panel gob" />
  );
}
