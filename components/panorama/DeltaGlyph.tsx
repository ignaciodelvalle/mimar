// DeltaGlyph — the up/down/flat delta direction glyph shared by PanoramaKpiTile
// and KpiChips. Both places render a KpiDelta["direction"] next to a period
// delta figure; this was copy-pasted verbatim (cheap dedupe, consistency pass).
//
// ARROWS, not chevrons. This glyph states DIRECTION; a chevron states
// DISCLOSURE ("expand me") in every other place in this product and on the
// web. Rendering chevron-down beside "-26%" made the PO try to click it as a
// minimise control (live 2026-07-25) — the same class of defect as a preview
// that promised a navigation it did not perform. Nothing here is interactive:
// the glyph is decorative and aria-hidden, and the delta's own text label
// carries the meaning for a screen reader.
//
// This also aligns Panorama with OpKpi, which already renders "↑"/"↓" for the
// identical concept on /gob and /admin. One vocabulary, both surfaces.
//
// "flat" has no lucide equivalent worth a registry entry for a single fullwidth
// "＝" (not a banned symbol-as-icon character).

import { Icon } from "@/components/Icon";
import type { KpiDelta } from "@/src/modules/panorama/application/get-panorama-kpis";

export function DeltaGlyph({ direction }: { direction: KpiDelta["direction"] }) {
  if (direction === "flat") return <span aria-hidden="true">＝</span>;
  return <Icon name={direction === "up" ? "arrow-up" : "arrow-down"} size="sm" decorative />;
}
