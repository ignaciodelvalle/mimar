// Travel reference-data freshness fence (viajes-fase-2, design D6).
//
// WHAT IT GUARDS. Corridor rules (lib/reference/cross-border-corridors.ts),
// airline policies (lib/reference/airlines.ts) and the curated brachycephalic
// list (lib/reference/brachycephalic-breeds.ts) are regulations and commercial
// policies that change without notice. Each datum carries where it was read
// (`sourceUrl`), when (`lastVerifiedAt`) and until when that reading holds
// (`reviewBy`). This fence keeps that bookkeeping honest.
//
// IT FAILS ONLY ON STRUCTURE — things a commit got wrong:
//   · a missing or non-https `sourceUrl`, or a malformed date;
//   · `reviewBy` before `lastVerifiedAt`, or further out than the TTL
//     (180 days for countries, 90 for airlines and the breed list) — a review
//     date pushed out of reach is a way of never reviewing;
//   · a `lastVerifiedAt` in the future — a dodge, not a verification;
//   · an unverified value with no `note` saying why;
//   · a corridor rule that is a bare value instead of a sourced envelope.
//
// IT NEVER FAILS ON THE CALENDAR. A rule merely past its `reviewBy` is listed
// as a WARNING and the fence exits 0: the passage of time is not a defect in
// the commit being gated, and a merge must not turn red on a Monday because a
// Sunday went by. The UI already renders an expired datum as "Verificá — dato
// sin revisar desde …", so nothing expired is ever presented as certain.
// Re-verification is a scheduled job's work (in the private operations repo),
// not this gate's.
//
// Run:  pnpm lint:travel-freshness
// Exits 0 with warnings listed, or 1 listing every structural error.

import { FRESHNESS_TTL_DAYS, type FreshnessKind, isoDate } from "@/lib/domain/travel-freshness";
import {
  AIRLINES,
  type Airline,
  ROUTE_SUGGESTIONS_REVIEWED_AT,
  ROUTE_SUGGESTIONS_REVIEW_BY,
} from "@/lib/reference/airlines";
import { BRACHYCEPHALIC_BREEDS } from "@/lib/reference/brachycephalic-breeds";
import { CORRIDORS, type Corridor } from "@/lib/reference/cross-border-corridors";

export type ReferenceRegistry = {
  corridors: readonly Corridor[];
  airlines: readonly Airline[];
  brachycephalic: typeof BRACHYCEPHALIC_BREEDS;
};

export type FreshnessVerdict = {
  /** Structural defects — each one fails the fence. */
  errors: string[];
  /** Rules past their review date — listed, never fatal. */
  warnings: string[];
  /** How many entries were checked, so a scan that finds nothing is visible. */
  checked: number;
};

export type Entry = {
  path: string;
  kind: FreshnessKind;
  meta: Record<string, unknown>;
  /** Leaf values carry verification; corridor/airline headers do not. */
  leaf: boolean;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseIsoDate(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms;
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isSourcedLeaf(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    ("sourceUrl" in value || "verification" in value)
  );
}

function corridorEntries(corridor: Corridor): Entry[] {
  const base = `corridor ${corridor.id}`;
  const entries: Entry[] = [{ path: base, kind: "country", meta: { ...corridor }, leaf: false }];
  // Each rule is an envelope carrying its own provenance (design D2). A rule
  // that is not one — a bare value — surfaces as missing fields below.
  for (const [ruleType, envelope] of Object.entries(corridor.rules)) {
    entries.push({
      path: `${base} › rules.${ruleType}`,
      kind: "country",
      meta: isSourcedLeaf(envelope) ? envelope : {},
      leaf: true,
    });
  }
  return entries;
}

function airlineEntries(airline: Airline): Entry[] {
  const base = `airline ${airline.id}`;
  const entries: Entry[] = [{ path: base, kind: "airline", meta: { ...airline }, leaf: false }];
  for (const [modality, rule] of Object.entries(airline.modalities)) {
    if (!rule) continue;
    for (const [field, value] of Object.entries(rule)) {
      const path = `${base} › ${modality}.${field}`;
      if (!isSourcedLeaf(value)) {
        entries.push({ path, kind: "airline", meta: {}, leaf: true });
        continue;
      }
      entries.push({ path, kind: "airline", meta: value, leaf: true });
    }
  }
  return entries;
}

function checkEntry(entry: Entry, today: string, todayMs: number, verdict: FreshnessVerdict) {
  const { path, meta, kind } = entry;
  const errors = verdict.errors;
  if (!isHttpsUrl(meta.sourceUrl)) errors.push(`${path}: sourceUrl missing or not https`);

  const verifiedMs = parseIsoDate(meta.lastVerifiedAt);
  const reviewMs = parseIsoDate(meta.reviewBy);
  if (verifiedMs === null) errors.push(`${path}: lastVerifiedAt missing or not YYYY-MM-DD`);
  if (reviewMs === null) errors.push(`${path}: reviewBy missing or not YYYY-MM-DD`);

  if (verifiedMs !== null && verifiedMs > todayMs) {
    errors.push(`${path}: lastVerifiedAt ${meta.lastVerifiedAt} is in the future`);
  }
  if (verifiedMs !== null && reviewMs !== null) {
    const ttl = FRESHNESS_TTL_DAYS[kind];
    const spanDays = Math.round((reviewMs - verifiedMs) / DAY_MS);
    if (spanDays < 0) {
      errors.push(
        `${path}: reviewBy ${meta.reviewBy} is before lastVerifiedAt ${meta.lastVerifiedAt}`,
      );
    } else if (spanDays > ttl) {
      errors.push(
        `${path}: reviewBy is ${spanDays} days after lastVerifiedAt (TTL ${ttl} for ${kind})`,
      );
    }
  }

  if (entry.leaf) {
    if (meta.verification !== "verified" && meta.verification !== "unverified") {
      errors.push(`${path}: verification must be "verified" or "unverified"`);
    } else if (
      meta.verification === "unverified" &&
      (typeof meta.note !== "string" || meta.note.trim().length === 0)
    ) {
      errors.push(`${path}: unverified without a note saying why`);
    }
  }

  if (reviewMs !== null && typeof meta.reviewBy === "string" && today > meta.reviewBy) {
    verdict.warnings.push(
      `${path}: past its review date ${meta.reviewBy} — re-verify at ${meta.sourceUrl}`,
    );
  }
}

/** Every datum in `registry` that carries (or must carry) provenance. */
export function referenceEntries(registry: ReferenceRegistry): Entry[] {
  return [
    ...registry.corridors.flatMap(corridorEntries),
    ...registry.airlines.flatMap(airlineEntries),
    {
      path: "brachycephalic list",
      kind: "airline",
      meta: { ...registry.brachycephalic },
      leaf: true,
    },
  ];
}

/** Pure: every structural error and every expired rule in `registry` at `now`. */
export function evaluateReferenceFreshness(
  registry: ReferenceRegistry,
  now: Date,
): FreshnessVerdict {
  const today = isoDate(now);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const entries = referenceEntries(registry);
  const verdict: FreshnessVerdict = { errors: [], warnings: [], checked: entries.length };
  for (const entry of entries) checkEntry(entry, today, todayMs, verdict);
  return verdict;
}

export const SHIPPED_REGISTRY: ReferenceRegistry = {
  corridors: CORRIDORS,
  airlines: AIRLINES,
  brachycephalic: BRACHYCEPHALIC_BREEDS,
};

/**
 * The destination → airline suggestions (`servesCorridors`) have no source per
 * row — miMAR maintains them (PO 2026-10-07) — so they are not an Entry; they
 * share the airlines' 90-day clock and WARN past it, like every other datum.
 */
export function routeSuggestionsWarning(now: Date): string | null {
  return isoDate(now) > ROUTE_SUGGESTIONS_REVIEW_BY
    ? `airline route suggestions (servesCorridors): past their review date ${ROUTE_SUGGESTIONS_REVIEW_BY} (reviewed ${ROUTE_SUGGESTIONS_REVIEWED_AT}) — re-check which airlines fly each destination`
    : null;
}

function run(): void {
  const verdict = evaluateReferenceFreshness(SHIPPED_REGISTRY, new Date());
  for (const warning of verdict.warnings) console.warn(`⚠ ${warning}`);
  const routes = routeSuggestionsWarning(new Date());
  if (routes) console.warn(`⚠ ${routes}`);
  if (verdict.errors.length > 0) {
    console.error(`✗ Travel reference freshness: ${verdict.errors.length} structural error(s):`);
    for (const error of verdict.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  const expired =
    verdict.warnings.length > 0
      ? ` ${verdict.warnings.length} past their review date (warning only).`
      : "";
  console.log(`✓ Travel reference freshness — ${verdict.checked} entries well-formed.${expired}`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  /check-travel-reference-freshness\.(?:ts|js)$/.test(process.argv[1].replaceAll("\\", "/"));

if (isMain) {
  run();
}
