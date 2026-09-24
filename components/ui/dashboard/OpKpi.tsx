"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { OpButton } from "@/components/ui/dashboard/OpButton";
import { ProvenanceCard, type ProvenanceContext } from "@/components/ui/dashboard/ProvenanceCard";
import { KPI_CATALOG, type KpiId, formatKpiTarget, getKpiInfo } from "@/lib/metrics/kpi-catalog";
import { isKpiPeriodInvariant } from "@/lib/metrics/kpi-period-invariance";
import {
  DELTA_IMPLAUSIBLE_NOTE,
  DELTA_IMPLAUSIBLE_SUFFIX,
  UNSTABLE_DELTA_BASE_NOTE,
  deltaImplausibleGate,
  guardRatioTone,
  shouldSuppressDelta,
} from "@/lib/metrics/presentation-guards";
import { formatDelta, formatPercent, pluralizeEs } from "@/lib/utils/format";
// OpKpiSm (compact tile) + its tone maps live in their own module (no heavy
// imports) so a caller that only needs the compact tile — e.g. the landing's
// decorative console mock — can import it WITHOUT pulling this whole file's
// metric-contract engine into its bundle (W5c, LCP fix R-2, 2026-09-23). This
// file re-exports OpKpiSm for backward compatibility and reuses the same tone
// maps for its own full-size tile, so there is exactly one source of truth.
import { OpKpiSm, type Tone, toneCard, toneValue } from "./OpKpiSm";
// Type-only, así que se borra en compilación y NO crea un ciclo con el dynamic
// import de más abajo (que sigue siendo la única arista en runtime, y la razón
// por la que recharts no entra al bundle de cada tile).
import type { SparklinePoint } from "./OpKpiSparkline";

// Re-exported so a call site can name the shape without reaching past OpKpi into
// its lazily-loaded chart module.
export type { SparklinePoint };
export { OpKpiSm };

/**
 * OpKpi v2 — backward-compatible KPI tile with optional new props.
 *
 * New optional props (existing callers unaffected):
 *  - info       — ⓘ tooltip: definition, formula, caveat (k-anon note)
 *  - delta      — delta vs período previo con flecha y tono (up/down)
 *  - sparkline  — mini serie inline sin ejes (recharts AreaChart)
 *  - drillHref  — KPI clickeable → lista de registros que lo componen
 *  - descriptorId / guardInput — C1 metric-contract path (see below)
 *
 * The existing `delta` prop (text + up) is preserved for backward compat.
 * The new `delta` (value + period) is additive when `info`/`sparkline` are also used.
 * To avoid collision with the existing `delta` prop shape, the new props use
 * distinct key names that don't exist in the v1 type.
 *
 * C1 METRIC CONTRACT (dim-interno:docs/reviews/results/2026-07-22-plan-maestro-integridad.md):
 * `descriptorId` is OPTIONAL and purely additive — every existing OpKpi caller
 * without it renders EXACTLY as before (the ratchet's grandfathered baseline;
 * see scripts/check-metric-contract.ts). When a caller DOES pass it:
 *  - `info` auto-resolves from the catalog's `getKpiInfo()` if not explicitly
 *    given, and always gets the descriptor's `target`/`confidence` appended
 *    as extra popover lines (the contract's "meta + fuente" and "confianza").
 *  - `guardInput.n` (the ratio's sample size/denominator) routes `value`/
 *    `tone` through `guardRatioTone` — the zero-denominator ("—") and
 *    small-N (forced-neutral + note) guards from the descriptor's `guards`.
 *  - `guardInput.priorBase` (the prior period's raw count) suppresses
 *    `deltaV2` when the descriptor's `guards.unstableDeltaBase` floor isn't
 *    met (the "−95% MoM on an unstable base" class), and — via the same
 *    input — strips the delta's red/green VERDICT (never the number) when the
 *    descriptor's `guards.deltaImplausible` fold change is exceeded over a
 *    healthy base (the "−99,6% desde 274" incomplete-load class, H16).
 * Semaphore-tone resolution (never painting a "legal verdict" color for a
 * `semaphore: {paintAgainst: "none"}` KPI) is NOT auto-applied here — it
 * composes differently per KPI's own no-data branching (e.g. PPP's
 * flaggedCount===0 "neutral" vs a real value's "blue"), so call sites import
 * `resolveSemaphoreTone` from lib/metrics/presentation-guards directly and
 * pass the resolved `tone` prop, same as any other computed tone.
 */

/** v1 delta (backward compat) */
type DeltaV1 = { text: string; up: boolean };

/**
 * v2 delta — numeric value + period label.
 * `unit` defaults to "percent" (existing callers unaffected). Use "count" for
 * a raw net-change value (e.g. queue size delta) so the chip doesn't render a
 * misleading "%" on a plain integer (demo-review M5).
 * `valence` controls the COLOR semantics (dataviz review 2026-07-23): the
 * default "goodWhenUp" keeps the existing green-up/red-down; "goodWhenDown"
 * inverts it for bad-when-up metrics (deaths, bites, no-shows, open rabies
 * observations) — a rising death count must never scan green; "neutral"
 * renders the muted no-verdict treatment (same posture as PanoramaKpiTile's
 * never-valence delta line).
 */
type DeltaV2 = {
  value: number;
  period: string;
  unit?: "percent" | "count";
  valence?: "goodWhenUp" | "goodWhenDown" | "neutral";
};

type InfoTooltip = {
  definition: string;
  formula?: string;
  caveat?: string;
  /** C1 contract extra — "meta X% (fuente)" line, appended when a
   *  `descriptorId` resolves a catalog entry with a `target`. */
  target?: string;
  /** C1 contract extra — "confianza: …" line, appended when a
   *  `descriptorId` resolves a catalog entry with `confidence.inputs`. */
  confidence?: string;
  /** FORECAST-A-META contract extra — the "proyección lineal simple…"
   *  methodology sentence, appended when a `descriptorId` resolves a catalog
   *  entry carrying `forecast` (see kpi-catalog.ts's KpiForecast). */
  methodology?: string;
  /** K8 contract extra — "Metodología v{n}" footer line, appended when a
   *  `descriptorId` resolves a catalog entry carrying `methodologyVersion`
   *  (see kpi-catalog.ts's KpiDefinition). Distinct from `methodology` above
   *  (the forecast sentence) — this is the numerator/label/target version stamp. */
  methodologyVersion?: string;
};

type Props = {
  label: string;
  value: ReactNode;
  /**
   * Optional NUMERIC value for the count-up animation (front-end delight): when
   * provided (and the resolved `value` isn't a guard dash), the headline eases
   * from its previous value to this one on change, via <AnimatedNumber>. `value`
   * stays the required SSR/reduced-motion/guard-dash fallback. `animatedFormat`
   * is a SERIALIZABLE kind (a string, NOT a function — OpKpi is a Client
   * Component reached from Server Components, which cannot pass functions across
   * the RSC boundary): "integer" → rounded es-AR; "percent" → formatPercent.
   */
  animatedValue?: number;
  animatedFormat?: "integer" | "percent";
  /** Optional mount-reveal start for the count-up (e.g. 0). SSR renders this — client-reveal only. */
  animatedStartAt?: number;
  tone?: Tone;
  /** v1 delta: { text, up } — kept for backward compat */
  delta?: DeltaV1;
  bar?: number;
  sub?: ReactNode;
  /**
   * red-team-admin #20: TRUE for a STOCK / point-in-time KPI (esterilización,
   * microchip, total registradas) whose value does NOT vary with a page-level
   * period control. Renders a small "no varía con el período" tag so an adjacent
   * period picker never implies it moves this number — mirrors the panorama
   * KpiChips "estado actual · no varía con la fecha" idiom.
   */
  periodInvariant?: boolean;
  /**
   * Copy audit 2026-08-06 (S5): when SEVERAL sibling tiles in one group are
   * each period-invariant (e.g. the /gob/denuncias triage stat row, where 3
   * of 4 tiles are "now" stocks), repeating "no varía con el período" on
   * every card reads as noise. Set this to suppress ONLY this tile's own
   * visible tag — the ⓘ popover's periodInvariant threading to ProvenanceCard
   * is untouched, so "Ver origen" still tells the truth per-KPI. The caller
   * is responsible for rendering one group-level footnote instead (see
   * `isKpiPeriodInvariant` from lib/metrics/kpi-period-invariance to decide
   * when to).
   */
  hideOwnPeriodInvariantTag?: boolean;
  /** v1 href — wraps the whole card in <a> */
  href?: string;
  size?: "default" | "sm";

  // --- New v2 optional props ---

  /**
   * Información sobre qué mide el KPI.
   * Muestra un botón ⓘ que despliega un tooltip con definición + fórmula + nota.
   */
  info?: InfoTooltip;

  /**
   * Delta numérico vs período previo (↑/↓ con tono de color).
   * Si se provee junto al `delta` v1 (text/up), ambos se muestran.
   * Uso: `deltaV2={{ value: 12.5, period: "vs mes anterior" }}`
   */
  deltaV2?: DeltaV2;

  /**
   * Mini-serie de puntos para el sparkline inline (últimos N períodos).
   * Se renderiza como un AreaChart sin ejes, sin tooltip, altura fija 32px.
   * No requiere keys ni labels — sólo los valores en orden cronológico.
   *
   * DOS ESCRITURAS, y la segunda es la que importa. Un `number[]` sigue siendo
   * válido para una serie que no pasa por k-anonimato (p. ej. el sparkline de
   * turnos de campañas). Pero cualquier serie que venga de un trend
   * (`SingleSeriesTrend`) debe pasarse ENTERA — `sparkline={trend.points}`, no
   * `trend.points.map((p) => p.y)`. Ese `.map` era la fuga: proyectaba a
   * `number[]` y borraba el flag `suppressed`, así que un bucket enmascarado
   * (1..k-1, transportado como 0) se dibujaba como una caída al piso en doce
   * tiles, sin ninguna de las declaraciones "N períodos ocultos (privacidad)"
   * que las tarjetas grandes de tendencia sí muestran. Suprimido ≠ cero.
   */
  sparkline?: readonly number[] | readonly SparklinePoint[];

  /**
   * Si se provee, el KPI muestra un link "Ver detalle →" que lleva a la lista
   * de registros que componen el valor. Distinto de `href` (que wrappea el tile).
   */
  drillHref?: string;

  /**
   * FORECAST-A-META: the metric's forecast-to-target line (lib/metrics/
   * forecast-to-target.ts's `.line`), rendered as a muted, small line under
   * the tile's value/sub — the SAME tile, zero extra clicks, no new screen.
   * Pass the engine's raw `.line` output verbatim (already null-safe: pass
   * `undefined`/the engine's `null` result and nothing renders).
   */
  forecast?: string | null;

  /**
   * C1 metric-contract id (lib/metrics/kpi-catalog.ts). Purely additive —
   * see the module-level comment above. Omit for descriptor-less tiles (the
   * grandfathered baseline scripts/check-metric-contract.ts ratchets down).
   */
  descriptorId?: KpiId;

  /**
   * Raw inputs the guard engine needs when `descriptorId` is set — see the
   * module-level comment above for exactly which guard each field feeds.
   * Both optional: pass only the ones this tile's descriptor actually guards.
   */
  guardInput?: {
    /** Sample size / denominator the ratio is computed over. */
    n?: number;
    /** The PRIOR period's raw count, for delta-suppression. */
    priorBase?: number;
    /**
     * FORECAST-A-META: number of real trend points backing this render's
     * forecast — feeds the auto-appended methodology sentence's "últimos N
     * meses" when the descriptor carries `forecast`. Omit to fall back to a
     * generic (N-less) methodology sentence.
     */
    trendMonths?: number;
    /**
     * False when this render's headline is a LIVE COUNT rather than the rate —
     * the breach-aware swap that rabiesComplianceHeadline / enoSlaHeadline do.
     * Both ratio guards reason about a denominator, and a live count has none,
     * so they are skipped. Default true.
     *
     * Not cosmetic: with it missing, the rabies-10d tile rendered a neutral
     * "—" beside a red banner reading "4 observaciones rábicas fuera del plazo
     * legal" (external design review C8/U1, reproduced live 2026-07-27).
     */
    valueIsRatio?: boolean;
  };

  /**
   * Live view context for the ProvenanceCard ("Ver origen" at the ⓘ popover's
   * foot — only rendered when `descriptorId` is set). Purely additive: omit it
   * and the card still opens with its catalog-static content plus honest
   * "No disponible…" fallbacks for the unthreaded lines.
   */
  provenance?: ProvenanceContext;
};

// ---------------------------------------------------------------------------
// Tone glyph + accessible label maps (WCAG 1.4.1 — color not sole means)
//
// Reuses the icon-per-state pattern from OpStateBadge.tsx.
// Rendered only for warn/danger/ok tones; neutral/blue have no meaningful
// non-chromatic state to convey and are left unchanged.
// ---------------------------------------------------------------------------

const TONE_ICONS: Partial<Record<Tone, ReactNode>> = {
  danger: <Icon name="alerta" size={13} decorative />,
  warn: <Icon name="alerta" size={13} decorative />,
  ok: <Icon name="circle-dot" size={13} decorative />,
};

/**
 * sr-only text equivalent for the tone glyph.
 *
 * REQUIRED, not optional: the glyph is aria-hidden, so without this the tone is
 * conveyed by COLOUR ALONE — WCAG 1.4.1, fenced by
 * __tests__/a11y-badge-kpi.test.tsx ("non-color state cue", UX 2.2).
 *
 * Track B asked to kill the "Normal:" leak and I first did it by DELETING the
 * ok label, which removed an accessibility affordance to fix a copy complaint —
 * the a11y suite caught it. The leak was never that the text exists; it was the
 * ORDER: announcing the state BEFORE the metric name buried the label under a
 * verdict on every healthy tile. The state now follows the label.
 */
const TONE_LABELS: Partial<Record<Tone, string>> = {
  danger: "Peligro",
  warn: "Atención",
  ok: "Normal",
};

// ---------------------------------------------------------------------------
// InfoTooltip sub-component
// ---------------------------------------------------------------------------

function InfoButton({
  info,
  descriptorId,
  provenance,
  sampleN,
  periodInvariant,
}: {
  info: InfoTooltip;
  /** When set, the popover foot gets the "Ver origen" affordance opening the
   *  ProvenanceCard for this catalogued KPI. */
  descriptorId?: KpiId;
  provenance?: ProvenanceContext;
  /** The SAME n the tile feeds the guard engine (guardInput.n) — the card
   *  consumes it, it never derives its own count. */
  sampleN?: number;
  /** OpKpi's resolved period-invariant verdict — threaded, not recomputed. */
  periodInvariant?: boolean;
}) {
  // hover-reveals + click-PINS (red-team QA: save a click on the ⓘ). Hover opens
  // it for a quick glance (desktop); a small close delay lets the pointer travel
  // to the dense popover to read a line; a CLICK pins it (survives mouse-leave,
  // and is the only path on touch, where hover never fires). Escape / outside
  // click (when pinned) dismisses.
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [provenanceOpen, setProvenanceOpen] = useState(false);
  // Lazy-mounted on FIRST open, then kept mounted: an always-mounted (closed)
  // <dialog> would put the card's text in every tile's DOM (breaking text
  // queries and bloating the page), while unmounting on close would skip the
  // focus-return effect. First-open mount + never unmount serves both.
  const [provenanceMounted, setProvenanceMounted] = useState(false);
  const infoTriggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    clearTimer();
    closeTimer.current = setTimeout(() => setOpen(false), 220);
  };
  const closeNow = () => {
    clearTimer();
    setOpen(false);
    setPinned(false);
  };
  // Inline the unmount cleanup instead of passing `clearTimer`: the closure is
  // recreated every render, so referencing it here would demand it as a dep.
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => {
        clearTimer();
        setOpen(true);
      }}
      onMouseLeave={() => {
        if (!pinned) scheduleClose();
      }}
    >
      <button
        ref={infoTriggerRef}
        type="button"
        aria-label="Información sobre este indicador"
        aria-expanded={open}
        onClick={(e) => {
          // preventDefault is load-bearing, not just stopPropagation: when the
          // whole tile is wrapped in <a href> (KPI cards on /gob/programa), the
          // ⓘ button is a descendant of that anchor, so a bare click still
          // triggers the anchor's NATIVE navigation. stopPropagation only stops
          // React bubbling; it does not cancel the ancestor <a> default (Cowork B6).
          e.preventDefault();
          e.stopPropagation();
          clearTimer();
          // Toggle PIN: pinned keeps it open past mouse-leave; unpinning closes.
          setPinned((p) => {
            setOpen(!p);
            return !p;
          });
        }}
        onFocus={() => {
          clearTimer();
          setOpen(true);
        }}
        onBlur={() => {
          if (!pinned) scheduleClose();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") closeNow();
        }}
        // op-hit-24 (globals.css) pads this 14×14 glyph's TOUCH target to
        // 24×24 without changing what is drawn. Its rationale — including why
        // 24 and not the project's 44px floor — lives with the rule.
        className="op-hit-24 ml-1 inline-flex items-center align-middle text-ln-op-mute hover:text-ln-op-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul rounded-sm"
      >
        {/* PO directive: no loose glyphs. The ⓘ literal is replaced by the app's
            Icon registry (b026716c standardized all glyphs on it). */}
        <Icon name="info" size={14} decorative />
      </button>

      {open && (
        <>
          {/* Backdrop ONLY when pinned — a pinned popover needs an outside-click
              dismiss; a hover popover closes on mouse-leave, no backdrop needed. */}
          {pinned && (
            <button
              type="button"
              className="fixed inset-0 z-40"
              aria-label="Cerrar información"
              onClick={(e) => {
                // Same anchor-descendant hazard as the ⓘ trigger: cancel the
                // native <a> navigation on the dismiss click too.
                e.preventDefault();
                e.stopPropagation();
                closeNow();
              }}
            />
          )}
          {/* Popover aligned to the LN card system (rounded-lg / border-ln-line /
              bg-ln-card / shadow-lg) — the same surface tokens the panorama drawer
              and LN callouts use. Consistent vertical rhythm (space-y-1.5) and a
              leading-snug definition so it reads as one system, not a bespoke box. */}
          <div
            role="tooltip"
            className="absolute z-50 bottom-full left-0 mb-2 w-72 space-y-1.5 rounded-lg border border-ln-line bg-ln-card p-3 text-sm leading-snug text-ln-ink shadow-lg"
          >
            <p className="font-medium text-ln-ink-2">{info.definition}</p>
            {info.formula && (
              <p className="rounded bg-ln-stripe px-2 py-1 font-ln-mono text-xs text-ln-ink-3">
                {info.formula}
              </p>
            )}
            {info.caveat && <p className="text-xs text-[var(--color-st-warn)]">{info.caveat}</p>}
            {/* C1 contract extras — target+source and confidence, appended
                when descriptorId resolved a catalog entry carrying them. */}
            {info.target && <p className="text-xs text-ln-ink-3">{info.target}</p>}
            {info.confidence && <p className="text-xs text-ln-ink-3">{info.confidence}</p>}
            {/* FORECAST-A-META: the "proyección lineal simple…" methodology
                sentence, appended when descriptorId resolved a catalog entry
                carrying `forecast`. */}
            {info.methodology && <p className="text-xs text-ln-ink-3">{info.methodology}</p>}
            {/* K8: "Metodología v{n}" footer, appended when descriptorId
                resolved a catalog entry carrying `methodologyVersion`. */}
            {info.methodologyVersion && (
              <p className="text-xs text-ln-op-mute">{info.methodologyVersion}</p>
            )}
            {/* Provenance — "¿De dónde sale este número?". One terse link at
                the popover's foot, only for catalogued tiles; opens the
                ProvenanceCard dialog. preventDefault carries the same
                anchor-descendant rationale as the ⓘ trigger (Cowork B6). */}
            {descriptorId && (
              <OpButton
                variant="ghost"
                size="sm"
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  closeNow();
                  setProvenanceMounted(true);
                  setProvenanceOpen(true);
                }}
                className="-mx-1 px-1 text-xs font-medium text-ln-op-azul hover:underline"
              >
                Ver origen
              </OpButton>
            )}
          </div>
        </>
      )}

      {/* Lazy-mounted on FIRST open, then kept mounted (open/close via prop,
          the ConfirmDialog idiom): an always-mounted closed <dialog> put the
          card's text in every catalogued tile's DOM (hostile-reader caught
          it), while unmounting on close would skip the focus-return effect. */}
      {descriptorId && provenanceMounted && (
        <ProvenanceCard
          descriptorId={descriptorId}
          open={provenanceOpen}
          onClose={() => setProvenanceOpen(false)}
          triggerRef={infoTriggerRef}
          context={provenance}
          n={sampleN}
          periodInvariant={periodInvariant}
        />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sparkline sub-component (bundle-size #22: dynamic-imported — recharts is
// only fetched when a caller actually passes `sparkline`, not on every OpKpi
// tile across every /gob, /admin, /org page that imports this module).
// ---------------------------------------------------------------------------

const Sparkline = dynamic(() => import("./OpKpiSparkline").then((m) => m.OpKpiSparkline), {
  ssr: false,
  loading: () => <div className="mt-2 h-8 w-full" aria-hidden="true" />,
});

/**
 * Normaliza las dos escrituras del prop `sparkline` a la forma que consume el
 * gráfico. Un punto de trend trae además `x` (la etiqueta del bucket); se
 * descarta acá para que el hijo reciba exactamente lo que plotea y nada más.
 */
function toSparklinePoints(
  series: readonly number[] | readonly SparklinePoint[],
): SparklinePoint[] {
  return series.map((p) => {
    if (typeof p === "number") return { y: p };
    return p.suppressed ? { y: p.y, suppressed: true } : { y: p.y };
  });
}

/**
 * El sparkline más su declaración de privacidad.
 *
 * Extraído por la misma razón que `resolveOpKpiContract` más abajo: OpKpi vive
 * pegado al presupuesto de complejidad cognitiva del linter, y la rama de la
 * declaración fue justo el token que lo pasaba de 25 a 26. Acá además el conteo
 * de buckets enmascarados nace al lado de los puntos que describe, así que no
 * hay forma de que se desincronice de ellos.
 */
function SparklineBlock({ points, tone }: { points: SparklinePoint[]; tone: Tone }) {
  if (points.length < 2) return null;
  const masked = points.filter((p) => p.suppressed).length;
  return (
    <>
      <Sparkline points={points} tone={tone} />
      {/* La declaración que existía en las tarjetas grandes de tendencia y NO
          acá, que es precisamente donde el hueco se ve menos: 32px de alto, sin
          ejes y sin tooltip. El texto es el canal honesto. */}
      {masked > 0 && (
        <p className="mt-1 text-xs text-ln-op-mute">
          {masked} {pluralizeEs(masked, "período oculto", "períodos ocultos")} (privacidad)
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// C1 metric-contract resolution (extracted — keeps OpKpi's own cognitive
// complexity under the lint budget; this function owns ALL of the
// descriptorId/guardInput branching in one place).
// ---------------------------------------------------------------------------

type ContractResolution = {
  value: ReactNode;
  tone: Tone;
  deltaV2: DeltaV2 | undefined;
  guardNote: string | undefined;
  info: InfoTooltip | undefined;
  /** True when the CONTRACT says this is a point-in-time stock (see below). */
  derivedPeriodInvariant: boolean;
  /** True when `guards.deltaImplausible` fired — the delta keeps its number
   *  and its arrow but loses its colour verdict and gains a "verificar carga"
   *  suffix (H16). */
  deltaImplausible: boolean;
};

/** "Meta: X% — fuente" / "Confianza: …" / methodology popover extras from a
 *  resolved descriptor. `trendMonths` is the live render's real trend-point
 *  count (guardInput.trendMonths) — undefined falls back to an N-less
 *  sentence rather than inventing a number. */
function contractInfoExtras(
  descriptor: ReturnType<typeof resolveDescriptor>,
  trendMonths: number | undefined,
) {
  // C1 fix (claim #6, cursor red-team 2026-07-23): render via formatKpiTarget
  // so a law-sourced but non-statutory target (e.g. rabies coverage's 80%)
  // never reads as "the law set this number" — see KpiTargetSourceKind.
  const target = descriptor?.target
    ? formatKpiTarget(descriptor.target, descriptor.unit)
    : undefined;
  const confidence = descriptor?.confidence
    ? `Confianza: ${descriptor.confidence.inputs.join(" · ")}`
    : undefined;
  // FORECAST-A-META: the methodology sentence lives HERE (auto-appended),
  // not as static catalog prose — it names the actual window this render
  // used, same spirit as target/confidence being computed, not typed once.
  const methodology = descriptor?.forecast
    ? `Proyección lineal simple sobre los últimos ${trendMonths !== undefined ? `${trendMonths} ${pluralizeEs(trendMonths, "mes")}` : "meses disponibles"} — extrapolación, no promesa.`
    : undefined;
  // K8: "Metodología v{n}" footer — only descriptors whose numerator/label/
  // target changed on a dated basis carry `methodologyVersion` (omitted = v1,
  // no footer line at all — v1 is the silent default, not announced).
  const methodologyVersion = descriptor?.methodologyVersion
    ? `Metodología v${descriptor.methodologyVersion}`
    : undefined;
  return { target, confidence, methodology, methodologyVersion };
}

function resolveDescriptor(descriptorId: KpiId | undefined) {
  return descriptorId ? KPI_CATALOG[descriptorId] : undefined;
}

/** Guard notes accumulate — a tile can trip more than one. */
function appendNote(existing: string | undefined, note: string): string {
  return existing ? `${existing} ${note}` : note;
}

/**
 * Resolve the C1 metric-contract path — see the module-level comment. No-op
 * (identical to the raw props) when `descriptorId` is omitted, so every
 * existing OpKpi caller renders byte-identical output.
 */
function resolveOpKpiContract(
  descriptorId: KpiId | undefined,
  guardInput: Props["guardInput"],
  rawValue: ReactNode,
  rawTone: Tone,
  rawDeltaV2: DeltaV2 | undefined,
  rawInfo: InfoTooltip | undefined,
): ContractResolution {
  const descriptor = resolveDescriptor(descriptorId);

  let value = rawValue;
  let tone = rawTone;
  let deltaV2 = rawDeltaV2;
  let guardNote: string | undefined;

  if (descriptor && guardInput?.n !== undefined && typeof rawValue === "string") {
    const guarded = guardRatioTone(descriptor, {
      n: guardInput.n,
      computedTone: rawTone,
      formattedValue: rawValue,
      valueIsRatio: guardInput.valueIsRatio,
    });
    value = guarded.value;
    tone = guarded.tone;
    guardNote = guarded.note;
  }

  // Track B — stock-vs-flow framing, SYSTEMATIC. A point-in-time count sitting
  // under a period picker "lies by proximity": the control implies it moves the
  // number, and it does not. The catalog already declares the axis
  // (`basis: "stock"`, `window: "now"`), so this is DERIVED here rather than
  // re-remembered at 181 call sites — the ones that pass `periodInvariant`
  // explicitly keep winning, so nothing existing changes.
  const derivedPeriodInvariant = isKpiPeriodInvariant(descriptorId);

  let deltaImplausible = false;
  if (descriptor && deltaV2 && guardInput?.priorBase !== undefined) {
    if (shouldSuppressDelta(descriptor, guardInput.priorBase)) {
      deltaV2 = undefined;
      guardNote = appendNote(guardNote, UNSTABLE_DELTA_BASE_NOTE);
    } else if (
      // H16: a fold-change guard only reads a PERCENTAGE change. A
      // `unit: "count"` delta is a raw net difference (queue size ±N), which
      // has no fold-change meaning at all — skipping it here is what keeps
      // this guard from inventing a ratio out of an integer.
      deltaV2.unit !== "count" &&
      deltaImplausibleGate(descriptor, {
        deltaPct: deltaV2.value,
        priorBase: guardInput.priorBase,
      })
    ) {
      // The NUMBER survives — value, sign, arrow and prior base all still
      // render. Only the red/green verdict is withheld: the guard knows the
      // swing is not citable as-is, it does NOT know the direction is wrong.
      deltaV2 = { ...deltaV2, valence: "neutral" };
      deltaImplausible = true;
      guardNote = appendNote(guardNote, DELTA_IMPLAUSIBLE_NOTE);
    }
  }

  // Auto-resolve `info` from the catalog when descriptorId is set and the
  // caller didn't pass an explicit one, then append the contract extras
  // (target+source, confidence, forecast methodology) regardless of which
  // info source won.
  const baseInfo = rawInfo ?? (descriptorId ? getKpiInfo(descriptorId) : undefined);
  const info = baseInfo
    ? { ...baseInfo, ...contractInfoExtras(descriptor, guardInput?.trendMonths) }
    : undefined;

  return { value, tone, deltaV2, guardNote, info, derivedPeriodInvariant, deltaImplausible };
}

// ---------------------------------------------------------------------------
// OpKpi — full-size tile
// ---------------------------------------------------------------------------

/**
 * v2 delta row: numeric value + period, colored by `valence` (not by sign).
 *
 * demo-review M5: a delta of exactly 0 got an up-arrow / "Sube" label — honest
 * text ("+0%") next to a directional arrow reads as a real increase. No arrow
 * (and neutral tone) when the delta is exactly 0.
 */
function DeltaV2Row({
  delta,
  priorBase,
  implausible,
}: { delta: DeltaV2; priorBase?: number; implausible?: boolean }) {
  const isFlat = delta.value === 0 || delta.valence === "neutral";
  const isGood = delta.value > 0 === (delta.valence !== "goodWhenDown");
  const toneCls = isFlat
    ? "text-ln-op-mute"
    : isGood
      ? "text-[var(--color-st-ok)]"
      : "text-[var(--color-st-err)]";

  return (
    <div className={`mt-1 flex items-center gap-1.5 text-sm font-semibold tabular-nums ${toneCls}`}>
      {delta.value !== 0 && (
        <>
          <span aria-hidden="true">{delta.value > 0 ? "↑" : "↓"}</span>
          <span className="sr-only">{delta.value > 0 ? "Sube:" : "Baja:"}</span>
        </>
      )}
      <span>
        {/* The delta was the ONE number in this tile printed as a raw JS
            number — hand-rolled sign, English decimal point, no thousands
            separator. On /gob that put "-99.8%" beside eleven comma-formatted
            figures (QA 2026-08-07). `formatDelta` already owns es-AR signed
            output, and `signDisplay: "exceptZero"` replaces the manual "+".
            Precision is fixed at 1 decimal — `computeDeltaPct` rounds to that
            (lib/metrics/targets.ts:348), and uniform precision is the whole
            point of the `tabular-nums` on the row above: mixed "139%" /
            "-99,8%" widths defeat the digit alignment it buys. */}
        {formatDelta(delta.value, { unit: delta.unit === "count" ? "" : "%" })}{" "}
        <span className="font-normal text-ln-op-mute">
          {delta.period}
          {/* Track B: name the BASE the percentage is computed over. A bare
              "+139%" is a press figure; "+139% vs mes anterior (desde 1.263)"
              is checkable. The number already arrives for the unstable-base
              guard — it was simply never shown. */}
          {priorBase !== undefined && ` (desde ${priorBase.toLocaleString("es-AR")})`}
          {/* H16: the suffix rides ON the chip, not only in the guard note
              below — a funcionario copying the figure into a slide reads the
              delta line, not the small print under it. */}
          {implausible && ` · ${DELTA_IMPLAUSIBLE_SUFFIX}`}
        </span>
      </span>
    </div>
  );
}

/**
 * Full-size KPI tile. min-h-[112px], serif value, optional delta/bar/sub.
 * v2: adds info tooltip, deltaV2, sparkline, drillHref (all optional).
 */
export function OpKpi({
  label,
  value: rawValue,
  animatedValue,
  animatedFormat,
  animatedStartAt,
  tone: rawTone = "neutral",
  delta,
  bar,
  sub,
  periodInvariant,
  hideOwnPeriodInvariantTag,
  href,
  info: rawInfo,
  deltaV2: rawDeltaV2,
  sparkline,
  drillHref,
  forecast,
  descriptorId,
  guardInput,
  provenance,
}: Props) {
  const { value, tone, deltaV2, guardNote, info, derivedPeriodInvariant, deltaImplausible } =
    resolveOpKpiContract(descriptorId, guardInput, rawValue, rawTone, rawDeltaV2, rawInfo);

  const sparklinePoints = sparkline ? toSparklinePoints(sparkline) : undefined;

  const cardCls = [
    "flex flex-col rounded-[var(--radius-md)] border p-[14px_16px]",
    "min-h-[112px] no-underline text-inherit",
    toneCard[tone],
  ].join(" ");

  const content = (
    <>
      {/* Label + tone glyph + ⓘ */}
      <div className="mb-2 flex items-center gap-1">
        {TONE_ICONS[tone] && (
          <span aria-hidden="true" className="inline-flex items-center leading-none">
            {TONE_ICONS[tone]}
          </span>
        )}
        <span className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          {label}
        </span>
        {/* AFTER the label: a screen reader hears "Vacunados, Normal", not
            "Normal: Vacunados". Same information, the metric first. */}
        {/* Single template-literal child (not `, {expr}`) — two JSX children
            compile to two separate text nodes, which some accessibility-tree
            tooling (per-node ARIA snapshots) lists as an orphan ", " leaf
            ahead of the tone word. One string node keeps "label, tone" as a
            single announced fragment either way. */}
        {TONE_LABELS[tone] && <span className="sr-only">{`, ${TONE_LABELS[tone]}`}</span>}
        {info && (
          <InfoButton
            info={info}
            descriptorId={descriptorId}
            provenance={provenance}
            sampleN={guardInput?.n}
            periodInvariant={periodInvariant ?? derivedPeriodInvariant}
          />
        )}
      </div>

      {/* Value */}
      <div
        className={[
          "font-ln-serif text-3xl font-semibold leading-none tracking-[-0.02em] tabular-nums",
          toneValue[tone],
        ].join(" ")}
      >
        {animatedValue !== undefined && value !== "—" ? (
          <AnimatedNumber
            value={animatedValue}
            // Map the serializable kind → a client-side formatter HERE (functions
            // can't cross the RSC boundary). "integer" → AnimatedNumber's default.
            format={animatedFormat === "percent" ? (n) => formatPercent(n) : undefined}
            startAt={animatedStartAt}
          />
        ) : (
          value
        )}
      </div>

      {/* Guard note (C1) — smallN / unstable-delta explanations from the
          guard engine. Rendered distinctly from `sub` (which stays whatever
          the caller composed) so the guard's own honesty note is never
          silently absorbed into arbitrary caller copy. */}
      {guardNote && <p className="mt-1 text-xs text-ln-op-mute">{guardNote}</p>}

      {/* Sparkline (v2) */}
      {sparklinePoints && <SparklineBlock points={sparklinePoints} tone={tone} />}

      {/* Progress bar */}
      {bar !== undefined && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-sm bg-black/[0.07]">
          <span
            className="block h-full rounded-sm"
            style={{
              width: `${Math.min(100, Math.max(0, bar))}%`,
              background: "currentColor",
            }}
          />
        </div>
      )}

      {/* v1 Delta (text + up) — backward compat */}
      {delta && (
        <div
          className={[
            "mt-2 flex items-center gap-1.5 text-sm font-semibold tabular-nums",
            delta.up ? "text-[var(--color-st-ok)]" : "text-[var(--color-st-err)]",
          ].join(" ")}
        >
          <span aria-hidden="true">{delta.up ? "↑" : "↓"}</span>
          <span className="sr-only">{delta.up ? "Sube:" : "Baja:"}</span>
          <span>{delta.text}</span>
        </div>
      )}

      {/* v2 Delta (numeric value + period).
          demo-review M5: a delta of exactly 0 got an up-arrow / "Sube" label —
          honest text ("+0%") next to a directional arrow reads as a real
          increase. No arrow (and neutral tone) when the delta is exactly 0. */}
      {deltaV2 && (
        <DeltaV2Row
          delta={deltaV2}
          priorBase={guardInput?.priorBase}
          implausible={deltaImplausible}
        />
      )}

      {/* Sub */}
      {sub && <div className="mt-auto pt-1.5 text-sm text-ln-op-mute">{sub}</div>}

      {/* red-team-admin #20: point-in-time KPI under a period control — say it
          plainly so the picker never reads as a broken control on this tile.
          `hideOwnPeriodInvariantTag` (S5) suppresses ONLY this visible line —
          the ⓘ popover below still receives the true periodInvariant value. */}
      {!hideOwnPeriodInvariantTag && (periodInvariant ?? derivedPeriodInvariant) && (
        <p
          className="mt-1 text-xs font-medium uppercase tracking-[0.06em] text-ln-op-faint"
          title="Valor de estado actual (point-in-time): el selector de período mueve los gráficos, no este número."
        >
          no varía con el período
        </p>
      )}

      {/* FORECAST-A-META: the forecast-to-target line — a PROPERTY of this
          metric, rendered right where its value already lives (zero extra
          clicks, no new screen). `forecast` is the engine's `.line` output
          verbatim: null/undefined (met/insufficient/no descriptor.forecast)
          renders nothing, by construction — never an invented line. */}
      {forecast && <p className="mt-1 text-xs text-ln-op-mute">{forecast}</p>}

      {/* Drill link (v2) */}
      {drillHref && (
        <a
          href={drillHref}
          className="mt-auto pt-1.5 text-sm text-ln-op-azul hover:underline self-start"
          onClick={(e) => e.stopPropagation()}
        >
          Ver detalle →
        </a>
      )}
    </>
  );

  if (href) {
    return (
      <a href={href} className={cardCls}>
        {content}
      </a>
    );
  }
  return <div className={cardCls}>{content}</div>;
}
