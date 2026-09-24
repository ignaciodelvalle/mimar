// The "N … ocultas (privacidad)" chip that /gob/analytics renders in a card
// header when a panel's fetcher withheld cells for k-anonymity.
//
// Extracted (RA-3 C3) because the page had grown a THIRD copy of the same
// inline ternary — signals trend, vet access, outbreak history — and each copy
// was one more place the disclosure could be worded differently or dropped.
// Returning null for a clean frame keeps the decision here instead of at three
// call sites, which is also what keeps the page component under its
// cognitive-complexity fence.
//
// It states the COUNT only. The RULE (what k is, what got hidden) belongs next
// to the data, inside each panel's own body — see OutbreakHistoryTable's
// footnote and the vet-access note.

type Props = {
  /** Cells the fetcher withheld. 0 (or negative, defensively) renders nothing. */
  count: number;
  /** es-AR noun phrase for one hidden unit, e.g. "localidad oculta". */
  singular: string;
  /** es-AR noun phrase for several, e.g. "localidades ocultas". */
  plural: string;
};

export function SuppressionChip({ count, singular, plural }: Props) {
  if (count <= 0) return null;
  return (
    <span className="text-sm font-normal text-ln-op-mute">
      {count} {count === 1 ? singular : plural} (privacidad)
    </span>
  );
}
