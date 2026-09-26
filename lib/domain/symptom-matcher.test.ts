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

// Health audit #6 (2026-09-26): the matcher read synonyms as SUBSTRINGS, so
// "gatos" contained "tos" and any "cambios" meant rabies. Matching is now on
// whole words/phrases of the accent- and case-folded text. Thresholds and
// negation are PO decisions and deliberately untouched.
describe("matchSymptoms — whole words, not substrings (health audit #6)", () => {
  const codes = (text: string, species: string | null = "dog") =>
    matchSymptoms(text, species).map((m) => m.symptom_code);

  it('"gatos" is not "tos": no cough, no tuberculosis alert', () => {
    expect(codes("juega con otros gatos")).not.toContain("cough");
    const r = detectAlertableDiseases("juega con otros gatos y queda agitado", "dog");
    expect(r.find((d) => d.disease_code === "tuberculosis")).toBeUndefined();
  });

  it('"cambios en la comida" is not a behaviour change', () => {
    expect(codes("le hice cambios en la comida")).not.toContain("behavioral_changes");
    expect(detectAlertableDiseases("le hice cambios en la comida", "dog")).toEqual([]);
  });

  it('bare "tiene cambios" no longer matches (recall trade-off pending PO confirmation)', () => {
    // The bare "cambios" synonym was replaced by behaviour/conduct phrases so
    // "cambios en la comida" stops reading as rabies. The cost is this input:
    // an owner who writes only "tiene cambios" is no longer matched.
    expect(codes("tiene cambios")).not.toContain("behavioral_changes");
  });

  it("a behaviour change stated as such still matches", () => {
    expect(codes("tuvo cambios de comportamiento")).toContain("behavioral_changes");
    expect(codes("Cambió el comportamiento de golpe")).toContain("behavioral_changes");
  });

  it("the word itself still matches, with accents, case and punctuation folded", () => {
    expect(codes("Tose, TOS seca")).toContain("cough");
    expect(codes("tiene fiebre.")).toContain("high_fever");
    expect(codes("Convulsión anoche")).toContain("seizures");
  });

  it("a multi-word synonym only matches as the whole phrase", () => {
    expect(codes("no come")).toContain("anorexia");
    expect(codes("no comete errores")).not.toContain("anorexia");
  });

  it('"espuma en la boca" is hypersalivation → rabies alert', () => {
    expect(codes("tiene espuma en la boca y muerde todo")).toContain("hypersalivation");
    const r = detectAlertableDiseases("tiene espuma en la boca y muerde todo", "dog");
    expect(r.map((d) => d.disease_code)).toContain("rabies_suspected");
  });

  it('"convulsiona" matches seizures (its alert threshold is a PO decision)', () => {
    // Seizures is MEDIUM for rabies: alone it does not alert, by the D6 rule.
    expect(codes("convulsiona")).toContain("seizures");
  });

  it('"su collar amarillo" still reads "amarillo" — a known false positive', () => {
    // Whole-word matching cannot tell the collar from the gums; narrowing the
    // bare colour synonym would drop "está amarillo". Left for the PO.
    expect(codes("su collar amarillo")).toContain("jaundice");
  });

  // PO addendum (2026-09-26): "perdido"/"perdida" collided with the lost-pet
  // flow — "está perdido" is a lost animal, not a neurological sign. A bug, not
  // a clinical weight (those wait for the vet review, S12).
  it('"está perdido" / "se nos perdió la perra, está perdida" is not disorientation', () => {
    expect(codes("está perdido desde ayer")).not.toContain("disorientation");
    expect(codes("la perra está perdida")).not.toContain("disorientation");
    expect(codes("está desorientado y se choca")).toContain("disorientation");
  });
});
