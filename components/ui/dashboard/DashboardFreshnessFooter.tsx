// DashboardFreshnessFooter — async server component.
//
// Renders a muted one-line footer on every dashboard indicating:
//   "Calculado al {server-render timestamp, es-AR} · último evento {maxOccurredAt, es-AR}"
//
// "Calculado al" anchors when the page was rendered (i.e. when the DB query
// ran), giving operators a staleness signal even before they check the data.
// "Último evento" shows the most recent pet_events row in scope so they can
// tell at a glance whether the system has new data or is quiet.
//
// DESIGN NOTES
// ------------
//   - Async RSC: awaits lastIngestAt so no client-side fetch is needed.
//   - Uses new Date() for "now" (server render time), NOT Date.now() stored
//     in state — this is intentionally a server-time snapshot.
//   - Token classes: text-sm text-ln-op-mute — matches the OpKpi sub/
//     hint row style used across the dashboard component set.
//   - No border, no padding — caller controls vertical spacing.

import { FreshnessStaleBand } from "@/components/ui/dashboard/FreshnessStaleBand";
import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import type { ProjectionContext } from "@/lib/metrics/context";
import { lastIngestAt } from "@/lib/metrics/freshness";
import { formatDateTimeNumericAr } from "@/lib/utils/format";

type Props = {
  ctx: ProjectionContext;
};

/**
 * Async server component that renders a muted freshness footer line.
 *
 * Example output:
 *   "Calculado al 21/06/2026 14:32 · último evento 20/06/2026 22:15"
 *   "Calculado al 21/06/2026 14:32 · último evento sin eventos"
 *
 * @param ctx - The active ProjectionContext (passed from the page boundary).
 */
export async function DashboardFreshnessFooter({ ctx }: Props) {
  // BOUNDED, and this one mattered more than any single page.
  //
  // lastIngestAt is a max(pet_events.occurred_at) with an INNER JOIN on pets —
  // a full aggregate over the event spine — awaited here with no deadline and
  // no Suspense. This component is the LAST CHILD of ~21 dashboards, six of
  // them pages whose own fan-outs were bounded in the 2026-08-09 outage pass.
  //
  // That made those fixes hollow: the fan-out could return inside its 10s
  // budget and the page would still never finish its RSC stream, because the
  // footer was still hanging. Same blank-forever symptom, same absence from the
  // logs, and `lint:db-budget` green the whole time — the fence only reads the
  // page file, and the unbounded await lives here.
  //
  // 3s: a freshness stamp is the least important thing on any of these screens.
  // Degrading it to "sin dato" costs a reader nothing; hanging on it costs them
  // the page. Found by adversarial review, not by the fence.
  const load = await loadWithTimeout(lastIngestAt(ctx), 3_000);
  const maxAt = load.ok ? load.value : null;

  const nowLabel = formatDateTimeNumericAr(new Date());
  const eventLabel = !load.ok
    ? "sin dato"
    : maxAt != null
      ? formatDateTimeNumericAr(maxAt)
      : "sin eventos";

  return (
    <>
      {/* degraded-states: amber band once the SHOWN data crosses the staleness
          threshold (STALE_BAND_AFTER_MS). Mounted here, in the shared footer,
          so every call site gains it with zero edits. `refreshSignal` is an
          opaque per-render token: a live data refresh re-renders this RSC,
          serializes a new value, and resets the band's elapsed clock — it is
          never compared against the client clock (skew-immune). */}
      <FreshnessStaleBand refreshSignal={`${Date.now()}`} />
      <p className="text-sm text-ln-op-mute">
        Calculado al {nowLabel} · último evento {eventLabel}
      </p>
    </>
  );
}
