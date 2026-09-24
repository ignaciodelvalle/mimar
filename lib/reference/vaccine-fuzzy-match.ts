// Vaccine free-text fuzzy matcher — captura-rápida shared foundation.
//
// Maps owner/vet free Spanish text ("le di la antirrábica", "aplicaron
// quintuple") to VACCINE_CATALOG entries, with a confidence score per
// candidate. Pure function: no fetch, no state, deterministic.
//
// Same house pattern as lib/domain/symptom-matcher.ts (NFD normalize + strip
// diacritics + substring/synonym, no stemming) with two additions justified
// by the closed ~9-entry catalog and the trust-critical nature of the field
// (this feeds a government vaccination registry):
//   - bounded Levenshtein (≤1) for single-word typo tolerance — cheap
//     because the catalog is tiny, so cost is irrelevant.
//   - an explicit "ambiguous tie" rule: if 2+ candidates would each
//     independently qualify for auto-select from the SAME input, none of
//     them does — see `resolveAmbiguousTies` below.
//
// CONSERVATIVE BY DESIGN — this is a government registry feed, not a search
// box. `VACCINE_AUTOSELECT_CONFIDENCE` is the only cutoff callers should use
// to decide "commit automatically" vs "show as a pickable candidate". Every
// tier below the cutoff is intentionally non-committing.

import { type VaccineDef, vaccinesForSpecies } from "@/lib/reference/lookups";
import { normalizeText } from "@/lib/utils/text-normalize";

export type VaccineMatchCandidate = {
  vaccine: VaccineDef;
  /** 0–1, descending. See tier comments in `scoreVaccineAgainstInput`. */
  confidence: number;
};

/**
 * Confidence floor for auto-selection (no user confirmation needed beyond a
 * confirm/edit card). Only two tiers reach this: an exact or whole-word
 * substring match of the vaccine's "root" name, OR a single-edit
 * (Levenshtein ≤1) typo of that root. Every other tier — token overlap,
 * partial fragments — stays below it on purpose: this feeds a government
 * vaccination registry, so ambiguous input must never silently commit.
 */
export const VACCINE_AUTOSELECT_CONFIDENCE = 0.85;

/** Below this, a candidate is noise — dropped from the result entirely. */
const CANDIDATE_FLOOR_CONFIDENCE = 0.3;

/** Spanish connector words stripped out of multi-word roots before computing
 * token overlap, so "tos de las perreras" scores on {tos, perreras} — "de"
 * and "las" matching alone would be a false signal. */
const ROOT_STOPWORDS = new Set(["de", "del", "la", "las", "el", "los"]);

type VaccineRoots = {
  /** Vaccine name with any parenthetical acronym stripped, e.g. "sextuple". */
  root: string;
  /** Parenthetical acronym/synonym if present, e.g. "dhppil", "bordetella". */
  altRoot: string | null;
};

/** Escapes regex metacharacters. Roots are alnum+space after normalization
 * today, but this guards against a future catalog entry introducing one. */
function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Derives the matchable root(s) of a vaccine name from VACCINE_CATALOG
 * itself — no hand-curated lookup table to drift out of sync with the
 * catalog. "Séxtuple (DHPPi-L)" → root "sextuple", altRoot "dhppil".
 */
function deriveRoots(vaccine: VaccineDef): VaccineRoots {
  const normalizedName = normalizeText(vaccine.name);
  const parenMatch = normalizedName.match(/\(([^)]*)\)/);
  const root = normalizedName
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const altRoot = parenMatch ? parenMatch[1].replace(/-/g, "").trim() : null;
  return { root, altRoot: altRoot && altRoot.length > 0 ? altRoot : null };
}

/**
 * Bounded edit-distance check: true iff Levenshtein(a, b) <= 1. Early-exits
 * on length difference and on a second mismatch — no DP matrix needed for a
 * threshold of 1, and the catalog is ~9 entries so even the naive path costs
 * nothing.
 */
function isWithinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const lenDiff = a.length - b.length;
  if (lenDiff < -1 || lenDiff > 1) return false;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];

  if (shorter.length === longer.length) {
    let mismatches = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (shorter[i] !== longer[i]) {
        mismatches += 1;
        if (mismatches > 1) return false;
      }
    }
    return true;
  }

  // `longer` has exactly one extra character — confirm it's a single
  // insertion (equivalently, one deletion from `longer`'s perspective).
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j += 1;
  }
  return true;
}

/** Scores one root string (either the primary root or the altRoot) against
 * the normalized input. Returns 0 when nothing matched at all. */
function scoreRoot(root: string, normalizedInput: string, inputWords: string[]): number {
  if (root.length < 3) return 0; // too short to score safely (e.g. stray "pif" edge case is 3, kept)

  // Tier 1 — exact match: the input IS the root (modulo normalization).
  if (normalizedInput === root) return 0.97;

  // Tier 2 — substring-exact-root: the root appears as a whole word/phrase
  // inside the input ("le di la antirrabica hoy" contains "antirrabica").
  const boundary = new RegExp(`\\b${escapeForRegExp(root)}\\b`);
  if (boundary.test(normalizedInput)) return 0.9;

  // Tier 3 — bounded Levenshtein (<=1) of a single input word against the
  // whole root — catches typos of the full vaccine name ("antirravica").
  for (const word of inputWords) {
    if (Math.abs(word.length - root.length) > 1) continue;
    if (isWithinOneEdit(word, root)) return 0.88;
  }

  // Tier 4 — token overlap: for multi-word roots, partial word overlap
  // (root words minus Spanish stopwords) surfaces the vaccine as a pickable
  // candidate WITHOUT reaching the auto-select cutoff.
  const rootTokens = root.split(" ").filter((t) => t.length >= 3 && !ROOT_STOPWORDS.has(t));
  if (rootTokens.length > 0) {
    const inputWordSet = new Set(inputWords);
    const overlap = rootTokens.filter((t) => inputWordSet.has(t)).length;
    if (overlap > 0) {
      const ratio = overlap / rootTokens.length;
      return 0.45 + 0.15 * ratio; // 0.5–0.6, always below the auto-select cutoff
    }
  }

  return 0;
}

function scoreVaccine(vaccine: VaccineDef, normalizedInput: string, inputWords: string[]): number {
  const { root, altRoot } = deriveRoots(vaccine);
  const rootScore = scoreRoot(root, normalizedInput, inputWords);
  const altScore = altRoot ? scoreRoot(altRoot, normalizedInput, inputWords) : 0;
  return Math.max(rootScore, altScore);
}

/**
 * If 2+ candidates each independently reached the auto-select cutoff from
 * the SAME input (e.g. "no sé si le dieron la quintuple o la sextuple" —
 * both full names literally present), auto-selecting either one would be
 * committing a guess to a government registry. Demote all tied candidates
 * to just below the cutoff — they still surface as pickable candidates,
 * just never as a silent single winner.
 */
function resolveAmbiguousTies(candidates: VaccineMatchCandidate[]): VaccineMatchCandidate[] {
  const atOrAboveCutoff = candidates.filter((c) => c.confidence >= VACCINE_AUTOSELECT_CONFIDENCE);
  if (atOrAboveCutoff.length <= 1) return candidates;

  return candidates.map((c) =>
    c.confidence >= VACCINE_AUTOSELECT_CONFIDENCE
      ? { ...c, confidence: VACCINE_AUTOSELECT_CONFIDENCE - 0.05 }
      : c,
  );
}

/**
 * Matches free Spanish text against the vaccine catalog for a given species.
 * Returns candidates sorted by confidence descending. Empty array when
 * nothing scores above the floor (out-of-catalog text, or a species with no
 * matching entry).
 *
 * Callers: auto-select ONLY when the top candidate's confidence is >=
 * VACCINE_AUTOSELECT_CONFIDENCE AND it is the sole candidate at that level
 * (guaranteed by `resolveAmbiguousTies` above — a caller never needs to
 * re-implement the tie check). Otherwise, show the candidate list and let
 * the user pick ("no es esto" → full form).
 */
export function matchVaccineFreeText(
  freeText: string,
  species: "dog" | "cat" | "other",
): VaccineMatchCandidate[] {
  const normalizedInput = normalizeText(freeText);
  if (normalizedInput.length === 0) return [];

  const inputWords = normalizedInput.split(" ");
  // vaccinesForSpecies already returns the full catalog for "other".
  const pool = vaccinesForSpecies(species);

  // Tier 0 — the input IS a catalog entry's full printed label (modulo
  // normalization). Strict equality cannot be ambiguous — one string cannot
  // equal two distinct catalog names — so this tier is exempt from the
  // ambiguous-tie rule below by construction, and returns immediately.
  //
  // Without it, "Séxtuple (DHPPi-L)" — the EXACT label a picker hands back —
  // never auto-selects: its own root scores 0.9, but Quíntuple's altRoot
  // "dhppi" also whole-word-matches inside "(dhppi-l)" at 0.9, and the tie
  // rule demotes both below the cutoff. The catalog's own label was trapped
  // by its own parenthetical, which locked the atender gate in a confirm loop
  // (found live 2026-08-18: three submits, zero registered doses).
  for (const vaccine of pool) {
    if (normalizeText(vaccine.name) === normalizedInput) {
      return [{ vaccine, confidence: 0.99 }];
    }
  }

  const scored: VaccineMatchCandidate[] = [];
  for (const vaccine of pool) {
    const confidence = scoreVaccine(vaccine, normalizedInput, inputWords);
    if (confidence >= CANDIDATE_FLOOR_CONFIDENCE) {
      scored.push({ vaccine, confidence });
    }
  }

  const resolved = resolveAmbiguousTies(scored);
  resolved.sort((a, b) => b.confidence - a.confidence);
  return resolved;
}
