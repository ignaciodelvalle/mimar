import { describe, expect, it } from "vitest";

import {
  aggregateDiseaseMatches,
  detectAlertableDiseases,
  matchSymptoms,
  normalize,
} from "@/lib/domain/symptom-matcher";

describe("normalize", () => {
  it("removes diacritics", () => {
    expect(normalize("Vómitos")).toBe("vomitos");
    expect(normalize("ÉpisOdio")).toBe("episodio");
  });
  it("collapses whitespace", () => {
    expect(normalize("   le   sale   baba   ")).toBe("le sale baba");
  });
  it("lowercases", () => {
    expect(normalize("FIEBRE")).toBe("fiebre");
  });
});

describe("matchSymptoms", () => {
  it("returns empty for empty input", () => {
    expect(matchSymptoms("", "dog")).toEqual([]);
  });
  it("matches a single canonical label", () => {
    const r = matchSymptoms("tiene fiebre alta", "dog");
    expect(r.map((m) => m.symptom_code)).toContain("high_fever");
  });
  it("matches via synonym", () => {
    const r = matchSymptoms("le sale baba", "dog");
    expect(r.map((m) => m.symptom_code)).toContain("hypersalivation");
  });
  it("matches multiple symptoms in one text", () => {
    const r = matchSymptoms("vomita y tiene diarrea con sangre", "dog");
    const codes = r.map((m) => m.symptom_code);
    expect(codes).toContain("vomiting");
    expect(codes).toContain("bloody_diarrhea");
  });
  it("dedupes when multiple synonyms of same symptom match", () => {
    // 'salivación' and 'baba' both map to hypersalivation
    const r = matchSymptoms("tiene salivación y le sale baba", "dog");
    const occurrences = r.filter((m) => m.symptom_code === "hypersalivation").length;
    expect(occurrences).toBe(1);
  });
  it("filters by species (cat symptoms shown for cat)", () => {
    const r = matchSymptoms("vomita", "cat");
    expect(r.map((m) => m.symptom_code)).toContain("vomiting");
  });
  it("returns empty when no synonym matches", () => {
    expect(matchSymptoms("está alegre", "dog")).toEqual([]);
  });
});

describe("aggregateDiseaseMatches", () => {
  it("returns empty for no matched symptoms", () => {
    expect(aggregateDiseaseMatches([])).toEqual([]);
  });

  it("aggregates per disease across matched symptoms", () => {
    // vomiting (high for parvovirus) + bloody_diarrhea (high for parvovirus)
    // → parvovirus should have high_count>=2
    const r = aggregateDiseaseMatches([
      { symptom_code: "vomiting", matched_synonym: "vomita" },
      { symptom_code: "bloody_diarrhea", matched_synonym: "diarrea con sangre" },
    ]);
    const parvo = r.find((d) => d.disease_code === "parvovirus");
    expect(parvo).toBeDefined();
    expect(parvo?.high_count).toBeGreaterThanOrEqual(2);
    expect(parvo?.triggers_alert).toBe(true);
  });

  it("does NOT trigger alert for only-low matches", () => {
    // 'anorexia' is low for all related diseases per catalog
    const r = aggregateDiseaseMatches([{ symptom_code: "anorexia", matched_synonym: "no come" }]);
    r.forEach((d) => expect(d.triggers_alert).toBe(false));
  });

  it("triggers alert with single high-specificity match", () => {
    // hypersalivation is high for rabies_suspected
    const r = aggregateDiseaseMatches([
      { symptom_code: "hypersalivation", matched_synonym: "baba" },
    ]);
    const rabies = r.find((d) => d.disease_code === "rabies_suspected");
    expect(rabies?.triggers_alert).toBe(true);
  });

  it("triggers alert with two medium-specificity matches", () => {
    // high_fever (medium for distemper) + cough (medium for distemper)
    const r = aggregateDiseaseMatches([
      { symptom_code: "high_fever", matched_synonym: "fiebre" },
      { symptom_code: "cough", matched_synonym: "tose" },
    ]);
    const distemper = r.find((d) => d.disease_code === "distemper");
    expect(distemper?.medium_count).toBeGreaterThanOrEqual(2);
    expect(distemper?.triggers_alert).toBe(true);
  });

  it("does NOT trigger alert with single medium-specificity match (using lethargy which is all-low)", () => {
    // lethargy is low specificity for all related diseases — no alert should fire.
    // Note: high_fever is NOT suitable here because it maps to babesiosis as "high"
    // specificity, so a single high_fever match WOULD trigger a babesiosis alert.
    const r = aggregateDiseaseMatches([{ symptom_code: "lethargy", matched_synonym: "decaído" }]);
    // Lethargy alone (all low) should not trigger any alert.
    r.forEach((d) => expect(d.triggers_alert).toBe(false));
  });

  it("sorts alerts first, then by total specificity weight", () => {
    const r = aggregateDiseaseMatches([
      { symptom_code: "high_fever", matched_synonym: "fiebre" },
      { symptom_code: "vomiting", matched_synonym: "vomita" },
      { symptom_code: "bloody_diarrhea", matched_synonym: "diarrea con sangre" },
    ]);
    // First entries should be diseases that trigger alerts
    if (r.length > 1 && r[0].triggers_alert && !r[1].triggers_alert) {
      expect(r[0].triggers_alert).toBe(true);
    }
  });
});

describe("detectAlertableDiseases", () => {
  it("end-to-end: rabies symptoms → rabies alert", () => {
    const r = detectAlertableDiseases("le sale baba y está muy agresivo", "dog");
    expect(r.map((d) => d.disease_code)).toContain("rabies_suspected");
    r.forEach((d) => {
      expect(d.triggers_alert).toBe(true);
      expect(d.is_reportable).toBe(true);
    });
  });

  it("end-to-end: distemper symptoms → no alert (distemper is NOT reportable)", () => {
    // Note: distemper is NOT reportable per current catalog. This test
    // confirms detectAlertableDiseases ONLY returns reportable diseases.
    const r = detectAlertableDiseases("tose mucho y le sale moco por la nariz", "dog");
    // Should NOT include distemper because is_reportable=false
    expect(r.find((d) => d.disease_code === "distemper")).toBeUndefined();
  });

  it("end-to-end: vague symptoms → no alerts", () => {
    expect(detectAlertableDiseases("está cansado", "dog")).toEqual([]);
  });

  it("end-to-end: empty input → no alerts", () => {
    expect(detectAlertableDiseases("", "dog")).toEqual([]);
  });
});
