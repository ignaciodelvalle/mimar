// filter-commit — shared URL-param commit strategies for the searchParam-
// driven filter components (RANK 2 consolidation: PeriodPicker.tsx,
// JurisdictionSwitcher.tsx, UrlTabs.tsx).
//
// The three components above each hand-rolled an identical `updateParams`
// body: clone the current searchParams, apply a set of updates (delete the
// key when the new value is null/"", otherwise set it), optionally drop a
// caller-nominated list of stale keys, then commit via
// `window.location.assign` — the SANCTIONED workaround for Next 15.5.18's
// router-drop defect (engram #621/#622; see the design notes in
// JurisdictionSwitcher.tsx / PeriodPicker.tsx / UrlTabs.tsx for the full
// history). This module gives that body ONE home so the three callers can't
// silently drift from each other, without changing what the navigation does.

export type CommitStrategy = (
  updates: Record<string, string | null>,
  drop?: readonly string[],
) => void;

/**
 * The sanctioned workaround: commit `updates` onto a snapshot of the current
 * searchParams (`searchParamsString`, typically `searchParams.toString()`
 * taken at call time) via a full document navigation
 * (`window.location.assign`).
 *
 * - A `null` or `""` value in `updates` DELETES that key.
 * - Any other value SETS that key.
 * - `drop` (optional) removes additional keys AFTER updates are applied —
 *   e.g. the Panorama camera params (`z`/`lat`/`lng`) that JurisdictionSwitcher
 *   drops on a scope change because a camera framed for the old scope is
 *   invalid for the new one.
 *
 * Byte-identical to the three pre-consolidation `updateParams` bodies for
 * every input they could previously produce.
 */
export function serverNavCommit(searchParamsString: string): CommitStrategy {
  return (updates, drop = []) => {
    const params = new URLSearchParams(searchParamsString);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    for (const key of drop) params.delete(key);
    window.location.assign(`?${params.toString()}`);
  };
}

/**
 * Wraps a caller-supplied shallow commit (History pushState + client
 * refetch — the Panorama console's `onPeriodChange`/`onScopeCommit` pattern)
 * in the same `CommitStrategy` shape as `serverNavCommit`, so a component
 * that supports both commit mechanisms can pick one without a different call
 * signature.
 *
 * Not wired into Panorama in this consolidation (out of scope — see the
 * RANK 4 note in the calling components); this is a home for the shape, not
 * a behavior change for any current caller.
 */
export function makeShallowCommit(
  onCommit: (updates: Record<string, string | null>, drop?: readonly string[]) => void,
): CommitStrategy {
  return (updates, drop) => onCommit(updates, drop);
}
