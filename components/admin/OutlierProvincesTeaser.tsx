// OutlierProvincesTeaser — the /admin home's compliance lens (D-2, Lote D).
//
// WHY: the national portal owns the territorial index and the policy→outcome
// analysis, and its own landing showed neither. An admin reading the home could
// answer "what is queued?" in a glance and "where is the country failing its
// programmatic targets?" not at all — the briefing had operations and no
// compliance. This card is the smallest honest fix: the handful of provinces
// furthest from target, named, ranked, and one click from the full table.
//
// NO NEW MEASUREMENT. It renders `computeJurisdictionIndex` over
// `fetchCrossJurisdictionOutliers` — the exact pair /admin/inteligencia's index
// panel consumes — and shows a subset of those same rows with their `rank`
// untouched. "Puesto 23 de 24" here IS the row the full table numbers 23.
//
// DISCLOSURE, NOT SILENCE. Two facts travel with the list rather than being
// smoothed away: k-anonymity already removed provinces under 5 active pets
// upstream (so this is a ranking of the EVALUATED ones, and the footnote says
// so), and a partial index (rabies component suppressed for <5 dogs) is marked
// with the same asterisk convention the full table uses instead of being
// dropped from the tail it belongs in.
//
// PRESENTATIONAL ONLY — the page fetches and budgets; this renders.

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import type { JurisdictionIndexRow } from "@/lib/analytics/territorial-index";
import { pluralizeEs } from "@/lib/utils/format";

/**
 * Score bands. These are ATTENTION heuristics over a composite of three
 * programmatic targets — deliberately not a legal verdict, because the index
 * averages metrics whose targets have different sources and force (see
 * kpi-catalog's territorial_index_average_score). Hence the muted vocabulary:
 * a low score means "furthest from target", never "in breach".
 */
function scoreTone(score: number): "danger" | "warn" | "neutral" {
  if (score < 50) return "danger";
  if (score < 75) return "warn";
  return "neutral";
}

const TONE_TEXT: Record<"danger" | "warn" | "neutral", string> = {
  danger: "text-[var(--color-st-err)]",
  warn: "text-[var(--color-st-warn)]",
  neutral: "text-ln-op-ink",
};

export function OutlierProvincesTeaser({
  rows,
  evaluatedTotal,
}: {
  /** The lowest-scoring rows, worst first (selectLowestScoringJurisdictions). */
  rows: readonly JurisdictionIndexRow[];
  /** How many provinces the index could evaluate at all — the "de N" denominator. */
  evaluatedTotal: number;
}) {
  const anyPartial = rows.some((r) => r.componentsUsed < 3);

  return (
    <OpCard>
      <OpCardHead
        title="Provincias más lejos de la meta"
        actions={
          <Link
            href="/admin/inteligencia"
            className="inline-flex items-center gap-1 hover:underline"
          >
            Ver índice completo
            <Icon name="chevron-right" size="sm" decorative />
          </Link>
        }
      />
      <OpCardBody className="space-y-2">
        {rows.length === 0 ? (
          // measured-zero, not no-signal: fetchCrossJurisdictionOutliers runs
          // unconditionally over the whole padrón. An empty result means no
          // province cleared the k-anonymity floor — which is a fact about
          // COVERAGE, and the copy says exactly that instead of implying the
          // country has no gaps.
          <LnEmptyState
            icon="chart-line"
            nature="measured-zero"
            title="Sin provincias evaluables todavía"
            description="Se consultó el índice territorial: ninguna provincia alcanza el mínimo de 5 mascotas activas necesario para calcularlo sin exponer casos individuales."
          />
        ) : (
          <>
            <ul className="divide-y divide-ln-op-line-2">
              {rows.map((row) => {
                const tone = scoreTone(row.score);
                return (
                  <li key={row.province} className="flex items-baseline justify-between gap-3 py-2">
                    <span className="min-w-0 text-md text-ln-op-ink">
                      {row.province}
                      {row.componentsUsed < 3 && (
                        <span
                          className="text-ln-op-mute"
                          title="Índice parcial: componente antirrábica omitida por k-anonimato"
                        >
                          {" *"}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                      <span className={`font-ln-serif text-lg font-semibold ${TONE_TEXT[tone]}`}>
                        {row.score}
                      </span>
                      <span className="text-sm text-ln-op-mute">
                        puesto {row.rank} de {evaluatedTotal}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-ln-op-mute">
              Índice compuesto 0-100: promedio del cumplimiento de las metas de antirrábica,
              esterilización y microchip. Es una señal de atención sobre metas programáticas, no un
              veredicto legal. Provincias con menos de 5 mascotas activas no se evalúan (privacidad)
              — el ranking es sobre {evaluatedTotal} {pluralizeEs(evaluatedTotal, "provincia")}{" "}
              {pluralizeEs(evaluatedTotal, "evaluada")}.
              {anyPartial && " * = índice parcial (2 de 3 componentes)."}
            </p>
          </>
        )}
      </OpCardBody>
    </OpCard>
  );
}
