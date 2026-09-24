// Symptom matcher — maps owner free-text to disease alerts.
//
// Pipeline: normalize → matchSymptoms → aggregateDiseaseMatches → detectAlertableDiseases
//
// The matcher is intentionally simple: substring-contains of normalized synonyms.
// No stemming, no Levenshtein. Covers ~80% of real inputs without overengineering.
// Iterate synonyms with production data rather than complicating the algorithm.
//
// See docs/superpowers/specs/2026-05-17-symptom-disease-surveillance-design.md §4.2.

import { findDisease } from "@/lib/reference/diseases";
import { SYMPTOMS } from "@/lib/reference/symptoms";
import { normalizeText } from "@/lib/utils/text-normalize";

export type MatchedSymptom = {
  symptom_code: string;
  matched_synonym: string;
};

export type DiseaseMatch = {
  disease_code: string;
  disease_label: string;
  is_reportable: boolean;
  high_count: number;
  medium_count: number;
  low_count: number;
  matched_symptoms: string[]; // symptom codes
  /** triggers alert when high>=1 OR medium>=2 */
  triggers_alert: boolean;
};

/**
 * Normalize a string for fuzzy matching: lowercase, strip diacritics (NFD),
 * collapse whitespace. Conservative — no stemming (Spanish stemming is non-trivial).
 *
 * Re-exported from the canonical implementation at lib/utils/text-normalize.ts
 * (shared with lib/domain/vaccine-reminder-state.ts and
 * lib/reference/vaccine-fuzzy-match.ts).
 */
export const normalize = normalizeText;

/**
 * Match free-text input against the symptom catalog.
 *
 * For each symptom, checks whether ANY of its synonyms appears as a substring
 * of the normalized input. Multiple matches for the same symptom collapse to
 * one (uniqueness on symptom_code).
 *
 * Filters by species if provided (null or "other" = no filter).
 *
 * Returns an empty array if no matches.
 */
export function matchSymptoms(freeText: string, species: string | null): MatchedSymptom[] {
  const normalizedInput = normalize(freeText);
  if (normalizedInput.length === 0) return [];

  const matches: MatchedSymptom[] = [];
  const seenCodes = new Set<string>();

  for (const symptom of SYMPTOMS) {
    if (
      species &&
      species !== "other" &&
      !symptom.species.includes("any" as never) &&
      !symptom.species.includes(species as never)
    ) {
      continue;
    }

    for (const synonym of symptom.synonyms) {
      const normSynonym = normalize(synonym);
      if (normalizedInput.includes(normSynonym)) {
        if (!seenCodes.has(symptom.code)) {
          matches.push({ symptom_code: symptom.code, matched_synonym: synonym });
          seenCodes.add(symptom.code);
        }
        break; // one synonym match per symptom is enough
      }
    }
  }

  return matches;
}

/**
 * Aggregate matched symptoms into per-disease counts and decide which
 * diseases meet the alert threshold.
 *
 * Alert trigger rules (per spec D6):
 *   - 1 high-specificity match → alert
 *   - 2+ medium-specificity matches → alert
 *   - Only low-specificity matches → no alert
 *
 * Results are sorted: alerts first, then by total specificity weight desc.
 */
export function aggregateDiseaseMatches(matchedSymptoms: MatchedSymptom[]): DiseaseMatch[] {
  const perDisease = new Map<
    string,
    {
      high: number;
      medium: number;
      low: number;
      symptoms: Set<string>;
    }
  >();

  for (const m of matchedSymptoms) {
    const symptom = SYMPTOMS.find((s) => s.code === m.symptom_code);
    if (!symptom) continue;
    for (const link of symptom.related_diseases) {
      const agg = perDisease.get(link.disease_code) ?? {
        high: 0,
        medium: 0,
        low: 0,
        symptoms: new Set<string>(),
      };
      agg[link.specificity] += 1;
      agg.symptoms.add(m.symptom_code);
      perDisease.set(link.disease_code, agg);
    }
  }

  const results: DiseaseMatch[] = [];
  for (const [disease_code, agg] of perDisease) {
    const disease = findDisease(disease_code);
    if (!disease) continue;
    const triggersAlert = agg.high >= 1 || agg.medium >= 2;
    results.push({
      disease_code,
      disease_label: disease.label,
      is_reportable: disease.reportable,
      high_count: agg.high,
      medium_count: agg.medium,
      low_count: agg.low,
      matched_symptoms: Array.from(agg.symptoms),
      triggers_alert: triggersAlert,
    });
  }

  // Sort: alerts first, then by total specificity weight desc.
  results.sort((a, b) => {
    if (a.triggers_alert !== b.triggers_alert) return a.triggers_alert ? -1 : 1;
    const wA = a.high_count * 3 + a.medium_count * 2 + a.low_count;
    const wB = b.high_count * 3 + b.medium_count * 2 + b.low_count;
    return wB - wA;
  });

  return results;
}

/**
 * Full pipeline: free text → matched symptoms → disease matches → only those
 * that trigger an alert AND are reportable.
 *
 * This is the canonical surface used by the server action when emitting
 * outbreak_signal events. The caller wraps this in try/catch — the matcher
 * itself is deterministic and does not throw, but defense in depth lives at
 * the call site.
 */
export function detectAlertableDiseases(freeText: string, species: string | null): DiseaseMatch[] {
  const matched = matchSymptoms(freeText, species);
  const aggregated = aggregateDiseaseMatches(matched);
  return aggregated.filter((d) => d.triggers_alert && d.is_reportable);
}
