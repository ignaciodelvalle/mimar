// panorama-ia-v2 §3.6 — export/share provenance helpers (pure).
//
// The PNG export embeds an auditable metadata footer so a slide handed to an
// intendente carries its own provenance (data-as-of, source, scope, period,
// and how many cells were privacy-suppressed). Kept framework-free and pure so
// the footer text is unit-testable without a canvas or maplibre.

import { encodeAsOfToParams } from "@/lib/ui/map-layer-nav";
import { type ViewScopeDescriptor, viewScopeDigest } from "@/lib/ui/view-scope-descriptor";
import { formatDateTimeNumericAr } from "@/lib/utils/format";
import { formatAsOfDayLong } from "@/src/modules/panorama/domain/time-scrub";

/**
 * es-AR day label for the footer: "4 de julio de 2026".
 *
 * T2.4: delegates to THE one UTC-pinned as-of formatter (time-scrub.ts) — the
 * old local bare formatter used the runtime timezone (server UTC vs browser
 * ART could disagree by a day) and its own compact shape, so the exported
 * footer date could drift from the dock/context-bar rendering of the SAME cut.
 */
export function formatAsOfDate(date: Date): string {
  return formatAsOfDayLong(date);
}

// ---------------------------------------------------------------------------
// "Citar esta vista" v1 (2026-08-02 determinism audit) — the citation pin.
//
// A citation must never depend on the live serving path (cache/cube parity):
// the copied URL always carries an explicit `asOf`, so re-opening it replays
// the event spine through the as-of path. Parked at the live edge, the pin is
// the GENERATION day at UTC-day precision — exactly the value a URL round-trip
// (encodeAsOfToParams → parseAsOfFromParams) restores, so the citing
// operator's own re-pinned view and the reader's re-opened view are the SAME
// cut (a full-instant pin would show the operator a view the day-precision URL
// cannot reproduce). An asOf the operator already scrubbed to is preserved
// untouched. Pure; the console owns the History write and the state pin.
// ---------------------------------------------------------------------------

/**
 * Resolve the citation corte and write it into `params` (mutates in place —
 * same contract as encodeAsOfToParams; every other view param is untouched).
 * Returns the pinned Date: the given `asOf` when a scrub is active, else UTC
 * midnight of `now`'s day. `now` is injectable for deterministic tests.
 */
export function pinCitationAsOf(params: URLSearchParams, asOf: Date | null, now?: Date): Date {
  const generation = now ?? new Date();
  const pinned = asOf ?? new Date(`${generation.toISOString().slice(0, 10)}T00:00:00.000Z`);
  encodeAsOfToParams(params, pinned);
  return pinned;
}

/**
 * L-7 (review F5) — the es-AR datetime label for a cube stamp, or null when the
 * value is absent/unparseable. Mirrors panoramaFreshnessCaption's tolerance:
 * a malformed serialized stamp must fall back to the live/now wording, never
 * print "Datos precalculados al —" (or Invalid Date) on an exported artifact.
 */
export function cubeStampLabel(builtAt: Date | string | null | undefined): string | null {
  if (!builtAt) return null;
  const date = builtAt instanceof Date ? builtAt : new Date(builtAt);
  return Number.isNaN(date.getTime()) ? null : formatDateTimeNumericAr(date);
}

export type ExportFooterInput = {
  /** The data-as-of date (scrub time), or null for "live" current data. */
  asOf: Date | null;
  /**
   * L-7 — the cube's build timestamp when this board was served from the
   * precomputed cube. Present only for the SSR-seeded frame (PanoramaConsole's
   * one-way dropCubeStamp latch, see cube-freshness.ts) — absent after any
   * client refetch, or when live-served throughout. An explicit `asOf` scrub
   * takes precedence (one stamp per board, same order as informeAsOfLabel).
   */
  cubeBuiltAt?: Date | string | null;
  /** es-AR scope label, e.g. "Nacional" or "Provincia de Buenos Aires". */
  scopeLabel: string;
  /** es-AR period label, e.g. "últimos 90 días" or "estado actual". */
  periodLabel: string;
  /** Number of k-anon-suppressed cells in the current view (audit trail). */
  suppressedCount: number;
  /** Injectable "now" for deterministic tests; defaults to new Date(). */
  now?: Date;
  /**
   * V2 — the serializable scope this frame was cut from. A 34-pixel footer strip
   * cannot hold the descriptor itself (nor could a reader retype it), so the PNG
   * carries its DIGEST: an identity handle that ties the image to the full
   * descriptor printed in the informe and in the CSV header block.
   *
   * Be precise about what that buys: the digest lets you PROVE two artifacts
   * describe the same view, and lets you find the descriptor that regenerates
   * this frame. It does NOT reconstruct anything on its own, and it is a
   * non-cryptographic hash — never read it as tamper evidence. A PNG that must
   * stand alone as evidence needs the signature/expediente work, not a longer
   * footer. Omitted → the footer is exactly what it was before V2.
   */
  viewScope?: ViewScopeDescriptor | null;
  /**
   * MAP-1 — the on-screen CABA/AMBA magnifier is NOT in this image.
   *
   * The inset is a second MapLibre map with its own canvas; the export composes
   * one. Rather than ship a national image that silently drops the country's
   * densest jurisdiction, the strip says so. Honesty over completeness: the
   * reader can go get a CABA-scoped export, which frames CABA in the main map
   * and needs no caveat at all.
   */
  cabaInsetOmitted?: boolean;
};

/**
 * Build the export footer string. Always includes data-as-of, source (miMAR),
 * scope and period; appends the suppressed-cell count so the provenance is
 * complete (PO recommendation: always include the suppressed count for audit).
 *
 * Example:
 *   "Datos al 4 de julio de 2026 · miMAR · Nacional · últimos 90 días · 3 celdas protegidas por privacidad"
 */
export function buildExportFooter(input: ExportFooterInput): string {
  // L-7: a cube-served board must not claim today's date — up to 26h of
  // honest drift. Precedence: explicit scrub > cube stamp > generation time.
  const cubeStamp = cubeStampLabel(input.cubeBuiltAt);
  const freshness = input.asOf
    ? `Datos al ${formatAsOfDate(input.asOf)}`
    : cubeStamp
      ? `Datos precalculados al ${cubeStamp}`
      : `Datos al ${formatAsOfDate(input.now ?? new Date())}`;
  const parts = [freshness, "miMAR", input.scopeLabel, input.periodLabel];
  if (input.suppressedCount > 0) {
    const phrase =
      input.suppressedCount === 1
        ? "1 celda protegida por privacidad"
        : `${input.suppressedCount} celdas protegidas por privacidad`;
    parts.push(phrase);
  }
  // Before the digest: a reader who needs to know a jurisdiction is missing from
  // the image must not have to read past a hash to find out.
  if (input.cabaInsetOmitted) {
    parts.push("sin el recuadro de CABA (exportá con alcance CABA para verlo)");
  }
  // Last, so the human-readable provenance keeps the front of the strip and the
  // machine handle never displaces a word an operator actually reads.
  if (input.viewScope) {
    parts.push(`vista ${viewScopeDigest(input.viewScope)}`);
  }
  return parts.join(" · ");
}
