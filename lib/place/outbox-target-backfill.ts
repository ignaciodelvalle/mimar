// Historic outbox target places — localidades-por-id (the rows queued before
// the enqueue snapshotted target_locality_id, c20e9163c).
//
// A row's target names were taken at enqueue time from the bite case it was
// routed to, or from the animal's home at that moment. This fills its target
// row from the same kinds of source, read from the record, never from the
// pet's CURRENT home:
//   1. a bite case of the event's animal whose (province, locality) is exactly
//      the row's target names — its locality_id and place_method;
//   2. else the source event's own place (event_places: the event's resolved
//      place, or its home per the spine for history) with the same names.
// A source that never resolved gives NULL + 'unresolved'. Two matching
// sources of the same kind that disagree, or no matching source at all,
// decide NOTHING: the row keeps NULL/NULL ("not recorded"), never a guess.
// So does a source whose method the outbox column cannot record: an
// event_places row settled by a projection-only method (0291
// `homonym_by_coordinates`) is not in the 0248 `target_place_method` CHECK,
// and relabelling it would claim a method that did not happen.
//
// Pure. The writer is scripts/place-backfill-outbox-targets.ts.

import { PLACE_METHODS } from "@/lib/domain/place";

const RECORDABLE: ReadonlySet<string> = new Set(PLACE_METHODS);

export type TargetSource = {
  source: "case" | "event";
  province: string | null;
  locality: string | null;
  localityId: string | null;
  method: string | null;
};

export type OutboxTargetPlan = { localityId: string | null; placeMethod: string };

function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "") === (b ?? "");
}

function decide(matches: readonly TargetSource[]): OutboxTargetPlan | null | "none" {
  if (matches.length === 0) return "none";
  const ids = new Set(matches.map((m) => m.localityId));
  if (ids.size > 1) return null;
  const first = matches[0] as TargetSource;
  if (first.localityId === null) return { localityId: null, placeMethod: "unresolved" };
  if (first.method !== null && !RECORDABLE.has(first.method)) return null;
  return { localityId: first.localityId, placeMethod: first.method ?? "catalogue_id" };
}

export function planOutboxTarget(
  row: { targetProvince: string | null; targetLocality: string | null },
  sources: readonly TargetSource[],
): OutboxTargetPlan | null {
  const named = sources.filter(
    (s) => sameName(s.province, row.targetProvince) && sameName(s.locality, row.targetLocality),
  );
  const byCase = decide(named.filter((s) => s.source === "case"));
  if (byCase !== "none") return byCase;
  const byEvent = decide(named.filter((s) => s.source === "event"));
  return byEvent === "none" ? null : byEvent;
}
