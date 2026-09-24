// Panorama layer registry — pure, declarative (spec §4 / §13.5).
//
// Adding a layer is declarative: one entry here. The infrastructure repository
// switches on `source` to load features; the LayerPanel renders this list as
// the legend (color + label). NO @/db / next imports (domain purity).

import { TARGETS } from "@/lib/metrics/targets";

import type { AggregationLevel, LayerDataType, LayerId, PanoramaLayer } from "./types";

// Re-export so callers that need the taxonomy do not also import from types.ts.
export type { LayerDataType };

// --- panorama-ia-v2 descriptor extension (design §2.3) -----------------------

/** Unit noun per level — shared by every layer's caption (es-AR). */
const UNIT: Record<AggregationLevel, string> = {
  province: "provincia",
  locality: "localidad",
};

/**
 * Unit noun for the layers whose detail tier aggregates + k-anon-suppresses at the
 * administrative DIVISION (PO "Option A"): the departamento/partido everywhere, the
 * barrio in CABA. Used by BOTH the division-fill choropleths (departamento polygon)
 * AND the folded aggregated-point layers (perdidas/mordeduras/denuncias/zoonosis/
 * sintomas/reunificacion — one graduated symbol per department centroid). The old shared
 * `UNIT.locality = "localidad"` mislabeled that tier ("es una localidad") while the
 * unit under it was a department. A feminine noun ("división") keeps the caption
 * template's "es una {unit}" grammar correct; the parenthetical names the concrete
 * unit at each scope.
 */
const UNIT_DIVISION: Record<AggregationLevel, string> = {
  province: "provincia",
  locality: "división (departamento/partido, o barrio en CABA)",
};

/**
 * Nacional overview forces the province mark below the locality camera threshold
 * (design §3.1 render-policy — kills the "green blob"). Z_LOCALITY ≈ 5.
 */
const AUTO_PROVINCE = { belowZoom: 5, level: "province" as const };

/**
 * v1 layer catalogue. Colors are a colorblind-distinguishable categorical set
 * (the layer list is the legend). Privacy follows spec §8: denuncias is
 * `coarse` (locality centroid only); everything else is `none` (public opt-in
 * data, operational data the operator is cleared for, or k-anon rollups).
 */
export const PANORAMA_LAYERS: readonly PanoramaLayer[] = [
  // --- point / cluster ---
  {
    id: "perdidas",
    label: "Pérdidas / avistajes",
    description:
      "Reportes de mascotas perdidas y avistajes en el período, agregados por unidad (localidad o departamento).",
    geomType: "point",
    source: "pet_events:lost",
    color: "#e15759",
    scopeFilterable: true,
    privacy: "none",
    temporal: true,
    // Lost/sighting events — event density, aggregated by unit in F1.
    dataType: "density",
    renderPolicy: {
      province: "graduated-symbol",
      locality: "graduated-symbol",
      autoLevel: AUTO_PROVINCE,
      // panorama-event-points Slice 1 (design D3/D5): at street zoom inside a
      // jurisdiction, perdidas swaps its count-bubbles for REAL sighting dots,
      // rendered through the shared clustered-points path.
      points: "clustered-points",
    },
    suppressionStyle: "muted",
    caption: { unit: UNIT_DIVISION, measure: "reportes de mascotas perdidas", window: "period" },
  },
  {
    id: "mordeduras",
    label: "Mordeduras / antirrábica",
    description:
      "Eventos de mordedura registrados en el período (insumo de vigilancia antirrábica), agregados por unidad.",
    geomType: "point",
    source: "pet_events:bite",
    color: "#f28e2b",
    scopeFilterable: true,
    privacy: "none",
    temporal: true,
    // Bite incident events — event density, aggregated by unit in F1.
    dataType: "density",
    renderPolicy: {
      province: "graduated-symbol",
      locality: "graduated-symbol",
      autoLevel: AUTO_PROVINCE,
      // panorama-event-points Slice 2: at street zoom INSIDE the operator's
      // jurisdiction, mordeduras swaps its count-bubbles for REAL incident-location
      // dots (the operator already sees these cases in /gob/vigilancia — no new
      // disclosure; scope-bound server-side by petsScope). Aggregated outside scope.
      points: "clustered-points",
    },
    suppressionStyle: "muted",
    caption: {
      unit: UNIT_DIVISION,
      measure: "eventos de mordedura / antirrábica",
      window: "period",
    },
  },
  {
    id: "denuncias",
    label: "Denuncias de bienestar",
    description:
      "Denuncias de bienestar animal activas en el período, ubicadas por localidad (centroide) — nunca la ubicación exacta de la denuncia.",
    geomType: "point",
    source: "welfare_reports",
    color: "#b07aa1",
    scopeFilterable: true,
    privacy: "coarse",
    temporal: true,
    // Welfare report events — event density, aggregated by unit in F1.
    dataType: "density",
    renderPolicy: {
      province: "graduated-symbol",
      locality: "graduated-symbol",
      autoLevel: AUTO_PROVINCE,
      // panorama-event-points Slice 3: at street zoom, denuncias render at the
      // LOCALITY CENTROID only — a coarser dot that NEVER exposes the exact
      // report coordinate (anonymous-reporter protection; the exact
      // welfare_reports.location_lat/lng is never SELECTed — loadDenunciaCentroids
      // snaps to the ar_localities centroid). Privacy floor stays coarse.
      points: "clustered-points",
    },
    suppressionStyle: "muted",
    caption: { unit: UNIT_DIVISION, measure: "denuncias de bienestar", window: "period" },
  },
  {
    id: "zoonosis",
    label: "Zoonosis / señales",
    description:
      "Señales de vigilancia zoonótica (rabia, leptospirosis, hidatidosis) activas en el período, agregadas por unidad.",
    geomType: "point",
    source: "outbreak_signals",
    color: "#9c755f",
    scopeFilterable: true,
    privacy: "none",
    temporal: true,
    // Public-health surveillance signals — aggregated by unit in F1.
    dataType: "signal",
    renderPolicy: {
      province: "graduated-symbol",
      locality: "graduated-symbol",
      autoLevel: AUTO_PROVINCE,
    },
    suppressionStyle: "muted",
    caption: { unit: UNIT_DIVISION, measure: "señales de zoonosis", window: "period" },
  },
  {
    id: "sintomas",
    label: "Síntomas / vigilancia sindrómica",
    description:
      "Síntomas reportados en el período (vigilancia sindrómica temprana), agregados por unidad.",
    geomType: "point",
    source: "pet_events:symptom",
    color: "#edc948",
    scopeFilterable: true,
    privacy: "none",
    temporal: true,
    // Symptom-report events — event density, aggregated by unit in F1.
    dataType: "density",
    renderPolicy: {
      province: "graduated-symbol",
      locality: "graduated-symbol",
      autoLevel: AUTO_PROVINCE,
    },
    suppressionStyle: "muted",
    caption: { unit: UNIT_DIVISION, measure: "síntomas reportados", window: "period" },
  },
  {
    id: "reunificacion",
    // Not summable: per-unit value is a reunification RATE (0-100), not a row count.
    valueKind: "rate",
    label: "Reunificación",
    description:
      "Porcentaje de episodios de pérdida reencontrados con su familia en el período, por unidad (el tamaño del símbolo es la tasa).",
    geomType: "point",
    source: "metrics:reunification",
    // NOT the stash's #59a14f — that collides with cobertura's green.
    color: "#86bcb6",
    scopeFilterable: true,
    privacy: "none",
    temporal: true,
    // Reunification rate per unit — graduated symbol size encodes ratePct (0–100).
    dataType: "signal",
    renderPolicy: {
      province: "graduated-symbol",
      locality: "graduated-symbol",
      autoLevel: AUTO_PROVINCE,
    },
    suppressionStyle: "muted",
    caption: { unit: UNIT_DIVISION, measure: "tasa de reunificación", window: "period" },
  },
  {
    id: "refugios",
    label: "Refugios",
    description:
      "Refugios y organizaciones registradas — directorio actual (ubicación puntual), no es un conteo de eventos del período.",
    geomType: "point",
    source: "organizations:shelter",
    color: "#4e79a7",
    scopeFilterable: true,
    privacy: "none",
    // No time dimension — shelters are a current directory, not an event stream.
    temporal: false,
    // Individual shelter locations — NEVER aggregated (each is a distinct entity).
    dataType: "reference",
    // Reference: pins at every level, ignores autoLevel; suppression is a no-op.
    renderPolicy: { province: "clustered-points", locality: "clustered-points" },
    suppressionStyle: "muted",
    caption: { unit: UNIT, measure: "refugios registrados", window: "current" },
  },
  {
    id: "clinicas",
    label: "Clínicas veterinarias",
    description:
      "Clínicas veterinarias verificadas y registradas — directorio actual (ubicación puntual), no es un conteo de eventos del período.",
    geomType: "point",
    source: "organizations:clinic",
    // Distinct violet — must not read as refugios (#4e79a7 blue) or decomisos
    // (#76b7b2 teal), the reference pins it can share the map with.
    color: "#8b5fbf",
    scopeFilterable: true,
    privacy: "none",
    // No time dimension — clinics are a current directory, not an event stream.
    temporal: false,
    // Individual clinic locations — NEVER aggregated (each is a distinct entity).
    dataType: "reference",
    // Reference: pins at every level, ignores autoLevel; suppression is a no-op.
    renderPolicy: { province: "clustered-points", locality: "clustered-points" },
    suppressionStyle: "muted",
    caption: { unit: UNIT, measure: "clínicas veterinarias verificadas", window: "current" },
  },
  {
    id: "decomisos",
    label: "Decomisos",
    description:
      "Expedientes de decomiso en el período — cada punto es un caso (ubicación puntual del expediente).",
    geomType: "point",
    source: "cases:decomiso",
    color: "#76b7b2",
    scopeFilterable: true,
    privacy: "none",
    temporal: true,
    // Individual decomiso expedientes — NEVER aggregated (each is a distinct case).
    dataType: "reference",
    // Reference: pins at every level, ignores autoLevel; suppression is a no-op.
    renderPolicy: { province: "clustered-points", locality: "clustered-points" },
    suppressionStyle: "muted",
    caption: { unit: UNIT, measure: "decomisos", window: "period" },
  },
  // --- choropleth (locality rollups via lib/metrics) ---
  {
    id: "esterilizacion",
    label: "Cobertura de esterilización",
    // Claim #3 — drilled division fill paints raw counts, not the rate;
    // "Cobertura" would misname a headcount as a percentage.
    countLabel: "Esterilizaciones",
    description:
      "Mascotas activas con esterilización registrada sobre el total de la unidad (meta 70% · control poblacional).",
    geomType: "choropleth",
    source: "metrics:sterilization-coverage",
    color: "#af7aa1",
    scopeFilterable: true,
    privacy: "none",
    // CURRENT-STATE rollup (EXISTS sterilization_performed) — not event-windowed in v1.
    temporal: false,
    // Coverage rate — rendered as choropleth via divergent scale at complianceTarget.
    dataType: "rate",
    // F5: divergent choropleth anchored at the esterilización programmatic benchmark (70%).
    // Province-level rendering anchors the divergent scale at this percentage value.
    // V1 locality level shows count-density (see repository.ts — rate-by-locality deferred).
    complianceTarget: TARGETS.STERILIZATION_COVERAGE_PCT,
    // Rate: fill at both levels (locality fill needs polygons — Fase 2; P0 renders
    // an interim divergent graduated-symbol, §2.3 footnote 1). Suppressed → hatched.
    renderPolicy: {
      province: "choropleth-fill",
      locality: "choropleth-fill",
      autoLevel: AUTO_PROVINCE,
    },
    suppressionStyle: "hatched",
    caption: { unit: UNIT_DIVISION, measure: "cobertura de esterilización", window: "current" },
  },
  {
    id: "microchip",
    label: "Penetración microchip (C1)",
    // Claim #3 — drilled division fill paints raw counts, not the rate.
    countLabel: "Mascotas con microchip",
    description:
      "Mascotas activas con microchip ISO activo sobre el total de la unidad (Ley Prov 14.107 · meta 80%).",
    geomType: "choropleth",
    source: "metrics:microchip-penetration",
    // NOT the stash's #4e79a7 — that collides with refugios' blue.
    color: "#a0cbe8",
    scopeFilterable: true,
    privacy: "none",
    // CURRENT-STATE rollup (EXISTS active microchip_iso) — not event-windowed in v1.
    temporal: false,
    dataType: "rate",
    // F5: divergent choropleth anchored at the microchip programmatic benchmark.
    complianceTarget: TARGETS.MICROCHIP_PENETRATION_PCT,
    renderPolicy: {
      province: "choropleth-fill",
      locality: "choropleth-fill",
      autoLevel: AUTO_PROVINCE,
    },
    suppressionStyle: "hatched",
    caption: { unit: UNIT_DIVISION, measure: "penetración de microchip", window: "current" },
  },
  {
    id: "ppp",
    label: "Registro PPP (C7)",
    // Claim #3 — drilled division fill paints raw counts, not the rate.
    countLabel: "Atestaciones PPP",
    description:
      "Perros potencialmente peligrosos registrados sobre el total estimado de la unidad (Ley Prov 14.107 · benchmark 80%).",
    geomType: "choropleth",
    source: "metrics:ppp-compliance",
    color: "#ff9da7",
    scopeFilterable: true,
    privacy: "none",
    temporal: false,
    dataType: "rate",
    // Ley Prov 14.107 sets no universal % target for the dangerous-breed
    // registry; 80 is the program benchmark (mirrors the microchip/rabies
    // benchmark), not a legal mandate — no TARGETS const exists for this yet.
    complianceTarget: 80,
    renderPolicy: {
      province: "choropleth-fill",
      locality: "choropleth-fill",
      autoLevel: AUTO_PROVINCE,
    },
    suppressionStyle: "hatched",
    caption: { unit: UNIT_DIVISION, measure: "registro PPP", window: "current" },
  },
  {
    id: "cobertura",
    label: "Cobertura antirrábica (perros, 12m)",
    // Claim #3 (cursor red-team 2026-07-23) — the drilled division fill sums
    // raw vaccinated-dog COUNTS per barrio/departamento (e.g. 6→235), not a
    // percentage. Rendering "Cobertura antirrábica … (conteo)" over that
    // scale reads as a coverage rate with a footnote; "cobertura" itself must
    // drop once the paint is a headcount, not a rate.
    countLabel: "Vacunaciones antirrábicas",
    description:
      "Perros del padrón con vacuna antirrábica en los últimos 12 meses sobre el total, por unidad (Ley 22.953 · meta 80%).",
    geomType: "choropleth",
    source: "metrics:rabies-coverage",
    color: "#59a14f",
    scopeFilterable: true,
    privacy: "none",
    // CURRENT-STATE rollup (EXISTS vaccination) — not event-windowed in v1.
    temporal: false,
    // Coverage rate — rendered as choropleth, NOT via the point-aggregation path.
    dataType: "rate",
    // F5: divergent choropleth anchored at the antirrábica legal target (80%).
    // get-panorama-kpis.ts uses coverage.target (also 80) from fetchRabiesCoverage.
    complianceTarget: 80,
    // Rate: fill at both levels (locality fill needs polygons — Fase 2; P0 renders
    // an interim divergent graduated-symbol, §2.3 footnote 1). Suppressed → hatched.
    renderPolicy: {
      province: "choropleth-fill",
      locality: "choropleth-fill",
      autoLevel: AUTO_PROVINCE,
    },
    suppressionStyle: "hatched",
    caption: { unit: UNIT_DIVISION, measure: "cobertura antirrábica", window: "current" },
  },
  {
    id: "mortalidad",
    label: "Mortalidad / disposición",
    description:
      "Mascotas con estado 'fallecida' registrado y su disposición, por unidad (estado actual, no ventana temporal).",
    geomType: "choropleth",
    source: "metrics:mortality",
    color: "#bab0ac",
    scopeFilterable: true,
    privacy: "none",
    // CURRENT-STATE rollup (pets.status='deceased') — not event-windowed in v1.
    temporal: false,
    // Mortality density — rendered as choropleth, NOT via the point-aggregation path.
    dataType: "density",
    // Province fill; no locality polygon → graduated symbol when scoped in (§2.3²).
    renderPolicy: {
      province: "choropleth-fill",
      locality: "graduated-symbol",
      autoLevel: AUTO_PROVINCE,
    },
    suppressionStyle: "hatched",
    caption: { unit: UNIT_DIVISION, measure: "mortalidad registrada", window: "current" },
  },
  {
    id: "acceso-veterinario",
    // Not summable: per-unit value is visits per 1.000 active pets, not a row count.
    valueKind: "rate",
    // POLARITY: more veterinary acts = better access. One of only two layers in
    // this registry where the sequential ramp and the "Peores N" ranking must
    // run BACKWARDS (see PanoramaLayer.higherIsBetter). No `complianceTarget`:
    // the annual antirrábica booster implies a floor of ~1.000 actos/1.000
    // mascotas, but classing the map on a target the whole country sits far
    // below collapses it into a single class — the saturation defect this layer
    // exists to avoid. It stays a QUANTILE sequential layer, which is why the
    // ramp inversion (not a target) is what unblocks it.
    higherIsBetter: true,
    label: "Acceso veterinario (actos/1.000)",
    // The ONLY count-fallback layer in this registry that lacked a countLabel,
    // so the drill-level legend printed the rate title over a count and read
    // "Acceso veterinario (actos/1.000) (conteo) · 5 → 2.184" — a rate and a
    // count in the same sentence (external design review P1-F1). Every sibling
    // rate layer declares what its count actually counts; this one now does too.
    countLabel: "Mascotas con acto veterinario",
    description:
      "Actos veterinarios por cada 1.000 mascotas activas, por unidad — señal de acceso a la atención (los 'desiertos' de atención son las zonas con menos actos). Cuenta consultas, vacunaciones, esterilizaciones, implantes de microchip y registros clínicos; la desparasitación no cuenta, porque es de venta libre. Ventana móvil de 12 meses.",
    geomType: "choropleth",
    source: "metrics:vet-access",
    color: "#b6992d",
    scopeFilterable: true,
    privacy: "none",
    // Trailing-12m access signal (fixed window, like the antirrábica proxy) —
    // rendered as a current-state choropleth, not event-windowed in v1.
    temporal: false,
    // per1k is a magnitude with NO legal/compliance target, so it is a "density"-
    // style layer (sequential fill, no divergent anchor) — like mortalidad. Province
    // paints the per-1.000 rate; locality paints the count of pets with a veterinary
    // act (v1 count-density — the same rate/count asymmetry the sibling rate layers
    // document, since a k-anon'd num/den per department is deferred). Both tiers
    // read the SAME act set (VET_ACTIVITY_EVENT_TYPES, lib/metrics/vet-access).
    dataType: "density",
    renderPolicy: {
      province: "choropleth-fill",
      locality: "choropleth-fill",
      autoLevel: AUTO_PROVINCE,
    },
    suppressionStyle: "hatched",
    caption: {
      unit: UNIT_DIVISION,
      measure: "acceso veterinario (actos/1.000)",
      window: "current",
    },
  },
  {
    id: "antiparasitario",
    label: "Cobertura antiparasitaria (12m)",
    // Claim #3 — drilled division fill paints raw counts, not the rate.
    countLabel: "Desparasitaciones",
    description:
      "Mascotas activas con desparasitación registrada en los últimos 12 meses sobre el total de la unidad — protección periódica (no un hito único).",
    geomType: "choropleth",
    source: "metrics:deworming",
    color: "#499894",
    scopeFilterable: true,
    privacy: "none",
    // Trailing-12m coverage (periodic protection, fixed window) — rendered as a
    // current-state choropleth, not event-windowed in v1.
    temporal: false,
    // Coverage rate — same shape as esterilización (divergent choropleth anchored
    // at the benchmark). Province paints ratePct (fetchDewormingCoverage.byProvince);
    // locality paints count-density (v1 interim).
    dataType: "rate",
    // No legal % mandate exists for antiparasitic deworming; 80 is a program
    // benchmark mirroring the sanitary-coverage peers (rabies/microchip), NOT a
    // legal target — same convention as the ppp layer's benchmark.
    complianceTarget: 80,
    renderPolicy: {
      province: "choropleth-fill",
      locality: "choropleth-fill",
      autoLevel: AUTO_PROVINCE,
    },
    suppressionStyle: "hatched",
    caption: {
      unit: UNIT_DIVISION,
      measure: "cobertura antiparasitaria",
      window: "current",
    },
  },
  {
    id: "tendencia",
    // Not summable: per-unit value is a SIGNED delta vs the previous window.
    valueKind: "delta",
    label: "Tendencia de eventos (Δ vs período anterior)",
    description:
      "Variación de INCIDENTES por provincia: el período elegido contra el período equivalente inmediatamente anterior (Δ = actual − anterior). Cuenta mordeduras, señales de zoonosis y enfermedades reportadas — no los altos, vacunaciones ni esterilizaciones, cuyo crecimiento es adopción del registro y no deterioro. Aviso: el reporte de incidentes TAMBIÉN crece con el padrón, así que un aumento sigue pudiendo reflejar más cobertura del sistema; leer el signo junto con la evolución del padrón.",
    geomType: "choropleth",
    source: "metrics:tendencia",
    // Slate indigo — distinct from refugios' blue (#4e79a7) and microchip's
    // pale blue (#a0cbe8), its nearest legend neighbours.
    color: "#647acb",
    scopeFilterable: true,
    privacy: "none",
    // Two event windows derived from the period (and shifted by asOf) —
    // replayable "as of t" like the other pet_events-backed layers.
    temporal: true,
    // A signed delta magnitude — no attainment target, so NOT "rate"/meta.
    dataType: "density",
    // Zero-anchored diverging fill with INVERTED polarity (more events than
    // before = warning pole) — see PanoramaLayer.deltaEncoded.
    deltaEncoded: true,
    renderPolicy: {
      province: "choropleth-fill",
      locality: "choropleth-fill",
      autoLevel: AUTO_PROVINCE,
    },
    suppressionStyle: "hatched",
    // PROVINCE-GRAIN v1 (PROVINCE_ONLY_CHOROPLETH_IDS): a department-grain
    // delta needs complementary suppression over published department totals
    // (deltaCells' render contract) — deferred with the other locality
    // asymmetries. Unit reads "provincia" at both bands.
    caption: {
      unit: { province: "provincia", locality: "provincia" },
      measure: "variación de eventos registrados vs. el período anterior",
      window: "period",
    },
  },
  {
    id: "desierto-veterinario",
    // Not summable: per-unit value is a PERCENTAGE of the unit's active pets.
    valueKind: "rate",
    //
    // WHAT THIS LAYER MEASURES, AND WHY IT CHANGED (PO decision, 2026-07-26).
    //
    // It used to be "days since the last veterinary act anywhere in the
    // province", right-censored at the window length. That statistic is a MAX
    // over thousands of pets, so it pins to whichever pole the event volume
    // implies and CANNOT discriminate at province grain — no predicate fixes
    // that. Measured with `vet_visit_logged` alone, 23 of 24 provinces sat
    // exactly at the 90-day cap (a false alarm); measured with the full act set
    // (VET_ACTIVITY_EVENT_TYPES), 20 sat at 0 days and 4 at 1 (a false
    // reassurance — the more dangerous of the two on a government console).
    //
    // The base statistic is now the SHARE OF ACTIVE PETS WITH NO VETERINARY ACT
    // IN THE PERIOD — a coverage-of-attention measure, not a duration. Measured
    // over 90 days it runs 24,6% (Mendoza) → 80,7% (Salta) with all 24
    // provinces distinct and the expected geography; over 12 months, 6,0% →
    // 47,8%. See loadVetDesertByProvince for the computation.
    //
    // NO `censoredAtMax`. The old cap was declared because "90" meant "we
    // stopped looking", not "90 days elapsed". A share is bounded at 100 BY
    // CONSTRUCTION and 100% is a genuine measurement ("ninguna mascota activa
    // recibió atención"), so there is nothing to censor and nothing for the
    // legend or the ranking to disclaim. The field is deliberately absent, not
    // translated to 100.
    //
    // POLARITY: higher IS worse (more pets unattended), which is the registry
    // default — so `higherIsBetter` stays absent here, unlike its sibling
    // `acceso-veterinario`, where a high value is the good news.
    // "registrada" is not padding: it is the layer's own honesty note, which the
    // description spells out ("la ausencia de registro no implica ausencia de
    // atención") and the domain caption already carries. The label — the most
    // read line of the three — was the one overclaiming (P1-F2).
    label: "Desierto veterinario (% sin atención registrada)",
    // Found by widening the countLabel fence to rate-VALUED layers (P1-F1): the
    // drill fallback paints a headcount, so it needs a name that is a headcount.
    // "Sin atención registrada", not "sin atención" — the layer's own
    // description is careful that absence of record is not absence of care, and
    // the legend must not undo that in four words.
    countLabel: "Mascotas sin atención registrada",
    description:
      "Porcentaje de mascotas activas SIN ningún acto veterinario registrado en miMAR durante el período, por provincia — consulta, vacunación, esterilización, implante de microchip o registro clínico (la desparasitación no cuenta: es de venta libre y se aplica en casa). Mide cobertura de atención, no distancia a un veterinario: la ausencia de registro no implica ausencia de atención.",
    geomType: "choropleth",
    source: "metrics:vet-desert",
    // Dark sienna — distinct from acceso-veterinario's mustard (#b6992d) and
    // zoonosis' brown (#9c755f), the layers it is most likely to be compared with.
    color: "#8a4f2d",
    scopeFilterable: true,
    privacy: "none",
    // Period-windowed coverage share (acts inside [since, asOf]) — replayable
    // "as of t", unlike the current-state rollups. The window is a REAL floor
    // here: the recency framing this replaces had none.
    temporal: true,
    // Routed as a "density" layer even though the value is a percentage: the
    // `dataType` axis decides the AGGREGATION/loader path, and F5 requires every
    // `dataType: "rate"` layer to declare a `complianceTarget`. There is no
    // defensible "meta de mascotas sin atención" to declare — inventing one
    // would class the map on policy fiction, and any plausible number would put
    // the whole country in one class, re-creating the saturation this reshaping
    // exists to escape. The percentage nature is declared where it is actually
    // consumed: `valueKind: "rate"` (summability) and the caption measure.
    // Same split indice-territorial documents for its 0-100 score.
    dataType: "density",
    renderPolicy: {
      province: "choropleth-fill",
      locality: "choropleth-fill",
      autoLevel: AUTO_PROVINCE,
    },
    suppressionStyle: "hatched",
    // PROVINCE-GRAIN v1 (PROVINCE_ONLY_CHOROPLETH_IDS): a department-grain share
    // needs a k-anon'd per-department pet universe — deferred, same v1 asymmetry
    // the rate layers document. Unit reads "provincia" at both bands so the
    // caption stays honest (indice-territorial precedent).
    caption: {
      unit: { province: "provincia", locality: "provincia" },
      measure: "% de mascotas activas sin atención veterinaria registrada",
      window: "period",
    },
  },
  {
    id: "indice-territorial",
    // Not summable: per-unit value is a 0-100 composite index.
    valueKind: "index",
    // POLARITY: a higher score is a better-performing territory.
    higherIsBetter: true,
    // ATTAINMENT TARGET — definitional, not invented. The score is the mean of
    // `targetAttainment(rate, target) = min(100, rate/target*100)` over the
    // antirrábica / esterilización / microchip metas (lib/analytics/
    // territorial-index.ts), so 100 means exactly "las tres metas cumplidas" and
    // is reachable by construction. Declaring it is what makes the layer READ
    // correctly today: the ranking orders by the gap to 100 (worst attainment
    // first, with the same "−N pts" chip the compliance vistas show) and the
    // fill takes the META path, where the dark class is the met meta — the same
    // reading as cobertura/microchip, instead of the sequential family's
    // "dark = more of a bad thing".
    complianceTarget: 100,
    label: "Índice territorial (0-100)",
    description:
      "Índice compuesto por provincia (0-100): media del cumplimiento de metas de antirrábica, esterilización y microchip. Puntúa territorios, nunca personas.",
    geomType: "choropleth",
    source: "metrics:territorial-index",
    color: "#d7b5a6",
    scopeFilterable: true,
    privacy: "none",
    temporal: false,
    // Stays "density" for AGGREGATION routing: dataType decides which loader and
    // which per-unit path the layer takes, and this is not a rate over a
    // population — it is a composite score the index computation hands over
    // ready-made. What it is NOT is a no-target magnitude: the `complianceTarget`
    // above carries the attainment reading (fill + ranking), which is a separate
    // axis from the routing one. Superseded note: this comment used to say the
    // layer had "no external compliance target to anchor" — true of an EXTERNAL
    // one, wrong about its own definitional 100.
    dataType: "density",
    // PROVINCE-ONLY by design: computeJurisdictionIndex scores ≤24 provinces and
    // has no locality/department grain, so BOTH render levels fill the province
    // polygon (the loader always returns province cells regardless of `level`).
    // No k-anon hatch is possible or needed here — fetchCrossJurisdictionOutliers
    // already drops <5-pet provinces entirely upstream, so a suppressed province
    // simply has no cell (reads as no-data), never a hatch.
    renderPolicy: {
      province: "choropleth-fill",
      locality: "choropleth-fill",
      autoLevel: AUTO_PROVINCE,
    },
    suppressionStyle: "muted",
    // Province-grain at every level → the unit reads "provincia" in both bands
    // (the layer never aggregates to a locality), so the caption stays honest.
    caption: {
      unit: { province: "provincia", locality: "provincia" },
      measure: "índice territorial (0-100)",
      window: "current",
    },
  },
] as const;

const LAYER_BY_ID: ReadonlyMap<LayerId, PanoramaLayer> = new Map(
  PANORAMA_LAYERS.map((layer) => [layer.id, layer]),
);

export function getLayer(id: LayerId): PanoramaLayer | undefined {
  return LAYER_BY_ID.get(id);
}

/** Type guard for an arbitrary string (e.g. a route param /api/panorama/[layer]). */
export function isLayerId(value: string): value is LayerId {
  return LAYER_BY_ID.has(value as LayerId);
}

export const POINT_LAYERS: readonly PanoramaLayer[] = PANORAMA_LAYERS.filter(
  (l) => l.geomType === "point",
);

export const CHOROPLETH_LAYERS: readonly PanoramaLayer[] = PANORAMA_LAYERS.filter(
  (l) => l.geomType === "choropleth",
);

/** Layers that can be reconstructed "as of t" — the TimeScrubber refetches these
 * with `asOf`. Non-temporal layers (refugios + the current-state choropleths) are
 * dimmed while a scrub is active instead of showing stale data as if it were as-of-t. */
export const TEMPORAL_LAYERS: readonly PanoramaLayer[] = PANORAMA_LAYERS.filter((l) => l.temporal);

/** True when the layer is event-windowable in time (F4 temporal reproduction). */
export function isTemporalLayer(id: LayerId): boolean {
  return LAYER_BY_ID.get(id)?.temporal ?? false;
}

// ---------------------------------------------------------------------------
// F1 data-type taxonomy helpers (Panorama v2).
// ---------------------------------------------------------------------------

/**
 * Point layers whose events are AGGREGATED per administrative unit in F1.
 * These are the density (perdidas, mordeduras, denuncias) and signal (zoonosis)
 * layers. They do NOT include reference layers (refugios, decomisos) — those
 * always render as discrete pins.
 */
export const AGGREGATED_POINT_LAYERS: readonly PanoramaLayer[] = PANORAMA_LAYERS.filter(
  (l) => l.geomType === "point" && (l.dataType === "density" || l.dataType === "signal"),
);

/** Ids of the density+signal point layers, for fast membership tests. */
export const AGGREGATED_POINT_IDS: ReadonlySet<LayerId> = new Set(
  AGGREGATED_POINT_LAYERS.map((l) => l.id),
);

/**
 * Reference point layers — individual locations/expedientes that are NEVER
 * aggregated (refugios, decomisos). Their discrete-pin rendering is unchanged.
 */
export const REFERENCE_LAYERS: readonly PanoramaLayer[] = PANORAMA_LAYERS.filter(
  (l) => l.geomType === "point" && l.dataType === "reference",
);

/** True for density/signal point layers that F1 aggregates per unit. */
export function isAggregatedPointLayer(id: LayerId): boolean {
  return AGGREGATED_POINT_IDS.has(id);
}

/**
 * panorama-event-points (design D5): ids of the layers that swap to REAL
 * event-location dots at near zoom (renderPolicy.points set). P4b: the CLIENT no
 * longer reads this — the console resolves the live LOD band from the capability
 * gate's `representationPerZoom` (`markForZoom`, capabilities.ts). This set
 * remains as the SERVER-side gate's derived view of the same declaration
 * (get-layer-features re-derives points mode independently of the client).
 */
export const POINTS_LAYER_IDS: ReadonlySet<LayerId> = new Set(
  PANORAMA_LAYERS.filter((l) => l.renderPolicy.points != null).map((l) => l.id),
);

/** True when the layer renders real event-location dots in near-zoom points mode. */
export function isPointsLayer(id: LayerId): boolean {
  return POINTS_LAYER_IDS.has(id);
}

/**
 * Choropleth layers whose loader is PROVINCE-GRAIN and ignores `level` — they
 * always paint province polygons regardless of zoom (their metric has no
 * locality/department grain). indice-territorial is one: computeJurisdictionIndex
 * scores ≤24 provinces. These must NOT drive the zoom→department LOD flip, or the
 * aggregation badge/caption would claim "Departamentos" while the map still paints
 * provinces (a label≠map lie). Add any future province-only choropleth here.
 */
export const PROVINCE_ONLY_CHOROPLETH_IDS: ReadonlySet<LayerId> = new Set<LayerId>([
  "indice-territorial",
  // Vet-desert recency: no k-anon'd per-department pet universe in v1 (see the
  // registry entry) — the loader always returns province cells.
  "desierto-veterinario",
  // Two-window delta: department grain needs complementary suppression over
  // published totals (deltaCells render contract) — province cells only in v1.
  "tendencia",
]);

/** True when the choropleth is province-grain only (never disaggregates to departments). */
export function isProvinceOnlyChoropleth(id: LayerId): boolean {
  return PROVINCE_ONLY_CHOROPLETH_IDS.has(id);
}

/**
 * Point/signal layers that render DEPARTMENT grain even at the NATIONAL overview
 * (the level="province" request), instead of ONE fixed graduated symbol per
 * province. This is the structural INVERSE of PROVINCE_ONLY_CHOROPLETH_IDS: those
 * never disaggregate below the province; these disaggregate to the department even
 * at the coarsest (national) request.
 *
 * PO decision (2026-07-16): the zoonosis surveillance layer opens the national
 * vista at DEPARTMENT grain — urban departments (capitales / centros urbanos)
 * naturally get medium circles, the rest small and distributed — because a single
 * province dot hides WHERE the signal actually concentrates. There are ~500
 * departments nationally, well under PER_LAYER_CAP=2000.
 *
 * WHY a per-layer declaration and not the shared `level` axis: the data grain is a
 * PER-LAYER property, but the view `level` (resolveDataLevel) is PER-VIEW and shared
 * by every active layer. Flipping the whole view to "locality" at national would drag
 * co-active density layers (perdidas / mordeduras / denuncias / sintomas) to
 * department grain too. Declaring it here, read by BOTH the loader
 * (loadZoonosisByUnit folds to the department at every level) AND the caption
 * (captionFor names the "división" unit), keeps every OTHER layer byte-identical —
 * density layers stay one-point-per-province at national by simply NOT being members.
 *
 * Orthogonal to POINTS_LAYER_IDS: department grain is an AGGREGATION choice, never
 * real event dots. Zoonosis has no `renderPolicy.points` (outbreak_signal writers
 * persist no columnar coordinate), so it is NOT points-capable and never will be
 * from membership here.
 */
export const NATIONAL_DEPARTMENT_GRAIN_IDS: ReadonlySet<LayerId> = new Set<LayerId>(["zoonosis"]);

/** True when the layer renders department grain even at the national (province) overview. */
export function isNationalDepartmentGrain(id: LayerId): boolean {
  return NATIONAL_DEPARTMENT_GRAIN_IDS.has(id);
}

/**
 * Surveillance/risk layers whose TRUE zero is GOOD news (sentiment review #6):
 * "no zoonosis signals in the window" is the outcome the surveillance exists to
 * confirm, so an honest positive framing beats the neutral "sin datos" that
 * reads as a cold-start failure. The registry has no category/kind field for
 * this (dataType "signal" also covers reunificacion, whose zero is BAD), so an
 * explicit allowlist is the declaration: the zoonotic-signal, bite and
 * syndromic-surveillance layers. NEVER consulted for suppressed or degraded
 * empties — the caller's honesty branches take precedence (a k-anon zero is
 * protected data, not good news).
 */
export const SURVEILLANCE_LAYER_IDS: ReadonlySet<LayerId> = new Set<LayerId>([
  "zoonosis",
  "mordeduras",
  "sintomas",
]);

/** True when the layer is a surveillance/risk layer whose true zero is good news. */
export function isSurveillanceLayer(id: LayerId): boolean {
  return SURVEILLANCE_LAYER_IDS.has(id);
}

/** Short display name for a layer — drops the "/ señales" tail so a badge reads
 *  "Zoonosis", not "Zoonosis / señales". Falls back to the raw id. */
export function shortLayerLabel(id: LayerId): string {
  const label = getLayer(id)?.label ?? id;
  return label.split(/[/(]/)[0]?.trim() || label;
}

/**
 * es-AR label for the on-canvas aggregation-grain badge. Announces the grain the
 * MAP MARKS actually draw right now — honest to layers that disaggregate BELOW
 * the shared view `level`.
 *
 * At the national rollup (level="province") most layers draw one mark per
 * province, but NATIONAL_DEPARTMENT_GRAIN layers (zoonosis) draw departments even
 * there. The old badge read the shared `level` alone, so it said "Provincias"
 * while zoonosis painted departments — a label≠map lie (recorrido-80 residual).
 * Decision:
 *   - no finer-grain layer active → the base grain ("Provincias");
 *   - EVERY aggregating layer is finer-grain → name that grain ("Departamentos");
 *   - MIXED (finer-grain layer + a province-grain density/choropleth) → compound,
 *     naming the finer-grain layer, e.g. "Provincias · Zoonosis: departamentos".
 * Reference layers (pins at every level) never establish a grain, so they don't
 * count toward the "province-grain" side of the decision. Below the national
 * rollup the view `level`/province scope already matches every mark, so the base
 * label stands.
 */
export function aggregationBadgeLabel(params: {
  level: AggregationLevel;
  selectedProvinceCode: string | null;
  activeLayerIds: readonly LayerId[];
}): string {
  const { level, selectedProvinceCode, activeLayerIds } = params;

  const baseLabel =
    level === "province"
      ? "Provincias"
      : selectedProvinceCode
        ? selectedProvinceCode === "AR-C"
          ? "Comunas"
          : "Departamentos/partidos"
        : "Localidades";

  // Finer-grain divergence only exists at the national rollup — below it the view
  // level already drives every mark to the same (or a finer-scoped) grain.
  if (level !== "province") return baseLabel;

  const finerLayers = activeLayerIds.filter((id) => isNationalDepartmentGrain(id));
  if (finerLayers.length === 0) return baseLabel;

  // Aggregating layers (density/signal/choropleth) that still draw PROVINCE marks
  // at this level — reference pins don't count (they're individual sites).
  const coarserAggregating = activeLayerIds.filter(
    (id) => !isNationalDepartmentGrain(id) && getLayer(id)?.dataType !== "reference",
  );
  if (coarserAggregating.length === 0) return "Departamentos";

  const finerNames = finerLayers.map(shortLayerLabel).join(", ");
  return `${baseLabel} · ${finerNames}: departamentos`;
}
