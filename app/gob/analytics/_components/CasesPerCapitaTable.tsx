// Casos abiertos por 10.000 habitantes — per-capita epi ranking (E1, harvest
// ola4-facades-2026-07-21). Surfaces fetchCasesPerCapita (lib/analytics/
// dashboards/surveillance.ts) — INDEC-2022-adjusted, fully built and unit
// tested, previously wired to zero callers anywhere in app/.
//
// Placed on /gob/analytics rather than /gob/vigilancia: vigilancia already
// shows the RAW open-case count via its choropleth (and was flagged as the
// portal's densest KPI screen in the 2026-07-21 decision-density audit), so a
// second raw view there would just duplicate it. This is the population-
// normalized companion the page's own comment (above the vaccination ranking
// card) said was "demoted per PO review" as a CHOROPLETH — the map form was
// cut, not the metric. A compact ranking table matches this page's existing
// "Ranking" vocabulary without adding another map.
//
// Provinces with no census row (ratePer10k === null) are never silently
// dropped — they're listed in a footnote with their raw count instead, per
// the project's no-silent-omission convention.
//
// k-ANON (RA-3 C4, 2026-07-31). The fetcher now withholds any province with
// fewer than ANONYMITY_K open cases (count AND rate both null, `suppressed`
// true). This render is where that withholding gets SAID. The amplifier the
// review named is why it matters here specifically: the table ranks by
// per-capita RATE, and a rate divides by population — so the smallest
// provinces are systematically sorted to the top, which means the sub-k cells
// were exactly the ones most likely to be on screen. The footnote lists
// no-census provinces by name WITH their raw count, so it must skip suppressed
// rows or it becomes the bypass.

import type { ProvinceCasesPerCapita } from "@/lib/analytics/govt-dashboards";
import { ANONYMITY_K } from "@/lib/metrics/anonymity";

type Props = {
  rows: ProvinceCasesPerCapita[];
};

/** A row that survived k-anon — its `count` is a real number, not a withheld null. */
type PublishedRow = ProvinceCasesPerCapita & { count: number };

function isPublished(r: ProvinceCasesPerCapita): r is PublishedRow {
  return !r.suppressed && r.count !== null && r.count > 0;
}

export function CasesPerCapitaTable({ rows }: Props) {
  const published = rows.filter(isPublished);
  const ranked = published
    .filter((r) => r.ratePer10k !== null)
    .sort((a, b) => (b.ratePer10k as number) - (a.ratePer10k as number))
    .slice(0, 5);
  const noCensus = published.filter((r) => r.ratePer10k === null);
  const suppressedCount = rows.filter((r) => r.suppressed).length;

  // The k-anon rule, stated once and reused by every branch below so the
  // wording cannot drift between the empty state and the populated footnote.
  const suppressionNote =
    suppressedCount > 0
      ? `${suppressedCount} ${suppressedCount === 1 ? "provincia oculta" : "provincias ocultas"} con menos de ${ANONYMITY_K} casos abiertos — se ocultan por k-anonimato (conteo y tasa), no se muestran como cero.`
      : null;

  if (ranked.length === 0 && noCensus.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-md text-ln-op-mute italic">
          {suppressedCount > 0
            ? // NOT "sin casos abiertos": there ARE open cases, every province
              // holding them is just below the threshold. Saying "sin casos"
              // would be a measured-zero claim we did not measure.
              "Todas las provincias con casos abiertos están por debajo del umbral de privacidad."
            : "Sin casos abiertos en la cobertura seleccionada."}
        </p>
        {suppressionNote && <p className="text-sm text-ln-op-mute">{suppressionNote}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {ranked.length > 0 && (
        <table className="w-full text-md" aria-labelledby="cap-percapita-title">
          <caption id="cap-percapita-title" className="sr-only">
            Provincias con mayor cantidad de casos abiertos por cada 10.000 habitantes
          </caption>
          <thead>
            <tr className="border-b border-ln-op-line">
              <th scope="col" className="text-left py-1.5 pr-2 font-semibold text-ln-op-mute w-8">
                #
              </th>
              <th scope="col" className="text-left py-1.5 pr-4 font-semibold text-ln-op-mute">
                Provincia
              </th>
              <th scope="col" className="text-right py-1.5 pr-4 font-semibold text-ln-op-mute">
                Casos / 10.000 hab.
              </th>
              <th scope="col" className="text-right py-1.5 font-semibold text-ln-op-mute">
                Casos abiertos
              </th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((row, i) => (
              <tr
                key={row.code || row.province}
                className="border-b border-ln-op-line last:border-0"
              >
                <td className="py-2 pr-2 tabular-nums text-ln-op-mute">{i + 1}</td>
                <td className="py-2 pr-4 text-ln-op-ink">{row.province}</td>
                <td className="py-2 pr-4 text-right tabular-nums font-semibold text-ln-op-ink">
                  {row.ratePer10k?.toLocaleString("es-AR")}
                </td>
                <td className="py-2 text-right tabular-nums text-ln-op-mute">{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {noCensus.length > 0 && (
        <p className="text-sm text-ln-op-mute">
          Sin dato de población censal (INDEC 2022) — se muestra el conteo bruto:{" "}
          {noCensus.map((r) => `${r.province} (${r.count})`).join(", ")}.
        </p>
      )}
      {suppressionNote && <p className="text-sm text-ln-op-mute">{suppressionNote}</p>}
      {/* Honesty note (RA-3 C4, second half; rewritten 2026-08-07): `cases` is
          NOT filtered by case_kind here, so this bucket mixes maltrato,
          disputas de custodia, observación antirrábica and lost-pet episodes.
          It stays unnarrowed on purpose — a per-capita ranking of regulatory
          load is honest across every kind. What changed is the sentence that
          used to end this note: /gob/vigilancia's choropleth NO LONGER counts
          the same population (audit 2026-07-26 red #4 — a map on a vigilancia
          screen claims epidemiology by placement, and custody episodes cannot
          back that claim). The two numbers now differ by design, so the note
          has to say so, or an operator comparing the screens reads a bug. */}
      <p className="text-xs text-ln-op-mute">
        Incluye todos los tipos de caso abierto (maltrato, disputas de custodia, observación
        antirrábica, episodios de pérdida). El mapa de /gob/vigilancia cuenta menos: sólo los tipos
        epidemiológicos (mordedura / observación rábica e investigación de brote), así que sus
        números no coinciden con los de esta tabla.
      </p>
    </div>
  );
}
