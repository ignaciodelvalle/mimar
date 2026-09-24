"use client";

// LibretaFilterChips — per-event-type filter bar for the consolidated libreta
// timeline (B3 redefined, 2026-07-31).
//
// WHY THIS EXISTS
// ----------------
// ADR-10 collapsed /libreta, /vacunas and /historial into ONE timeline, and
// that consolidation stands. What it left unsolved is the owner's most common
// question — "¿cuándo fue la última X?" — against a feed of up to
// PAST_EVENTS_WINDOW mixed asientos (critique-libreta 2026-07-27, findings
// #3/#8). LIBRETA_FILTER_CHIPS already described the right vocabulary but had
// no consumer outside its own test. This is that consumer.
//
// These chips are NOT the lens chips ADR-10 removed. A lens changed WHICH
// EVENTS EXIST for the viewer (an audience/authority claim); these narrow the
// rows already on screen and never hide a category that has content — the
// audience filter still runs first, upstream (libreta-lens.ts).
//
// DESIGN RULES (the reasoning, so a later reader does not "restore" the 14):
//   1. A chip renders only when at least one loaded row matches it. A chip
//      that filters to nothing is a dead control, and 14 always-on chips are
//      more chrome than the feed they sit above. Consequence: the chip bar
//      doubles as an index of what this pet actually has.
//   2. The count lives ON the chip. It is half the answer to the owner's
//      question ("4 vacunas") and it is the only way a chip can be read
//      before being pressed.
//   3. There is no "no matches" empty state because there can be no empty
//      match: the chips are derived from the very array they filter, so any
//      selection is non-empty by construction. Rendering unreachable copy
//      would be a lie about what the screen can do.
//   4. Fewer than two matching types → no bar at all. With one type present,
//      "Todos 5 / Vacunas 5" is a control that cannot change anything.

import { LnChip } from "@/components/ui/Chip";
import type { LibretaChipCount } from "@/lib/infra/libreta-sanitaria";

/** Below this many distinct matching types the bar is pure chrome (rule 4). */
export const LIBRETA_CHIPS_MIN_TYPES = 2;

type Props = {
  /** Output of `libretaChipCounts` — already narrowed to matching types. */
  counts: ReadonlyArray<LibretaChipCount>;
  /** Rows in the unfiltered feed; labels the "Todos" chip. */
  totalCount: number;
  /** Empty set means "Todos" — no narrowing. */
  selected: ReadonlySet<string>;
  onToggle: (type: string) => void;
  onClear: () => void;
};

export function LibretaFilterChips({ counts, totalCount, selected, onToggle, onClear }: Props) {
  if (counts.length < LIBRETA_CHIPS_MIN_TYPES) return null;

  return (
    // <fieldset> rather than a div with role="group": the bar IS a group of
    // related controls, and the legend gives it an accessible name without
    // inventing an ARIA role the element already has natively.
    // `min-w-0` neutralises the UA `min-inline-size: min-content` on fieldset,
    // which would otherwise stop the bar from wrapping inside a narrow column.
    <fieldset data-section="libreta-filtros" className="mb-3 flex min-w-0 flex-wrap gap-1.5">
      <legend className="sr-only">Filtrar asientos por tipo</legend>
      <LnChip selected={selected.size === 0} onChange={onClear}>
        Todos <ChipCount value={totalCount} />
      </LnChip>
      {counts.map((chip) => (
        <LnChip
          key={chip.type}
          selected={selected.has(chip.type)}
          onChange={() => onToggle(chip.type)}
        >
          {chip.label} <ChipCount value={chip.count} />
        </LnChip>
      ))}
    </fieldset>
  );
}

function ChipCount({ value }: { value: number }) {
  return <span className="ml-1 tabular-nums opacity-70">{value}</span>;
}
