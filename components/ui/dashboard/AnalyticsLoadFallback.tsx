// AnalyticsLoadFallback — honest degraded state for the admin analytics pages (D2).
//
// Rendered in place of the dashboard body when loadWithTimeout reports that the
// fetcher set timed out or errored. It is a real, terminal state — NOT a
// skeleton — so the operator never stares at an infinite loader: a clear message
// plus a "Reintentar" link that re-requests the same route (period filter kept
// via retryHref). Pure server component so it stays trivially testable.

import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpCard, OpCardBody } from "@/components/ui/dashboard";

type Props = {
  /** Why the load degraded: "timeout" (deadline) or "error" (rejection). */
  reason: "timeout" | "error";
  /** Where "Reintentar" points — the same page path + period search params. */
  retryHref: string;
  /**
   * Short correlation id minted by loadWithTimeout on failure (QA fix 6). The
   * same id is logged server-side with the real error, so a human quoting
   * "Código: <id>" lets us find the log line. Rendered subtly; omitted when
   * the caller's load result predates the id (optional field).
   */
  correlationId?: string;
};

export function AnalyticsLoadFallback({ reason, retryHref, correlationId }: Props) {
  const title =
    reason === "timeout"
      ? "Los datos están tardando más de lo normal"
      : "No pudimos cargar los datos";
  const description =
    reason === "timeout"
      ? "La consulta superó el tiempo de espera. Probá de nuevo en unos segundos."
      : "Ocurrió un error al cargar la analítica. Probá de nuevo.";

  return (
    <OpCard>
      <OpCardBody>
        <LnEmptyState
          icon="chart-line"
          title={title}
          description={description}
          action={
            <a
              href={retryHref}
              className="inline-flex h-11 items-center rounded-[var(--radius-md)] border border-ln-op-line px-4 text-md text-ln-op-ink no-underline hover:bg-ln-op-stripe"
            >
              Reintentar
            </a>
          }
        />
        {correlationId && (
          <p className="mt-3 select-all text-center font-ln-mono text-xs text-ln-op-mute">
            Código: {correlationId}
          </p>
        )}
      </OpCardBody>
    </OpCard>
  );
}
