// UI-4 fix 1 — sex-aware lost-mode copy helpers.
//
// Pure-function tests for the gendered wording used in the public credential,
// the cockpit, and the recovery notifications. Verifies male/female/unknown
// all map to natural es-AR forms and that nullish/garbage sex falls back to the
// neutral phrasing instead of assuming a gender.

import { describe, expect, it } from "vitest";

import {
  foundParticiple,
  foundPossessivePhrase,
  foundReportPrompt,
  lastSeenHeadingLabel,
  lostBannerHeadline,
  lostFirstPersonLine,
  lostPosterHeadline,
  lostReportedTitle,
  lostSeenCallout,
  lostShareMessage,
  lostThirdPersonPhrase,
  markLostActionLabel,
  markLostFirstPrompt,
  registeredAdjective,
  sightedWhenQuestion,
  sightingPhrase,
  situationLabelForSex,
} from "@/lib/utils/format";

describe("lostBannerHeadline", () => {
  it("genders by sex", () => {
    expect(lostBannerHeadline("male")).toBe("ESTÁ PERDIDO");
    expect(lostBannerHeadline("female")).toBe("ESTÁ PERDIDA");
  });
  it("uses a neutral phrasing for unknown/null/garbage", () => {
    expect(lostBannerHeadline("unknown")).toBe("SE PERDIÓ");
    expect(lostBannerHeadline(null)).toBe("SE PERDIÓ");
    expect(lostBannerHeadline(undefined)).toBe("SE PERDIÓ");
    expect(lostBannerHeadline("nonsense")).toBe("SE PERDIÓ");
  });
});

describe("lostFirstPersonLine", () => {
  it("genders by sex", () => {
    expect(lostFirstPersonLine("male")).toBe("Estoy perdido");
    expect(lostFirstPersonLine("female")).toBe("Estoy perdida");
  });
  it("neutral for unknown", () => {
    expect(lostFirstPersonLine("unknown")).toBe("Me perdí");
    expect(lostFirstPersonLine(null)).toBe("Me perdí");
  });
});

describe("lostThirdPersonPhrase", () => {
  it("genders by sex", () => {
    expect(lostThirdPersonPhrase("male")).toBe("está perdido");
    expect(lostThirdPersonPhrase("female")).toBe("está perdida");
  });
  it("neutral for unknown", () => {
    expect(lostThirdPersonPhrase("unknown")).toBe("se perdió");
    expect(lostThirdPersonPhrase(null)).toBe("se perdió");
  });
});

describe("foundParticiple", () => {
  it("genders by sex", () => {
    expect(foundParticiple("male")).toBe("encontrado");
    expect(foundParticiple("female")).toBe("encontrada");
  });
  it("inclusive form for unknown", () => {
    expect(foundParticiple("unknown")).toBe("encontrada/o");
    expect(foundParticiple(null)).toBe("encontrada/o");
  });
});

describe("foundPossessivePhrase", () => {
  it("genders by sex", () => {
    expect(foundPossessivePhrase("male")).toBe("Lo tengo conmigo");
    expect(foundPossessivePhrase("female")).toBe("La tengo conmigo");
  });
  it("neutral for unknown", () => {
    expect(foundPossessivePhrase("unknown")).toBe("Está conmigo");
    expect(foundPossessivePhrase(null)).toBe("Está conmigo");
    expect(foundPossessivePhrase(undefined)).toBe("Está conmigo");
  });
});

// QA histórico 2026-07-08 item 2: "La vi cerca de acá" was hardcoded feminine
// on the sighting-form page headline and the lost public credential's CTA
// button, disagreeing with the pet's recorded sex (e.g. showing feminine for
// a male pet). Both surfaces now route through this helper.
describe("sightingPhrase", () => {
  it("genders by sex", () => {
    expect(sightingPhrase("male")).toBe("Lo vi cerca de acá");
    expect(sightingPhrase("female")).toBe("La vi cerca de acá");
  });
  it("neutral for unknown/null/garbage", () => {
    expect(sightingPhrase("unknown")).toBe("Vi a la mascota cerca de acá");
    expect(sightingPhrase(null)).toBe("Vi a la mascota cerca de acá");
    expect(sightingPhrase(undefined)).toBe("Vi a la mascota cerca de acá");
    expect(sightingPhrase("nonsense")).toBe("Vi a la mascota cerca de acá");
  });
});

describe("foundReportPrompt", () => {
  it("genders by sex (voseo imperative + enclitic pronoun)", () => {
    expect(foundReportPrompt("male")).toBe("¿Lo encontraste? Reportalo");
    expect(foundReportPrompt("female")).toBe("¿La encontraste? Reportala");
  });
  it("neutral for unknown/null/garbage", () => {
    expect(foundReportPrompt("unknown")).toBe("¿Encontraste a esta mascota? Reportá");
    expect(foundReportPrompt(null)).toBe("¿Encontraste a esta mascota? Reportá");
    expect(foundReportPrompt(undefined)).toBe("¿Encontraste a esta mascota? Reportá");
    expect(foundReportPrompt("nonsense")).toBe("¿Encontraste a esta mascota? Reportá");
  });
});

// QA histórico 2026-07-08 item 2 (round 2): the pet credential's registration
// badge showed "Rocco Inscripta" — feminine on a male pet, because
// CredentialFace hardcoded "Inscripta" instead of routing through a
// sex-aware helper. The word moved to "Registrado/a" (PO 2026-07-30) — the
// gender agreement contract is unchanged, only the lexeme.
describe("registeredAdjective", () => {
  it("genders by sex", () => {
    expect(registeredAdjective("male")).toBe("Registrado");
    expect(registeredAdjective("female")).toBe("Registrada");
  });
  it("neutral for unknown/null/garbage", () => {
    expect(registeredAdjective("unknown")).toBe("Registrado/a");
    expect(registeredAdjective(null)).toBe("Registrado/a");
    expect(registeredAdjective(undefined)).toBe("Registrado/a");
    expect(registeredAdjective("nonsense")).toBe("Registrado/a");
  });
  // The credential must never resurrect the old lexeme.
  it("never returns the retired 'Inscripto/a' wording", () => {
    for (const sex of ["male", "female", "unknown", null, undefined]) {
      expect(registeredAdjective(sex)).not.toMatch(/Inscript/i);
    }
  });
});

// Same QA finding: the credential's situation skin (lib/ui/pet-situation.ts)
// carries feminine-default adjective labels ("Perdida", "Fallecida") that
// must also agree with a male pet's sex on the credential surface.
describe("situationLabelForSex", () => {
  it("genders the adjective labels for a male pet", () => {
    expect(situationLabelForSex("Perdida", "male")).toBe("Perdido");
    expect(situationLabelForSex("Fallecida", "male")).toBe("Fallecido");
  });
  it("keeps the feminine default for female/unknown/null", () => {
    expect(situationLabelForSex("Perdida", "female")).toBe("Perdida");
    expect(situationLabelForSex("Perdida", "unknown")).toBe("Perdida");
    expect(situationLabelForSex("Perdida", null)).toBe("Perdida");
    expect(situationLabelForSex("Fallecida", "female")).toBe("Fallecida");
  });
  it("passes through non-adjective (invariant) situation labels unchanged", () => {
    expect(situationLabelForSex("En tratamiento", "male")).toBe("En tratamiento");
    expect(situationLabelForSex("En adopción", "male")).toBe("En adopción");
    expect(situationLabelForSex("En tránsito", "male")).toBe("En tránsito");
    expect(situationLabelForSex("En observación antirrábica", "male")).toBe(
      "En observación antirrábica",
    );
  });
  it("never regenders Preñada — pregnancy is exclusively a female state", () => {
    expect(situationLabelForSex("Preñada", "male")).toBe("Preñada");
  });
});

// Ciclo-perdido sweep (external tester ronda 2026-07-16, fix #2): the WhatsApp
// share message, the mark-lost sheet title, the sighting-form question, the
// bandeja "está reportada como perdida" body, and the cartel guard all
// hardcoded feminine forms. Every surface now routes through these helpers.
describe("markLostActionLabel", () => {
  it("genders by sex", () => {
    expect(markLostActionLabel("male")).toBe("Marcar como perdido");
    expect(markLostActionLabel("female")).toBe("Marcar como perdida");
  });
  it("inclusive form for unknown/null/garbage", () => {
    expect(markLostActionLabel("unknown")).toBe("Marcar como perdido/a");
    expect(markLostActionLabel(null)).toBe("Marcar como perdido/a");
    expect(markLostActionLabel("nonsense")).toBe("Marcar como perdido/a");
  });
});

describe("sightedWhenQuestion", () => {
  it("genders the clitic by sex", () => {
    expect(sightedWhenQuestion("male")).toBe("¿Cuándo lo viste?");
    expect(sightedWhenQuestion("female")).toBe("¿Cuándo la viste?");
  });
  it("neutral rewording for unknown/null", () => {
    expect(sightedWhenQuestion("unknown")).toBe("¿Cuándo viste a la mascota?");
    expect(sightedWhenQuestion(null)).toBe("¿Cuándo viste a la mascota?");
  });
});

describe("lostSeenCallout", () => {
  it("genders the clitic by sex", () => {
    expect(lostSeenCallout("male")).toBe("si lo viste");
    expect(lostSeenCallout("female")).toBe("si la viste");
  });
  it("neutral rewording for unknown/null", () => {
    expect(lostSeenCallout("unknown")).toBe("si viste a la mascota");
    expect(lostSeenCallout(null)).toBe("si viste a la mascota");
  });
});

describe("lostShareMessage", () => {
  it("composes a fully-agreeing message per sex", () => {
    expect(lostShareMessage("Rocco", "male")).toBe(
      "Rocco está perdido. Mirá su credencial y avisanos si lo viste:",
    );
    expect(lostShareMessage("Michi", "female")).toBe(
      "Michi está perdida. Mirá su credencial y avisanos si la viste:",
    );
  });
  it("neutral phrasing throughout for unknown", () => {
    expect(lostShareMessage("Firu", null)).toBe(
      "Firu se perdió. Mirá su credencial y avisanos si viste a la mascota:",
    );
  });
});

describe("lostReportedTitle", () => {
  it("genders participles by sex", () => {
    expect(lostReportedTitle("Rocco", "male")).toBe("Rocco está reportado como perdido");
    expect(lostReportedTitle("Michi", "female")).toBe("Michi está reportada como perdida");
  });
  it("rewords to avoid the participle for unknown/null", () => {
    expect(lostReportedTitle("Firu", "unknown")).toBe("Se reportó la pérdida de Firu");
    expect(lostReportedTitle("Firu", null)).toBe("Se reportó la pérdida de Firu");
  });
});

describe("lostPosterHeadline", () => {
  it("sex-correct headline where known", () => {
    expect(lostPosterHeadline("male")).toBe("PERDIDO");
    expect(lostPosterHeadline("female")).toBe("PERDIDA");
  });
  it("SE BUSCA for unknown/null/garbage — never a slashed headline", () => {
    expect(lostPosterHeadline("unknown")).toBe("SE BUSCA");
    expect(lostPosterHeadline(null)).toBe("SE BUSCA");
    expect(lostPosterHeadline("nonsense")).toBe("SE BUSCA");
  });
});

describe("lastSeenHeadingLabel", () => {
  it("genders by sex", () => {
    expect(lastSeenHeadingLabel("male")).toBe("Última vez visto");
    expect(lastSeenHeadingLabel("female")).toBe("Última vez vista");
  });
  it("inclusive form for unknown/null", () => {
    expect(lastSeenHeadingLabel("unknown")).toBe("Última vez visto/a");
    expect(lastSeenHeadingLabel(null)).toBe("Última vez visto/a");
  });
});

describe("markLostFirstPrompt", () => {
  it("genders the clitic by sex", () => {
    expect(markLostFirstPrompt("male")).toBe(
      "Marcalo como perdido primero para generar el cartel.",
    );
    expect(markLostFirstPrompt("female")).toBe(
      "Marcala como perdida primero para generar el cartel.",
    );
  });
  it("neutral rewording for unknown/null", () => {
    expect(markLostFirstPrompt("unknown")).toBe(
      "Reportá su pérdida primero para generar el cartel.",
    );
    expect(markLostFirstPrompt(null)).toBe("Reportá su pérdida primero para generar el cartel.");
  });
});
