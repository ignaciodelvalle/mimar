// The legend pill's plain-language caption — the block that answers "what does
// a mark on this map mean right now", in one of two shapes.
//
// WHY ITS OWN FILE: PanoramaConsole sits ON the file-size ratchet (5089 lines,
// one line of headroom when this was written). The fence's standing instruction
// is to EXTRACT, never to feed, and this block is the natural seam — it is a
// pure function of props with no console state, and it already had two clearly
// separate branches.
//
// THE TWO SHAPES ARE NOT INTERCHANGEABLE. Under the bivariate encoding the map
// paints a 3×3 matrix, so the caption must SHOW that matrix and explain the
// tercile method. Everywhere else the map paints one ramp, so PanoramaCaption
// describes the layer at the active vista + level, and per-capita adds its
// denominator footer. Rendering the sequential caption over a bivariate frame
// would describe a scale the canvas is not painting.
//
// PO report 2026-08-01: the bivariate branch used to be prose ONLY. LegendPill's
// docblock said "the full 3×3 reading lives in the expanded children"; it did
// not — the matrix existed solely inside MapLegends. An operator saw the 3×3
// hint on the collapsed strip, opened the pill for the key, and got a paragraph
// describing one. Both surfaces now render the same BivariateMatrix.

import { BivariateMatrix } from "@/components/panorama/BivariateMatrix";
import { PanoramaCaption } from "@/components/panorama/PanoramaCaption";
import type { BivariatePair } from "@/src/modules/panorama/domain/bivariate";

type Props = {
  /** Bivariate encoding active for this frame → the matrix branch. */
  bivariate: boolean;
  /** The ACTIVE pair, so the caption names what the matrix crosses. */
  bivariatePair?: BivariatePair | null;
  /** The caption sentence for the pair (bivariate branch). */
  bivariateCaption: string;
  /**
   * Does THIS frame actually paint the k-anon hatch? The sentence about the
   * hatch sends the reader looking for a texture, so it may only be said when
   * one is on the canvas — the same predicate the pill's chip and MapLegends'
   * hatch rows read, so the three cannot disagree.
   */
  paintsHatch: boolean;
  /** Sequential branch — forwarded verbatim to PanoramaCaption. */
  captionProps: React.ComponentProps<typeof PanoramaCaption>;
  /** Per-capita denominator footer (sequential branch), already formatted. */
  perCapitaFooter?: string | null;
};

export function LegendCaptionBlock({
  bivariate,
  bivariatePair,
  bivariateCaption,
  paintsHatch,
  captionProps,
  perCapitaFooter,
}: Props) {
  if (bivariate) {
    return (
      <>
        <BivariateMatrix pair={bivariatePair} />
        <p className="text-sm leading-snug text-ln-op-mute" aria-live="polite">
          {bivariateCaption} Terciles calculados sobre la distribución del alcance actual.
          {paintsHatch &&
            " Una provincia protegida por privacidad (k-anonimato) se muestra con trama, nunca con color."}
        </p>
      </>
    );
  }

  return (
    <>
      <PanoramaCaption {...captionProps} />
      {perCapitaFooter && (
        <p className="text-xs leading-snug text-ln-op-mute" aria-live="polite">
          {perCapitaFooter}
        </p>
      )}
    </>
  );
}
