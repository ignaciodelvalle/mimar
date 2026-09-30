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
//   · a corridor rule with no provenance entry at all.
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
import { AIRLINES, type Airline } from "@/lib/reference/airlines";
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
  const sources = corridor.ruleSources as Record<string, Record<string, unknown> | undefined>;
  for (const ruleType of Object.keys(corridor.rules)) {
    const meta = sources[ruleType];
    entries.push({
      path: `${base} › rules.${ruleType}`,
      kind: "country",
      // A missing provenance entry surfaces as missing fields below.
      meta: meta ?? {},
      leaf: true,
    });
  }
  (corridor.pendingRequirements ?? []).forEach((req, i) => {
    entries.push({
      path: `${base} › pendingRequirements[${i}]`,
      kind: "country",
      meta: { ...req },
      leaf: true,
    });
  });
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

function run(): void {
  const verdict = evaluateReferenceFreshness(SHIPPED_REGISTRY, new Date());
  for (const warning of verdict.warnings) console.warn(`⚠ ${warning}`);
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
