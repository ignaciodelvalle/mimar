import Link from "next/link";

import { ConfidenceBadge } from "@/components/event/ConfidenceBadge";
import { OpCodeBadge } from "@/components/ui/dashboard";
import type { SurveillanceSignal } from "@/lib/analytics/govt-dashboards";
import { computeConfidence } from "@/lib/events/event-confidence";
import { formatDateShort, speciesLabel } from "@/lib/utils/format";

type OutbreakSignalRowProps = {
  signal: SurveillanceSignal;
  /**
   * When true, this row is the deep-link target (`?signalId=`). It renders a
   * highlight ring and marks itself as the current item so the client-side
   * `ScrollToSignal` helper can bring it into view.
   */
  highlighted?: boolean;
};

/** Format a Date as a human-readable "time ago" string in es-AR. */
function timeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  // Future-dated (never say "hace -N") or older than a year → absolute date.
  // Guards against synthetic/demo events whose occurredAt sits ahead of "now"
  // or far in the past, which otherwise render as "hace -264468 min" / "hace 900d".
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  if (Number.isNaN(diffMs)) return "—";
  if (diffMs < 0 || diffMs > ONE_YEAR_MS) {
    return formatDateShort(date);
  }
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `hace ${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  return `hace ${diffD}d`;
}

/**
 * Compact card-style row for a single outbreak signal.
 * Clicking navigates to the brotes drill-down pre-filtered by signalId.
 * Shows a confidence badge derived from the event's provenance (plan §A.5).
 *
 * The stable DOM id `signal-<eventId>` is the scroll anchor the brotes
 * `?signalId=` deep-link targets (see ScrollToSignal).
 */
export function OutbreakSignalRow({ signal, highlighted = false }: OutbreakSignalRowProps) {
  const href = `/gob/vigilancia/brotes?signalId=${signal.signalEventId}`;
  const confidenceTier = computeConfidence({
    authorRole: signal.authorRole,
    authorVerified: signal.authorVerified,
    authorOrganizationId: signal.authorOrganizationId,
    payload: signal.payload,
  });

  return (
    <li
      id={`signal-${signal.signalEventId}`}
      aria-current={highlighted ? "true" : undefined}
      className={[
        // CSS-8: capped at 500 rows with no virtualization — content-visibility
        // rows stay reachable by id/scrollIntoView (the ?signalId= deep-link
        // this component's own id anchors) and by in-page find.
        "op-lazy-row border-b border-ln-op-line-2 last:border-b-0 scroll-mt-24",
        highlighted ? "rounded-[var(--radius-md)] bg-ln-op-stripe ring-2 ring-ln-op-azul" : "",
      ].join(" ")}
    >
      <Link
        href={href}
        className="flex items-start justify-between gap-3 px-1 py-3 rounded-[var(--radius-md)] hover:bg-ln-op-stripe transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul focus-visible:ring-offset-1"
      >
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-md font-semibold text-ln-op-ink truncate">
              {signal.diseaseName}
            </span>
            <OpCodeBadge tone="warn">{signal.diseaseCode}</OpCodeBadge>
            <ConfidenceBadge tier={confidenceTier} />
          </div>
          <p className="text-sm text-ln-op-ink-2 truncate">
            {signal.petName} · {speciesLabel(signal.petSpecies)}
          </p>
          <p className="text-sm text-ln-op-mute truncate">
            {signal.locality ?? "—"}, {signal.province ?? "—"}
          </p>
        </div>
        <time
          dateTime={signal.detectedAt.toISOString()}
          className="text-sm text-ln-op-mute tabular-nums whitespace-nowrap shrink-0"
        >
          {timeAgo(signal.detectedAt)}
        </time>
      </Link>
      {/* THE ROW USED TO OFFER "abrir investigación" ON EVERY SIGNAL, including
          the ones somebody had already investigated - it had no way to know.
          An operator working a feed of hundreds could open a second expediente
          for a signal that already had one, and nothing on screen would stop
          them or even hint at it.

          The link is read through the `signal_link` case event that
          `openOutbreakInvestigation` writes as its own entry type, so this is
          the same fact the investigation itself records, not a guess. A signal
          with no link is genuinely untriaged - which is also what the
          "Señales sin investigación" tile counts, from the same clause. */}
      <div className="px-1 pb-2">
        {signal.investigation ? (
          <Link
            href={`/gob/vigilancia/investigaciones/${signal.investigation.publicCode}`}
            className="text-sm text-ln-op-mute hover:underline"
          >
            Ver investigación {signal.investigation.publicCode} →
          </Link>
        ) : (
          <Link
            href={`/gob/vigilancia/investigaciones/nuevo?diseaseCode=${signal.diseaseCode}&signalId=${signal.signalEventId}`}
            className="text-sm text-ln-op-azul hover:underline"
          >
            Abrir investigación →
          </Link>
        )}
      </div>
    </li>
  );
}
