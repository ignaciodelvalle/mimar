// Panorama F3 — curated default views ("presets").
//
// Each preset encodes a QUESTION the operator wants to answer, mapping to a
// compatibility-valid layer set (F2) plus aggregation level and period.
// The 8 individual layer checkboxes remain available as "modo avanzado".
//
// Pure module — no DB, no React, no Next.

import type { AggregationLevel, LayerId, PanoramaKpiId } from "./types";
import type { EncodingId } from "./view-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PresetId =
  | "brotes-activos"
  | "sintomas"
  | "cumplimiento"
  | "bienestar"
  | "mortalidad"
  | "perdidas-reunificacion"
  | "desierto-veterinario"
  | "acceso-veterinario"
  | "tendencia"
  | "cruce-mordeduras-ppp"
  | "indice-territorial";

/**
 * D1 preset merge (PO-ratified, 2026-08-15): the metric axis of the merged
 * "Cumplimiento" vista. The five same-shaped compliance vistas (cumplimiento /
 * registro-ppp / control-poblacional / microchip / antiparasitario) collapsed
 * into ONE preset with a metric selector — each old vista survives as an option
 * here, and its old id survives as a LEGACY_PRESET_ALIASES entry.
 */
export type ComplianceMetricId =
  | "cobertura"
  | "esterilizacion"
  | "ppp"
  | "microchip"
  | "antiparasitario";

/**
 * One selectable metric of a metric-selector preset: the base layer it paints
 * and the curated decision KPIs its metrics column shows. The parent preset's
 * signal/references (none today for cumplimiento) ride along unchanged — an
 * option only substitutes the BASE and the metrics list.
 */
export type ComplianceMetricOption = {
  metric: ComplianceMetricId;
  /** es-AR short label shown on the metric radio. */
  label: string;
  base: LayerId;
  metrics: readonly PanoramaKpiId[];
};

/**
 * Optional map framing a preset applies on activation (panorama-redesign Fase 1).
 * CAMERA-ONLY — data scope is untouched (server-side scoping unchanged): a
 * national frame over a scoped operator shows their data on a wider canvas.
 *
 *  - `national` — fit the map to the national bbox (province-level overview).
 *  - `bbox` — fit to an explicit [[minLng,minLat],[maxLng,maxLat]] box.
 */
export type PresetFraming =
  | { kind: "national" }
  | { kind: "bbox"; bounds: [[number, number], [number, number]] };

/**
 * Decide whether activating a preset should EMIT its map frame (camera move).
 *
 * A preset's `national` framing is a DEFAULT overview that must only fire from a
 * neutral/national context — it must NEVER override an explicit drill or a
 * jurisdiction-scoped operator's own extent. Switching a nationally-framed vista
 * while drilled/scoped used to yank the camera out to the whole country ("me
 * saca de la vista"). So a national frame is suppressed whenever the operator has
 * an active scope; the caller then clears the frame and the camera stays put.
 *
 * An explicit `bbox` frame is a deliberate intent (not a default) and always
 * emits. A framing-less preset emits nothing.
 *
 * @param framing        the preset's framing field, if any.
 * @param hasActiveScope true when the operator has an active scope — a drilled
 *   province/locality OR a jurisdiction-scoped session.
 */
export function shouldEmitPresetFrame(
  framing: PresetFraming | null | undefined,
  hasActiveScope: boolean,
): boolean {
  if (!framing) return false;
  if (framing.kind === "national") return !hasActiveScope;
  return true;
}

export type PanoramaPreset = {
  id: PresetId;
  /** es-AR short label (shown on the preset button). */
  label: string;
  /**
   * The QUESTION this preset answers.  Phrased in first-person/operator voice
   * (es-AR). Shown as helper text below the preset button.
   */
  description: string;
  /**
   * The single base layer (dataType "rate" | "density").
   * Exactly 1 base per preset — enforced by the F2 compatibility model.
   */
  base: LayerId;
  /**
   * Optional overlay signal layer (dataType "signal").
   * At most 1 signal per preset — enforced by the F2 compatibility model.
   * EXCEPTION (new-vistas wave): the overlay slot of a DECLARED bivariate pair
   * (bivariate.ts BIVARIATE_PAIRS) may name a density layer — riesgo-ppp stacks
   * mordeduras (density) over the ppp rate surface; the F2 exception in
   * checkCompatibility admits exactly these vetted pairs.
   */
  signal?: LayerId;
  /**
   * The layer the Estadísticas ranking ("Peores N") ranks by — the preset's
   * PRIMARY question metric (Cowork QA ronda 3 §4, P2.5). Defaults to `base`
   * (the choropleth) when absent, which is correct for the compliance/density
   * presets whose question IS the base measure. Set it only when the base is a
   * backdrop and the question is about the SIGNAL overlay: `brotes-activos` maps
   * cobertura (base backdrop) but asks "¿dónde hay brotes?", so its ranking must
   * order by the zoonosis SIGNAL, not by coverage. Must be one of the preset's
   * activated layers ([base, signal, ...references]) so its features are loaded.
   */
  rankBy?: LayerId;
  /**
   * Optional reference layers (dataType "reference").
   * Unlimited — reference layers are always compatible.
   */
  references?: LayerId[];
  /**
   * Aggregation granularity the preset PREFERS.
   *
   * PO-ratified 2026-07-09: this is an INITIAL PREFERENCE, not a force. In
   * NATIONAL framing every preset opens at `province` (24 rows, cheap, no
   * k-anon) regardless of this field; a `level: "locality"` preset drills to
   * locality only on an intentional zoom past the boundary or a jurisdiction
   * selection (scope-wins). The preference is realized by the server first-visit
   * seed (seeded at the scope-derived level) and the live camera hysteresis —
   * NOT by pinning the console's level to this value on activation.
   */
  level: AggregationLevel;
  /** Period window the preset activates (maps to the ?period searchParam). */
  periodPreset: "30d" | "90d";
  /**
   * Optional map framing applied via onPreset when present. Absent = today's
   * behavior (the camera stays where it is). National-overview presets
   * (brotes-activos, cumplimiento, control-poblacional) frame the country;
   * locality-level drill-down presets (sintomas, bienestar) stay framing-less
   * (design-QA 2026-07-04 fast-follow, expanding the Fase 1 demonstrator).
   */
  framing?: PresetFraming;
  /**
   * panorama-vista-redesign: the 2-4 headline DECISION KPIs (in display order)
   * the per-vista metrics column shows for this preset — replaces the flat
   * 7-tile PanoramaKpiStrip with a curated set matching the preset's question.
   * Same `getPanoramaKpis()` result; this only filters/orders it. The coverage
   * denominator ("mascotas en cobertura") is NOT listed here — it is a footer
   * caption (metric-honesty demotion 2026-07-09), shown once for every vista.
   */
  metrics: readonly PanoramaKpiId[];
  /**
   * P5 (design §4.2 amendment): the display ENCODINGS this preset OWNS — the
   * operator-selectable toggles that stay WITHIN the vista instead of making it
   * "personalizada". `derivePreset` matches a non-null ViewState encoding only
   * against a preset that declares it. Today only `brotes-activos` owns one
   * (`bivariate`, the "Riesgo" toggle); #24's mode switcher broadens this.
   */
  encodings?: readonly EncodingId[];
  /**
   * D1 preset merge: the selectable metrics of a metric-selector vista. When
   * present, the FIRST option mirrors the preset's own base/metrics (the
   * default), so every non-selector code path is unchanged for the default
   * case; the remaining options substitute base+metrics while keeping the
   * preset's identity, level, period, framing and signal/references. Selecting
   * an option keeps the derived preset id (derivePreset also matches each
   * option's layer set). Only `cumplimiento` declares this today.
   */
  metricOptions?: readonly ComplianceMetricOption[];
};

// ---------------------------------------------------------------------------
// Preset catalogue
// ---------------------------------------------------------------------------

export const PANORAMA_PRESETS: readonly PanoramaPreset[] = [
  {
    id: "brotes-activos",
    label: "Señales de brote",
    description: "¿Dónde se registran señales de brote sobre huecos de vacunación?",
    // base: cobertura (rate choropleth) — exact fit: vaccination gaps vs. outbreak signals.
    base: "cobertura",
    // signal: zoonosis (outbreak_signals proportional symbols over the choropleth).
    signal: "zoonosis",
    // P2.5: the question is "¿dónde hay brotes?" — rank by the zoonosis SIGNAL
    // (the outbreak measure), not the cobertura backdrop, so "Peores N" answers
    // "peores por brotes" instead of silently ranking coverage.
    rankBy: "zoonosis",
    level: "province",
    periodPreset: "90d",
    // Fase 1 framing demonstrator: an outbreak overview is a national question —
    // frame the whole country so cross-province patterns are visible at once.
    framing: { kind: "national" },
    // panorama-vista-redesign: the metrics column for "¿dónde hay brotes?".
    metrics: ["cobertura", "zoonosis", "mordeduras"],
    // P5: the "Intensidad de reporte (bivariado)" toggle (renamed from "Riesgo
    // (bivariado)" — C2, 2026-07-22) is a display encoding WITHIN this
    // vista — selecting it keeps the badge on "Señales de brote" and round-trips
    // the URL (?encoding=bivariate) so a shared link reproduces the view.
    encodings: ["bivariate"],
  },
  {
    id: "sintomas",
    label: "Síntomas / vigilancia sindrómica",
    description: "¿Dónde se concentran los síntomas reportados con alerta?",
    base: "sintomas",
    // signal: zoonosis overlaid to surface reportable-disease alerts.
    signal: "zoonosis",
    level: "locality",
    periodPreset: "30d",
    metrics: ["zoonosis", "mordeduras", "denuncias"],
  },
  {
    id: "cumplimiento",
    label: "Cumplimiento",
    description: "¿Qué jurisdicciones están por debajo de la meta de la métrica elegida?",
    // D1 preset merge (EXECUTED, PO-ratified 2026-08-15 — see
    // dim-interno:docs/design/sdd/2026-07-25-panorama-d1-consolidacion-vistas.md): the five
    // same-shaped compliance vistas (cumplimiento, registro-ppp,
    // control-poblacional, microchip, antiparasitario) are now ONE vista with a
    // metric selector. Same question (rate vs meta, province grain, national
    // framing, gap ranking), five bases. F2's one-base-per-preset rule still
    // holds — an option swaps the base, it never stacks two.
    //
    // base: cobertura — the antirrábica rate (Ley 22.953). This is the DEFAULT
    // metric (metricOptions[0] mirrors it exactly), so every non-selector code
    // path behaves as the pre-merge cumplimiento did.
    base: "cobertura",
    level: "province",
    periodPreset: "90d",
    // A province-level compliance ranking is a national question — frame the
    // whole country so under-target jurisdictions are comparable at a glance.
    framing: { kind: "national" },
    // v+1 rail: microchip penetration joins the compliance trio — same legal
    // family as cobertura/esterilizacion (Ley Prov 14.107), each rendering a
    // target-progress meter (bar) against TARGETS via toneForTarget. The
    // coverage denominator now rides the shared footer caption.
    metrics: ["cobertura", "esterilizacion", "microchip"],
    // The merged metric axis. Each option ports its old vista's base + curated
    // metrics column verbatim (the old per-vista rationale lives with each):
    metricOptions: [
      // Antirrábica (the pre-merge cumplimiento default — MUST stay first and
      // mirror base/metrics above).
      {
        metric: "cobertura",
        label: "Antirrábica",
        base: "cobertura",
        metrics: ["cobertura", "esterilizacion", "microchip"],
      },
      // Ex control-poblacional: esterilizacion is the North-Star population
      // layer (divergent scale anchored at TARGETS.STERILIZATION_COVERAGE_PCT).
      {
        metric: "esterilizacion",
        label: "Esterilización",
        base: "esterilizacion",
        metrics: ["esterilizacion", "perdidas"],
      },
      // Ex registro-ppp: the C7 registry-adoption rate (Ley Prov 14.107);
      // microchip rides along — same legal family.
      { metric: "ppp", label: "Registro PPP", base: "ppp", metrics: ["ppp", "microchip"] },
      // Ex microchip: the headline legal KPI on /gob (Ley Prov 14.107 · meta
      // 80%); its own indicator leads, its legal sibling follows.
      { metric: "microchip", label: "Microchip", base: "microchip", metrics: ["microchip", "ppp"] },
      // Ex antiparasitario. KNOWN GAP, stated rather than hidden: there is no
      // `antiparasitario` PanoramaKpiId — get-panorama-kpis emits no deworming
      // tile — so this option cannot headline its own indicator. The two shown
      // are the honest neighbours: the parasitic-zoonosis signal deworming
      // exists to prevent, and the sibling 12-month sanitary coverage. When a
      // deworming KPI lands it becomes the headline and these follow it.
      {
        metric: "antiparasitario",
        label: "Desparasitación",
        base: "antiparasitario",
        metrics: ["zoonosis", "cobertura"],
      },
    ],
  },
  {
    id: "bienestar",
    label: "Bienestar y fiscalización",
    description: "¿Dónde se acumulan denuncias y decomisos por bienestar animal?",
    // base: denuncias (welfare-report density) — direct fit for welfare signals.
    base: "denuncias",
    // references: decomisos as contextual reference pins.
    references: ["decomisos"],
    level: "locality",
    periodPreset: "90d",
    metrics: ["denuncias", "mordeduras"],
    // panorama-percapita v1: the "Per cápita" toggle is a display encoding
    // WITHIN this vista (base denuncias is per-cápita eligible; decomisos is a
    // reference layer and never blocks). Selecting it keeps the badge on
    // "Bienestar y fiscalización" and round-trips the URL (?encoding=percapita)
    // so a shared link reproduces the normalized view. It only APPLIES at
    // province framing — the map projection gates that (percapitaEligibleFor).
    encodings: ["percapita"],
  },
  {
    id: "mortalidad",
    label: "Mortalidad",
    description: "¿Dónde se concentra la mortalidad registrada de mascotas?",
    // base: mortalidad (density choropleth) — pets currently in status='deceased',
    // filled at province / graduated symbol at locality. Its own vista so the
    // orphaned mortality layer has an honest home (density base, one per preset).
    base: "mortalidad",
    level: "province",
    periodPreset: "90d",
    // A province-level mortality overview is a national question — frame the country
    // so cross-province concentration is visible at once (like control-poblacional).
    framing: { kind: "national" },
    // Population/health story: mortality alongside the esterilización control metric.
    metrics: ["mortalidad", "esterilizacion"],
  },
  {
    id: "perdidas-reunificacion",
    label: "Pérdidas y reunificación",
    description: "¿Cuántas mascotas perdidas se están reencontrando con su familia?",
    // base: perdidas (density point) — lost/sighting activity.
    base: "perdidas",
    // signal: reunificacion overlaid to surface the D4 reunification rate per unit.
    signal: "reunificacion",
    level: "locality",
    periodPreset: "90d",
    // v+1 rail: the "reunificacion" KPI (D4 rate vs TARGETS.REUNIFICATION_PCT,
    // target-progress bar) headlines the question this preset asks — it was
    // previously absent from the column despite naming the preset.
    // red-team-admin-2 P1.6: dropped the off-mission "denuncias" (bienestar/
    // welfare-complaints, /gob/maltrato) — a different domain that confused this
    // lost-and-reunification lens. "perdidas" already carries the lost-pets count.
    metrics: ["perdidas", "reunificacion"],
    // Locality-level drill-down question — stays framing-less, same as sintomas
    // and bienestar (design-QA 2026-07-04 convention).
  },
  {
    id: "desierto-veterinario",
    label: "Desierto veterinario",
    description:
      "¿Qué proporción de las mascotas de cada jurisdicción no recibió NINGUNA atención veterinaria en el período, y qué capacidad instalada hay para cubrirlas?",
    // base: desierto-veterinario — the SHARE OF ACTIVE PETS WITH NO VETERINARY
    // ACT in the period (PO decision 2026-07-26; it used to be "days since the
    // last act", a MAX that could not discriminate at province grain — see the
    // registry entry and loadVetDesertByProvince). The default 90d window is the
    // vista's N: a quarter without ANY registered vet-attended event is a
    // meaningful access gap (annual antirrábica boosters + routine controls make
    // quarterly attention the expected floor). The period selector changes N and
    // the caption follows (window: "period").
    base: "desierto-veterinario",
    // references: the INSTALLED CAPACITY that turns this vista from a diagnosis
    // into a diagnosis WITH A PLAN — where are the clinics and shelters that
    // could cover the silent territory, and where is there nothing to deploy
    // through? Unblocked by the PO ruling 2026-07-25: "capacidad instalada NO es
    // presupuesto" — the standing "Panorama shows no costs" rule was being read
    // so broadly that the two directory layers stayed orphaned for months.
    // Reference layers are unlimited under F2 and never contend for the base or
    // signal slot, so this costs the vista nothing. They are DIRECTORY pins
    // (temporal: false): they do not move with the period or the time scrub, and
    // a clinic pin is a registered site, never a claim that it is open today.
    references: ["clinicas", "refugios"],
    level: "province",
    periodPreset: "90d",
    // A province-level access overview is a national question — frame the
    // country so the longest-silent jurisdictions are comparable at a glance.
    framing: { kind: "national" },
    // Vet-delivered intervention KPIs — the coverage measures that stall when a
    // territory has no registered veterinary activity.
    metrics: ["cobertura", "esterilizacion"],
    //
    // WHY THIS VISTA AND `acceso-veterinario` BOTH EXIST (2026-07-26).
    //
    // They are the two halves of the same question and neither subsumes the
    // other, so each gets its own vista (one base per preset — F2):
    //   · here, the DEFICIT — what share of the live population the system
    //     reached with nothing at all. It answers "¿a cuántas no llegamos?",
    //     which is what a coverage program is budgeted against.
    //   · `acceso-veterinario`, the INTENSITY — how many veterinary acts per
    //     1.000 mascotas a territory sustains. It answers "¿cuánta atención hay
    //     donde sí llegamos?", and a province can score well on it while leaving
    //     a large tail untouched (a small, well-attended cohort lifts the rate).
    // Measured the same day, they agree on the extremes (Salta worst, Mendoza
    // best on both) and diverge in the middle — which is the evidence that they
    // are two measures, not one metric shown twice.
    //
    // NEITHER declares a `complianceTarget`. For this layer there is no
    // defensible "meta de mascotas sin atención" at all; for acceso-veterinario
    // the annual antirrábica booster implies a ~1.000 actos/1.000 floor the
    // whole country sits far below, so declaring it would drop every province
    // into the lowest META class and flatten the map — the same saturation the
    // reshaping above exists to escape. Polarity, not a target, is what makes
    // both read correctly.
  },
  {
    id: "acceso-veterinario",
    label: "Acceso veterinario",
    description:
      "¿Cuánta atención veterinaria sostiene cada jurisdicción por cada 1.000 mascotas activas, y dónde está la red que podría cubrir el resto?",
    // base: acceso-veterinario (actos veterinarios por 1.000 mascotas activas,
    // ventana móvil de 12 meses). The LAST orphan layer in the registry: it
    // shipped with a loader, a shared fetcher (/gob/analytics) and tests, and no
    // vista ever activated it, so an operator could never see it.
    //
    // WIRABLE ONLY NOW, and only because two things landed with it:
    //   1. The NUMERATOR. It counted `vet_visit_logged` alone — 85 rows
    //      nationally — so 23 of 24 provinces read exactly 0,0 and only CABA had
    //      a value (14). A vista over that is a flat map. Widened to every act
    //      that requires a veterinary professional (VET_ACTIVITY_EVENT_TYPES,
    //      shared with the desert layer AND with /gob/analytics, so both
    //      surfaces improved at once) it runs 690,9 (Salta) → 1.997,9 (Mendoza),
    //      all 24 provinces distinct.
    //   2. The POLARITY. This is one of the two layers where a HIGH value is the
    //      GOOD news. The registry has declared it (`higherIsBetter: true`) and
    //      ranking.ts/class-scale.ts have honoured it for a while, but the two
    //      consumer reads dropped it: PanoramaConsole built its rank options
    //      inline and provinceSeqClassScale never passed `invert`. Both now
    //      carry it, so "Peores 10" lists the LEAST-served jurisdictions and the
    //      dark class lands on the lowest rate instead of on the best-served.
    base: "acceso-veterinario",
    // references: the same INSTALLED CAPACITY the desert vista carries — the
    // clinics and shelters an intervention could actually be deployed through.
    // Reference layers are unlimited under F2 and contend for no slot.
    references: ["clinicas", "refugios"],
    level: "province",
    // The layer's own window is a fixed trailing 12 months (temporal: false), so
    // the period selector does not move this map. 90d keeps the board's period
    // consistent with the sibling national vistas and with the reference layers.
    periodPreset: "90d",
    // A cross-province access comparison is a national question — same framing
    // as every other province-choropleth vista.
    framing: { kind: "national" },
    // KNOWN GAP, stated rather than hidden (antiparasitario precedent): there is
    // no `acceso-veterinario` PanoramaKpiId, so this vista cannot headline its
    // own indicator. The two shown are the vet-DELIVERED interventions whose
    // coverage is exactly what veterinary access buys.
    metrics: ["cobertura", "esterilizacion"],
  },
  {
    id: "tendencia",
    label: "Tendencia",
    description: "¿Dónde hay más o menos incidentes que en el período anterior?",
    // base: tendencia (two-window delta choropleth, zero-anchored diverging
    // fill with inverted polarity — more events than before = warning pole).
    //
    // The delta counts INCIDENTS only (PO decision 2026-07-25) — counting all
    // pet_events made registry adoption read as deterioration and painted 24 of
    // 24 provinces at the warning pole. Residual confound, measured and NOT yet
    // fixed: incident reporting also grows with the padrón (23 up / 1 down
    // after the restriction; 18 up / 6 down once normalised per registered
    // pet). Normalising changes the unit from a count delta to a rate delta —
    // pending PO call. See TENDENCIA_INCIDENT_EVENTS.
    base: "tendencia",
    level: "province",
    // 30d vs the prior 30d: the operational trend cadence — long enough to
    // smooth day-of-week noise, short enough that a shift is actionable.
    periodPreset: "30d",
    // A cross-province comparison is a national question — frame the country.
    framing: { kind: "national" },
    // The event families the delta is most often ABOUT — the headline movers.
    metrics: ["mordeduras", "perdidas", "denuncias"],
  },
  {
    // D1 (Hallazgo 2): renamed from `riesgo-ppp` — one letter away from the old
    // `registro-ppp` vista, and "riesgo" overclaimed (it is a reporting cross,
    // not measured epidemiological risk). The id/label now NAME the cross the
    // vista shows. The old id keeps resolving via LEGACY_PRESET_ALIASES.
    id: "cruce-mordeduras-ppp",
    label: "Mordeduras sobre bajo registro PPP",
    description: "¿Dónde se cruzan mordeduras altas con bajo registro PPP?",
    // base: ppp (registry-adoption rate surface). The overlay is mordeduras —
    // a DENSITY layer riding the signal slot via the declared bivariate pair
    // (see the `signal` JSDoc exception; bivariate.ts BIVARIATE_PAIRS).
    base: "ppp",
    signal: "mordeduras",
    // The question is "¿dónde muerden más?" over the registry backdrop — rank
    // by the mordeduras overlay, not the ppp base (brotes-activos precedent).
    rankBy: "mordeduras",
    level: "province",
    periodPreset: "90d",
    // A cross-province risk read — frame the country (brotes-activos precedent).
    framing: { kind: "national" },
    // The two crossed axes + the compliance sibling that shares the Ley Prov
    // 14.107 family with ppp.
    metrics: ["mordeduras", "ppp", "microchip"],
    // The vista OWNS the bivariate encoding — navigating here opens in it (the
    // encoding-seeding rule kept from the a948c975 revert), and the badge stays
    // on this vista while it is selected (?encoding=bivariate round-trips).
    encodings: ["bivariate"],
  },
  {
    id: "indice-territorial",
    label: "Índice territorial",
    description: "¿Qué jurisdicciones están más lejos de cumplir las tres metas a la vez?",
    // base: indice-territorial (0-100 composite). The compliance vista covers
    // one meta at a time (the D1 metric selector);
    // none of its metrics answers "¿quién está peor EN CONJUNTO?", which is the
    // question a national director actually asks before allocating anything.
    // This vista is that synthesis, and it is the layer's first home: it shipped
    // with a loader, a tested computation (lib/analytics/territorial-index.ts)
    // and production call sites, activated by no vista at all.
    //
    // WIRABLE ONLY NOW, and only because the polarity work landed with it: the
    // index is one of the two layers where a HIGH value is GOOD news. Under the
    // old reading it would have ranked the best-governed provinces as "Peores
    // 10" and painted them the dark alarm colour. Declaring its definitional
    // meta of 100 (see the registry entry) puts it on the attainment path the
    // compliance vistas already use — worst gap first, dark = meta cumplida.
    base: "indice-territorial",
    level: "province",
    periodPreset: "90d",
    // A cross-province scorecard only reads with the whole country in frame —
    // same national framing as every other compliance vista.
    framing: { kind: "national" },
    // The three components the score is the mean of — so the operator can see
    // WHICH meta is dragging a province down, instead of only that it is down.
    // Deliberately not a fourth "índice" tile: there is no PanoramaKpiId for it
    // (the same honest gap the antiparasitario vista states), and inventing one
    // here would duplicate the map's own number.
    metrics: ["cobertura", "esterilizacion", "microchip"],
  },
] as const;

/**
 * Preset auto-activated on a FIRST visit to the console (bare URL, no explicit
 * board params, no saved board) — the landing must answer "¿dónde estamos mal?"
 * instead of showing an orphan default layer with a generic reading.
 *
 * `bienestar` is the pick: QA histórico 2026-07-08 found the previous default
 * `cumplimiento` (base cobertura, the antirrábica RATE) paints an EMPTY map
 * ("Sin datos para esta capa en tu cobertura") — the rabies-coverage rate needs
 * a population of vaccinated pets that this build's cobertura data doesn't yet
 * supply, so the operator's very first panorama load was a blank choropleth
 * (reported 3× across QA rounds). `bienestar` (base denuncias, welfare-report
 * density) is the proven-populated layer that reliably draws with divisions, so
 * the first paint shows data. When cobertura data is backfilled, `cumplimiento`
 * can be reinstated as the flagship default.
 */
export const DEFAULT_PANORAMA_PRESET_ID: PresetId = "bienestar";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the ordered list of layer ids this preset activates:
 *   [base, signal (if any), ...references (if any)]
 *
 * The order matches the activation sequence used by `onPreset` in
 * PanoramaConsole so that F2 compatibility checks pass at each step
 * (base first, then signal, then unlimited references).
 */
export function presetLayerIds(p: PanoramaPreset): LayerId[] {
  return presetLayerIdsWithBase(p, p.base);
}

/**
 * The layer set a preset activates with a SUBSTITUTED base — the D1 metric
 * selector's contract: an option (or a legacy alias) swaps the base while the
 * preset's signal/references ride along unchanged.
 */
export function presetLayerIdsWithBase(p: PanoramaPreset, base: LayerId): LayerId[] {
  return [base, ...(p.signal ? [p.signal] : []), ...(p.references ?? [])];
}

/**
 * D1 preset merge — the ids retired on 2026-08-15 keep RESOLVING forever
 * (saved boards, shared links, bookmarks, /gob deep links). Each maps to its
 * surviving preset; a `base` override reconstructs the metric the old vista
 * showed, so a bare legacy `?preset=` link seeds the SAME map it always did —
 * silent metric loss (resolving the id but dropping its layers) is the failure
 * mode this table exists to prevent.
 */
export const LEGACY_PRESET_ALIASES: Readonly<Record<string, { id: PresetId; base?: LayerId }>> = {
  "registro-ppp": { id: "cumplimiento", base: "ppp" },
  "control-poblacional": { id: "cumplimiento", base: "esterilizacion" },
  microchip: { id: "cumplimiento", base: "microchip" },
  antiparasitario: { id: "cumplimiento", base: "antiparasitario" },
  "riesgo-ppp": { id: "cruce-mordeduras-ppp" },
};

/**
 * Look up a preset by id. Returns undefined if not found.
 *
 * Accepts a LEGACY alias id too (LEGACY_PRESET_ALIASES) and resolves it to its
 * surviving preset — every call site that only needs the preset OBJECT gets
 * alias resolution for free. NOTE: the returned preset carries the CANONICAL
 * id (an alias's `p.id` differs from the raw id passed in), and an alias's
 * base override is NOT applied here — a caller that needs the legacy LAYER SET
 * must use {@link resolveLegacyPreset}.
 */
export function getPreset(id: PresetId | (string & {})): PanoramaPreset | undefined {
  const canonical = LEGACY_PRESET_ALIASES[id]?.id ?? (id as PresetId);
  return PANORAMA_PRESETS.find((p) => p.id === canonical);
}

/**
 * Resolve a raw `?preset=` value (canonical OR legacy) to its preset AND the
 * layer set that value has always meant. For a canonical id this is exactly
 * `presetLayerIds(preset)`; for a legacy alias the base override is applied
 * (alias base ∪ parent signal/references), so `?preset=control-poblacional`
 * still seeds `esterilizacion` — never the merged preset's default cobertura.
 */
export function resolveLegacyPreset(
  rawId: string,
): { preset: PanoramaPreset; layerIds: LayerId[] } | undefined {
  const preset = getPreset(rawId);
  if (!preset) return undefined;
  const base = LEGACY_PRESET_ALIASES[rawId]?.base ?? preset.base;
  return { preset, layerIds: presetLayerIdsWithBase(preset, base) };
}

/**
 * The period preset the DEFAULT landing preset activates — i.e. the window the
 * console actually requests on an admin's first visit (bare URL → the default
 * preset auto-activates and commits its periodPreset).
 *
 * The KPI cube builder builds at THIS window (QA fix 7: it used to build at
 * the 3y PANORAMA_DEFAULT_PRESET while the landing requested the default
 * preset's 90d, so the period gate in loadPanoramaKpisFromCube never matched
 * and every admin first visit paid the live 20-query fan-out). Deriving it
 * here keeps builder and landing single-sourced: change
 * DEFAULT_PANORAMA_PRESET_ID (or its periodPreset) and the cube follows.
 */
export function defaultPanoramaPresetPeriod(): PanoramaPreset["periodPreset"] {
  const preset = getPreset(DEFAULT_PANORAMA_PRESET_ID);
  if (!preset) {
    // Structurally unreachable (presets.test.ts pins the default id resolves);
    // throwing keeps the cube build honest instead of silently mis-windowing.
    throw new Error(`DEFAULT_PANORAMA_PRESET_ID "${DEFAULT_PANORAMA_PRESET_ID}" has no preset`);
  }
  return preset.periodPreset;
}
