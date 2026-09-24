// AsientoCard — one rich, immutable libreta record ("Una sola libreta"
// redesign). Renders the full field set its event type carries (see
// asiento-fields.toAsientoView): a head (icon · mono kind eyebrow · serif
// title · relative+absolute date), a 2-column facts grid (mono key eyebrow +
// value, missing data shown faint), an optional full-width handwritten note or
// weight sparkline, and a foot carrying the provenance stamp (green "Verificado"
// vs neutral "Cargado por vos"), an optional amber verification warning, and a
// "Ver detalle" action on every row, plus "Pedir verificación" for a
// self-declared rabies dose.
//
// Append-only: an asiento is never edited. A correction is a NEW asiento; when
// a later amendment supersedes this row, the foot notes "corregido" and links
// to the original.

import Link from "next/link";

import { Icon } from "@/components/Icon";
import type { WeightSample } from "@/components/pet-profile/WeightSparkline";
import { formatDelta, formatRate } from "@/lib/utils/format";
import type { AsientoView } from "./asiento-fields";

function AsientoSparkline({ samples }: { samples: WeightSample[] }) {
  if (samples.length < 2) {
    return (
      <span className="ln-trend text-[var(--color-ln-faint)]">
        Cargá otro peso para ver la curva.
      </span>
    );
  }
  const sorted = [...samples].sort((a, b) => a.date.getTime() - b.date.getTime());
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const kgs = sorted.map((s) => s.kg);
  const min = Math.min(...kgs);
  const max = Math.max(...kgs);
  const pad = Math.max((max - min) * 0.15, 0.05);
  const yMin = Math.max(0, min - pad);
  const yMax = max + pad;
  const range = yMax - yMin;
  const dx = 122 / (sorted.length - 1);
  // Guard the zero-range case (all identical weights) — draw a flat line at
  // mid-height instead of dividing by 0 → NaN → an invisible polyline.
  const yFor = (kg: number) => (range === 0 ? 17 : ((yMax - kg) / range) * 26 + 4);
  const points = sorted
    .map((s, i) => `${(4 + i * dx).toFixed(1)},${yFor(s.kg).toFixed(1)}`)
    .join(" ");
  const lastX = 4 + (sorted.length - 1) * dx;
  const lastY = yFor(last.kg);

  const delta = last.kg - first.kg;
  const months = Math.max(
    1,
    Math.round((last.date.getTime() - first.date.getTime()) / (30 * 86_400_000)),
  );
  // es-AR, 1 decimal — same KPI-precision rule as the operator dashboards
  // (lib/utils/format.ts): a continuous measurement like weight always shows
  // one decimal, never a bare integer next to a "24,5 kg" sibling.
  const kgLabel = `${formatRate(last.kg)} kg`;
  const spanLabel = months === 1 ? "1 mes" : `${months} meses`;
  const deltaLabel = `${formatDelta(delta, { unit: " kg" })} en ${spanLabel}`;
  // Full trend as an accessible label (the curve is the visual; screen readers
  // get the numbers). Names the current weight, the change, the span, and how
  // many weigh-ins the trailing-12-month curve is built from.
  const ariaLabel = `Tendencia de peso: ${kgLabel}, ${deltaLabel}, ${sorted.length} registros en el último año`;

  return (
    <>
      <svg viewBox="0 0 130 34" preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
        <polyline
          points={points}
          fill="none"
          stroke="var(--color-ln-ok)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={lastX} cy={lastY} r="3" fill="var(--color-ln-ok)" />
      </svg>
      <span className="ln-trend" aria-hidden>
        <b>{kgLabel}</b> · {deltaLabel}
      </span>
    </>
  );
}

export function AsientoCard({
  view,
  eventHref,
  weightSamples,
}: {
  view: AsientoView;
  eventHref: string;
  weightSamples?: WeightSample[];
}) {
  const hasFacts = view.facts.length > 0 || view.handwrittenNote || view.showSparkline;

  return (
    <article className="ln-asiento" data-section="asiento">
      <div className="ln-asiento-head">
        <span className={`ln-asiento-ic ${view.tint}`}>
          <Icon name={view.icon} size="sm" decorative />
        </span>
        <div className="ln-asiento-h">
          <div className="ln-asiento-kind">{view.kind}</div>
          <div className="ln-asiento-title">{view.title}</div>
        </div>
        <div className="ln-asiento-when">
          {view.whenRelative}
          <br />
          {view.whenAbsolute}
        </div>
      </div>

      {hasFacts && (
        <div className="ln-asiento-facts">
          {view.handwrittenNote && (
            <div className="ln-fact ln-fact--full">
              <div className="ln-k">Anotación</div>
              <div className="ln-v">
                <span className="ln-note-hand">{view.handwrittenNote}</span>
              </div>
            </div>
          )}
          {view.facts.map((f) => (
            <div key={f.key} className="ln-fact">
              <div className="ln-k">{f.key}</div>
              <div
                className={["ln-v", f.mono ? "ln-mono" : "", f.missing ? "ln-miss" : ""]
                  .filter(Boolean)
                  .join(" ")}
              >
                {f.value}
              </div>
            </div>
          ))}
          {view.showSparkline && (
            <div className="ln-fact ln-fact--full">
              <div className="ln-k">Tendencia</div>
              <div className="ln-v ln-spark">
                <AsientoSparkline samples={weightSamples ?? []} />
              </div>
            </div>
          )}
        </div>
      )}

      <div className="ln-asiento-foot">
        <span className="ln-prov" data-k={view.provenance.verified ? "verified" : "self"}>
          <Icon
            name={view.provenance.verified ? "check-circle" : "usuarios"}
            size="sm"
            decorative
          />
          {view.provenance.label}
        </span>
        {view.warn && (
          <span className="ln-warnnote">
            <Icon name="info" size="sm" decorative />
            {view.warn}
          </span>
        )}
        {view.amended && (
          <span className="font-ln-mono text-xs uppercase tracking-[.06em] text-[var(--color-ln-faint)]">
            · corregido
          </span>
        )}
        <span className="ln-fspace" />
        {/* "Pedir verificación" ACCOMPANIES the detail link, never replaces
            it. As an either/or, a self-declared vaccine was the only asiento
            type with no route to its own detail page — which is also the only
            place its photo attachment renders, so the photo was unreachable
            from the UI entirely (9-role external run, 2026-08-18). */}
        {view.verifyHref && (
          <Link
            href={view.verifyHref}
            prefetch={false}
            className="font-ln-mono text-sm font-semibold uppercase tracking-[.04em] text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            Pedir verificación →
          </Link>
        )}
        <Link
          href={eventHref}
          prefetch={false}
          className="text-sm font-semibold text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          Ver detalle →
        </Link>
      </div>
    </article>
  );
}
