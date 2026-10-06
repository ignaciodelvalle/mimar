// The name an UNRESOLVED event_places row carries, and what one pass of the
// resolver makes of it — localidades CABA + Córdoba (2026-10), PO decision
// 2026-10-06 ("pasada por nombre único").
//
// WHY
// ---
// `place:backfill-event-places` placed every historic event at the pet's home
// per spine, but a home the spine recorded by NAME alone (no
// `jurisdiction_locality_id`, no `to_locality_id`: seeds older than the id
// field) is written UNRESOLVED on purpose — the planner never matches a name
// (P1). On staging that was 141,427 of 141,935 rows, so the panorama read on
// the id path would show nearly everything as "Sin localidad".
//
// The name is still there, in `entered`. This module reads it out of every
// shape `entered` takes, and sorts what THE resolver (resolveName, steps 2-3:
// a name only when it names exactly one live row of the province, never the
// first homonym) answered into three verdicts:
//
//   unique     one row: the pass may write it, with the resolver's own method
//              (exact_name_unique or folded_name_unique);
//   ambiguous  two or more rows share the name: left alone, for a person;
//   none       the catalogue does not know it, or there is no name / no
//              province to look it up in: left alone.
//
// ONLY SPINE-SHAPED ROWS ARE EVER WRITTEN. A row in the 0250 trigger's shape
// is the projection of an event's own `place`, and "unresolved" there can be a
// deliberate verdict of the report policy (lib/place/reported-place.ts: a pin
// that disagrees with the typed name, for one), not a missing id. 0275
// excludes such rows for the same reason. They are counted, never written:
// `writableRows` is the spine-shaped part of a pair.
//
// Pure: no database. The pass is lib/place/event-places-name-pass.ts and the
// operator door is scripts/place-resolve-event-places-by-name.ts.

import type { ResolvedPlace } from "@/lib/place/resolve-place";
import { provinceByCode, provinceByName } from "@/lib/reference/ar-provincias";

/**
 * Where the name came from, i.e. who wrote the `entered` object:
 *   spine        the historic backfill: {province, locality, source: "spine",
 *                spine_event_id} — the pet's home per spine at the event;
 *   event_place  the 0250 trigger: the event's own `place.entered`
 *                ({province, locality, indec_id, ...}); `province` may be a
 *                name or an ISO code;
 *   unknown      an object with neither shape (counted, never resolved).
 */
export type EnteredShape = "spine" | "event_place" | "unknown";

export type EnteredName = {
  shape: EnteredShape;
  /** The row's own province_code when set, else the code the entered province names. */
  provinceCode: string | null;
  /** The province as entered, trimmed (a name, an alias or a code); for the report. */
  enteredProvince: string | null;
  /** The locality name as entered, trimmed; null when absent or blank. */
  locality: string | null;
};

export type NameVerdict = "unique" | "ambiguous" | "none";

/** Why a `none` verdict: what was missing. */
export type NoneReason = "no_locality" | "unknown_province" | "not_in_catalogue";

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** The shape of an `entered` object, by its keys alone. */
export function enteredShape(entered: unknown): EnteredShape {
  if (!entered || typeof entered !== "object" || Array.isArray(entered)) return "unknown";
  const o = entered as Record<string, unknown>;
  if (o.source === "spine" && "spine_event_id" in o) return "spine";
  if ("province" in o || "locality" in o) return "event_place";
  return "unknown";
}

/**
 * The (province code, locality name) an unresolved row asks about.
 *
 * `rowProvinceCode` is event_places.province_code: the backfill and the
 * trigger already turned the entered province into a code where they could,
 * and that code wins. Only when it is null is the entered province read here —
 * as an ISO code first, then as a name or alias.
 */
export function extractEnteredName(entered: unknown, rowProvinceCode: string | null): EnteredName {
  const shape = enteredShape(entered);
  if (shape === "unknown") {
    return { shape, provinceCode: text(rowProvinceCode), enteredProvince: null, locality: null };
  }
  const o = entered as Record<string, unknown>;
  const province = text(o.province);
  const code =
    text(rowProvinceCode) ??
    provinceByCode(province)?.code ??
    provinceByName(province)?.code ??
    null;
  return { shape, provinceCode: code, enteredProvince: province, locality: text(o.locality) };
}

/** Why a pair cannot even be asked about, or null when it can. */
export function unaskable(name: Pick<EnteredName, "provinceCode" | "locality">): NoneReason | null {
  if (!name.locality) return "no_locality";
  if (!name.provinceCode || !provinceByCode(name.provinceCode)) return "unknown_province";
  return null;
}

/**
 * The verdict for what resolveName answered. `unique` needs BOTH the resolved
 * status and an id: a resolved answer without a row is not something to write.
 */
export function verdictOf(answer: Pick<ResolvedPlace, "status" | "localityId">): NameVerdict {
  if (answer.status === "resolved" && answer.localityId) return "unique";
  if (answer.status === "ambiguous") return "ambiguous";
  return "none";
}

/** The resolver methods a name match can carry (both allowed by the 0250 CHECK). */
export type NameMethod = "exact_name_unique" | "folded_name_unique";

export type ClassifiedPair = {
  provinceCode: string | null;
  /** The first entered province text seen for the pair (report only). */
  enteredProvince: string | null;
  locality: string | null;
  /** How many unresolved rows carry this pair, whatever their shape. */
  rows: number;
  /** How many of them are spine-shaped: the only rows the pass may write. */
  writableRows: number;
  verdict: NameVerdict;
  /** Set only on `unique`. */
  localityId: string | null;
  /** How the resolver matched; set only on `unique`. */
  method: NameMethod | null;
  /** Set only on `none`. */
  noneReason: NoneReason | null;
};

export type Projection = {
  pairs: { unique: number; ambiguous: number; none: number };
  rows: { unique: number; ambiguous: number; none: number };
  noneRowsBy: Record<NoneReason, number>;
  /** Unique rows the pass writes (spine-shaped), split by resolver method. */
  write: { rows: number; exactRows: number; foldedRows: number };
  /** Unique rows held back because they are not spine-shaped. */
  heldUniqueRows: number;
  before: { resolved: number; unresolved: number };
  after: { resolved: number; unresolved: number };
};

/**
 * Totals before and after the pass writes every spine-shaped `unique` row.
 * `resolved` and `unresolved` are the table's counts now; only those rows move.
 */
export function project(
  pairs: readonly ClassifiedPair[],
  before: { resolved: number; unresolved: number },
): Projection {
  const out: Projection = {
    pairs: { unique: 0, ambiguous: 0, none: 0 },
    rows: { unique: 0, ambiguous: 0, none: 0 },
    noneRowsBy: { no_locality: 0, unknown_province: 0, not_in_catalogue: 0 },
    write: { rows: 0, exactRows: 0, foldedRows: 0 },
    heldUniqueRows: 0,
    before: { ...before },
    after: { ...before },
  };
  for (const p of pairs) {
    out.pairs[p.verdict] += 1;
    out.rows[p.verdict] += p.rows;
    if (p.verdict === "none") out.noneRowsBy[p.noneReason ?? "not_in_catalogue"] += p.rows;
    if (p.verdict === "unique") {
      out.write.rows += p.writableRows;
      if (p.method === "folded_name_unique") out.write.foldedRows += p.writableRows;
      else out.write.exactRows += p.writableRows;
      out.heldUniqueRows += p.rows - p.writableRows;
    }
  }
  out.after = {
    resolved: before.resolved + out.write.rows,
    unresolved: before.unresolved - out.write.rows,
  };
  return out;
}
