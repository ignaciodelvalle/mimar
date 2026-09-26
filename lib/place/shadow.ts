// The shadow classifier — localidades-por-id D1 (design "Shadow comparator").
//
// Every consumer that moves from the NAME path (a govt grant or a rule matched
// by its (province, locality) text) to the ID path (a catalogue locality_id,
// governed by an authority unit) first runs both and compares. A disagreement
// is not automatically a bug: the change exists to produce three of them.
//
//   homonym_split           the name path reached a row only because its name
//                           is shared (Mechita, partido Alberti vs partido
//                           Bragado). The id path splits them. ACCEPTED.
//   spelling_join           the id path reached a row the name path missed
//                           because it was spelled differently ("Nunez" vs
//                           "Núñez"). ACCEPTED.
//   unresolved_to_province  the name path reached a row with no locality_id;
//                           the id path gives it only to its province (P1:
//                           an unresolved place never widens a municipio).
//                           ACCEPTED.
//   unit_widening           the id path reached a row outside every old grant
//                           because a PERSON confirmed a unit wider than the
//                           grant (the partial-grant confirm flow) — or
//                           because an admin LATER added a locality to that
//                           unit (current membership decides visibility).
//                           Reported with the list, never silent; not
//                           blocking.
//   legacy_grant            a grant with authority_unit_id NULL answered
//                           differently on the two paths. By construction it
//                           must not: BLOCKING.
//   other                   anything else. BLOCKING.
//
// The flip gate (D7): the parity sweep has zero `other` and zero
// `legacy_grant`, and so does the runtime sink for seven days.
//
// Pure on purpose: the sink that stores disagreements is shadow-sink.ts.

export const SHADOW_KINDS = [
  "homonym_split",
  "spelling_join",
  "unresolved_to_province",
  "unit_widening",
  "legacy_grant",
  "other",
] as const;
export type ShadowKind = (typeof SHADOW_KINDS)[number];

/** The kinds that block a flip. Everything else is the change working. */
export const BLOCKING_SHADOW_KINDS: readonly ShadowKind[] = ["legacy_grant", "other"];

/**
 * What is known about ONE row (or one recipient) where the two paths were
 * asked the same question.
 */
export type ShadowFacts = {
  /** The name path's answer (visible / routed / matched). */
  namePath: boolean;
  /** The id path's answer. */
  idPath: boolean;
  /**
   * A LEGACY grant (authority_unit_id NULL) is involved and its own answer
   * moved between the paths — judged per grant, never per holder: a legacy
   * grant must answer identically whatever else its holder holds (stage D
   * review W2). Always blocking, even when the holder's total answer agrees.
   */
  viaLegacyGrant: boolean;
  /** The row's catalogue locality, or null when its place never resolved. */
  rowLocalityId: string | null;
  /** The row's stored (province, locality) text names 2+ live catalogue rows. */
  rowNameAmbiguous: boolean;
  /** The row's stored locality text is an accent/case variant of its catalogue name. */
  rowNameFoldsToCatalogue: boolean;
  /** Some legacy name pair of the grant holder names the row's catalogue locality. */
  grantNamesRowLocality: boolean;
};

export function classifyShadow(facts: ShadowFacts): ShadowKind | null {
  if (facts.viaLegacyGrant) return "legacy_grant";
  if (facts.namePath === facts.idPath) return null;
  if (facts.namePath) {
    // Only the name path reached it.
    if (facts.rowLocalityId === null) return "unresolved_to_province";
    if (facts.rowNameAmbiguous) return "homonym_split";
    return "other";
  }
  // Only the id path reached it.
  if (facts.grantNamesRowLocality) {
    return facts.rowNameFoldsToCatalogue ? "spelling_join" : "other";
  }
  return "unit_widening";
}

const SEVERITY: Record<ShadowKind, number> = {
  legacy_grant: 5,
  other: 4,
  unit_widening: 3,
  unresolved_to_province: 2,
  homonym_split: 1,
  spelling_join: 0,
};

/** The most severe kind among several disagreements about one subject. */
export function worstShadowKind(kinds: readonly ShadowKind[]): ShadowKind | null {
  let worst: ShadowKind | null = null;
  for (const k of kinds) {
    if (worst === null || SEVERITY[k] > SEVERITY[worst]) worst = k;
  }
  return worst;
}

export type ShadowCounts = Partial<Record<ShadowKind, number>>;

/** The flip gate over a set of counts: no blocking kind may appear. */
export function flipGateVerdict(counts: ShadowCounts): {
  pass: boolean;
  blocking: ShadowCounts;
} {
  const blocking: ShadowCounts = {};
  for (const k of BLOCKING_SHADOW_KINDS) {
    const n = counts[k] ?? 0;
    if (n > 0) blocking[k] = n;
  }
  return { pass: Object.keys(blocking).length === 0, blocking };
}
