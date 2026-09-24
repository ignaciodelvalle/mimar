// What the adoption screens say, and what they refuse to say.
//
// Every function under test is PURE, so this file is where the copy decisions
// are pinned rather than in a render. Three of them are decisions the WEB
// already made and paid for, and a phone that quietly reversed one would be a
// regression nothing else would catch:
//
//   · "Sin dato" is not "No" (S1-F13). All three health booleans are the
//     PRESENCE OF A RECORD, so a shelter that has not loaded a castration looks
//     identical to an animal that certainly is not castrated — and somebody
//     deciding whether to adopt needs that difference.
//   · A `null` convivencia answer is DROPPED, never rendered as "no". Inventing
//     "no convive con gatos" about an unanswered field is this app making up a
//     fact about an animal.
//   · `auto_rejected` is not `rejected`. The first means the animal went to
//     somebody else.
//
// And one this app owns: the form validates against the CONTRACT's schema, never
// against a local copy of its rules.

import { describe, expect, it } from "@jest/globals";

import type {
  AdoptionCatalogueItemV1,
  AdoptionDetailListedV1,
  MyAdoptionApplicationV1,
} from "@dim/contract/api";

import {
  APPLICATIONS_EMPTY,
  EMPTY_APPLICATION_DRAFT,
  applicationFichaAvailable,
  applicationStatusBody,
  applicationStatusLabel,
  applicationsTruncationNote,
  applyBlockedCopy,
  cardBadges,
  cardSubtitle,
  catalogueEmpty,
  catalogueSummary,
  closedFichaCopy,
  convivenciaChips,
  feeCopy,
  healthRows,
  orgSectionBody,
  orgSectionLabel,
  validateApplicationDraft,
} from "./adoption-view-model";

function card(over: Partial<AdoptionCatalogueItemV1> = {}): AdoptionCatalogueItemV1 {
  return {
    petToken: "DIM-ABCD-2345",
    name: "Lola",
    species: "dog",
    speciesLabel: "Perro",
    breed: "Mestiza",
    sex: "female",
    sexLabel: "Hembra",
    color: "Negra",
    photoUrl: null,
    locality: "San Carlos de Bariloche",
    province: "Río Negro",
    facts: ["Adulta", "Mediana"],
    goodWithKids: true,
    goodWithDogs: null,
    goodWithCats: false,
    needsYard: null,
    hasMicrochip: true,
    isSterilized: true,
    sterilizedLabel: "Castrada",
    feeArs: null,
    orgToken: "ORG-1234",
    orgName: "Refugio Patitas",
    livesWithFamily: false,
    ...over,
  };
}

function ficha(over: Partial<AdoptionDetailListedV1> = {}): AdoptionDetailListedV1 {
  return {
    state: "listed",
    petToken: "DIM-ABCD-2345",
    name: "Lola",
    species: "dog",
    speciesLabel: "Perro",
    breed: "Mestiza",
    sex: "female",
    sexLabel: "Hembra",
    color: "Negra",
    distinguishingFeatures: null,
    photoUrls: [],
    locality: "San Carlos de Bariloche",
    province: "Río Negro",
    facts: ["Adulta"],
    story: null,
    requirements: null,
    goodWithKids: true,
    goodWithDogs: null,
    goodWithCats: false,
    needsYard: null,
    feeArs: null,
    health: {
      hasVaccinations: true,
      isSterilized: false,
      sterilizedLabel: "Castrada",
      hasMicrochip: false,
    },
    permanentConditions: [],
    permanentConditionsOther: null,
    org: {
      orgToken: "ORG-1234",
      name: "Refugio Patitas",
      locality: "Dina Huapi",
      province: "Río Negro",
      custodySince: "2026-07-07T00:00:00.000Z",
      livesWithFamily: false,
    },
    canApply: true,
    applyBlockedReason: null,
    ...over,
  };
}

function application(over: Partial<MyAdoptionApplicationV1> = {}): MyAdoptionApplicationV1 {
  return {
    applicationId: "evt-1",
    petToken: "DIM-ABCD-2345",
    petName: "Lola",
    orgName: "Refugio Patitas",
    orgToken: "ORG-1234",
    submittedAt: "2026-08-02T10:00:00.000Z",
    status: "pending",
    decisionAt: null,
    stillListed: true,
    ...over,
  };
}

describe("the catalogue", () => {
  it("renders the sterilization badge the SERVER worded, never one it built", () => {
    // The label agrees with the animal's sex and the server resolved it. A
    // client that switched on `sex` would be the fourth implementation of that
    // agreement, and the ficha shipped "Castrada" over a male dog because the
    // third one was wrong.
    expect(cardBadges(card({ sterilizedLabel: "Castrado", sex: "male" }))).toContain("Castrado");
  });

  it("says THAT the animal is chipped and never which chip", () => {
    const badges = cardBadges(card({ hasMicrochip: true }));
    expect(badges).toContain("Con chip");
    expect(badges.join(" ")).not.toMatch(/\d/);
  });

  it("drops the badges the shelter did not claim", () => {
    expect(cardBadges(card({ isSterilized: false, hasMicrochip: false }))).toEqual([]);
  });

  it("names where the animal is, and copes with a listing that says nowhere", () => {
    expect(cardSubtitle(card())).toBe("Mestiza · San Carlos de Bariloche, Río Negro");
    expect(cardSubtitle(card({ breed: null, locality: null, province: null }))).toBe("");
  });

  it("counts what is on screen and never a total the server did not send", () => {
    expect(catalogueSummary(1, false)).toBe("1 mascota publicada");
    expect(catalogueSummary(24, true)).toBe("24 mascotas publicadas · mostrando las más recientes");
  });

  it("keeps 'no results for those filters' apart from 'nothing published yet'", () => {
    // UX 3.5 item 3. Collapsing them tells somebody their search was wrong when
    // the country's shelters had published nothing.
    expect(catalogueEmpty(true).title).not.toBe(catalogueEmpty(false).title);
    expect(catalogueEmpty(false).title).toMatch(/Todavía no hay/);
  });
});

describe("the ficha's health rows", () => {
  it("says 'Sin dato' rather than 'No' for an absent record", () => {
    // S1-F13. `false` here is the ABSENCE of a record, not a negative fact, and
    // the two look identical to somebody deciding whether to adopt.
    const rows = healthRows(ficha());
    const castration = rows.find((r) => r.label === "Castración");
    expect(castration?.ok).toBe(false);
    expect(castration?.note).toBe("Sin dato");
  });

  it("says 'Con registros' for vaccination rather than claiming it is up to date", () => {
    // hasVaccinations is the PRESENCE OF A RECORD, so "al día" was a claim the
    // datum cannot support (one 2019 dose rendered green). Mirrors the web's
    // two states: app/(public)/p/[publicToken]/page.tsx.
    const rows = healthRows(ficha());
    const vaccines = rows.find((r) => r.label === "Vacunación");
    expect(vaccines?.ok).toBe(true);
    expect(vaccines?.note).toBe("Con registros");
  });

  it("says 'Sin registros' when there are none, matching the credential", () => {
    // The negative case had no coverage when the label changed. It matters
    // because the three health rows do NOT share one absent-wording: this row
    // mirrors the public credential ("Sin registros",
    // app/(public)/p/[publicToken]/page.tsx) while its two siblings say
    // "Sin dato". Untested, that divergence is one careless edit from becoming
    // an inconsistency nobody meant.
    const rows = healthRows(
      ficha({
        health: {
          hasVaccinations: false,
          isSterilized: false,
          sterilizedLabel: "Castrada",
          hasMicrochip: false,
        },
      }),
    );
    const vaccines = rows.find((r) => r.label === "Vacunación");
    expect(vaccines?.ok).toBe(false);
    expect(vaccines?.note).toBe("Sin registros");
  });

  it("never says 'No' about any of the three", () => {
    const notes = healthRows(ficha()).map((r) => r.note);
    expect(notes).not.toContain("No");
  });
});

describe("the ficha's convivencia chips", () => {
  it("drops an unanswered question instead of rendering it as a no", () => {
    const chips = convivenciaChips(ficha());
    expect(chips.map((c) => c.label)).toEqual(["Con chicos", "Con gatos"]);
    expect(chips.find((c) => c.label === "Con gatos")?.value).toBe(false);
  });

  it("renders nothing when the shelter answered nothing", () => {
    expect(
      convivenciaChips(
        ficha({ goodWithKids: null, goodWithDogs: null, goodWithCats: null, needsYard: null }),
      ),
    ).toEqual([]);
  });
});

describe("the ficha's organization card", () => {
  it("says the org ACCOMPANIES a sponsored listing rather than holding the animal", () => {
    // REQ-12. "En custodia desde" over a rehome sponsorship states three things
    // that are only true of an intake.
    const sponsored = ficha({ org: { ...ficha().org, livesWithFamily: true } });
    expect(orgSectionLabel(sponsored)).toBe("Organización que acompaña");
    expect(orgSectionBody(sponsored)).toMatch(/vive con su familia actual/);
  });

  it("says the org holds the animal on an ordinary listing", () => {
    expect(orgSectionLabel(ficha())).toBe("Refugio responsable");
    expect(orgSectionBody(ficha())).toMatch(/tiene la custodia/);
  });
});

describe("the ficha's two closed answers", () => {
  it("tells somebody the animal found a home, not that it was not found", () => {
    const copy = closedFichaCopy({
      state: "recently_adopted",
      petToken: "DIM-ABCD-2345",
      name: "Lola",
      orgName: null,
    });
    expect(copy.title).toMatch(/ya encontró su hogar/);
    expect(copy.title).not.toMatch(/no encontramos/i);
  });

  it("names the organization that paused a listing", () => {
    const copy = closedFichaCopy({
      state: "paused",
      petToken: "DIM-ABCD-2345",
      name: "Lola",
      orgName: "Refugio Patitas",
    });
    expect(copy.body).toMatch(/Refugio Patitas/);
  });

  it("still says something when a paused listing names no organization", () => {
    const copy = closedFichaCopy({
      state: "paused",
      petToken: "DIM-ABCD-2345",
      name: "Lola",
      orgName: null,
    });
    expect(copy.body).toMatch(/El refugio pausó/);
  });
});

describe("why the apply button is missing", () => {
  it("says the two refusals differently", () => {
    expect(applyBlockedCopy("already_applied")).toMatch(/Ya te postulaste/);
    expect(applyBlockedCopy("institutional_account")).toMatch(/institucionales/);
  });
});

describe("the fee line", () => {
  it("is absent when the shelter asks for nothing", () => {
    expect(feeCopy(null)).toBeNull();
    expect(feeCopy(0)).toBeNull();
  });

  it("formats pesos the way es-AR writes them", () => {
    expect(feeCopy(15_000)).toContain("15.000");
  });
});

describe("mis postulaciones", () => {
  it("keeps 'cerrada' apart from 'no avanzó'", () => {
    // `auto_rejected` means the animal went to somebody else. Telling that
    // person they were turned down is a small cruelty the web already refuses.
    expect(applicationStatusLabel("auto_rejected")).not.toBe(applicationStatusLabel("rejected"));
    expect(applicationStatusBody(application({ status: "auto_rejected" }))).toMatch(
      /encontró hogar con otra postulación/,
    );
    expect(applicationStatusBody(application({ status: "rejected" }))).toMatch(/no avanzó/);
  });

  it("never states a queue position or a count of other applicants (D17)", () => {
    const everyStatus = (
      [
        "pending",
        "info_requested",
        "approved",
        "finalized_to_me",
        "auto_rejected",
        "rejected",
        "withdrawn",
      ] as const
    ).map((status) => applicationStatusBody(application({ status })));
    for (const body of everyStatus) {
      expect(body).not.toMatch(/\d+\s*(postulaci|otras|puesto|lugar)/i);
    }
  });

  it("links to the ficha from the SERVER's stillListed, never from the status", () => {
    // A `pending` application over an animal the shelter unpublished this
    // morning would otherwise open a 404 — or a "ya encontró su hogar" for an
    // animal this person is still waiting on.
    expect(applicationFichaAvailable(application({ status: "pending", stillListed: false }))).toBe(
      false,
    );
    expect(applicationFichaAvailable(application({ status: "rejected", stillListed: true }))).toBe(
      true,
    );
  });

  it("says the list was capped only when it was", () => {
    expect(applicationsTruncationNote(false)).toBeNull();
    expect(applicationsTruncationNote(true)).toMatch(/100/);
  });

  it("offers a way out of the empty state", () => {
    expect(APPLICATIONS_EMPTY.body).toMatch(/ficha/);
  });
});

describe("the application form", () => {
  const filled = {
    ...EMPTY_APPLICATION_DRAFT,
    housingType: "casa_con_patio" as const,
    priorPets: "yes_before" as const,
    motivation: "Quiero adoptar porque tengo tiempo y espacio para cuidarla todos los dias.",
    consent: true,
  };

  it("accepts a complete draft and hands over what the contract accepts", () => {
    const result = validateApplicationDraft(filled);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.housingType).toBe("casa_con_patio");
      expect(result.input.profileSharingConsent).toBe(true);
    }
  });

  it("turns an unanswered optional question into null, never into an empty answer", () => {
    // The writer collapses `undefined`, `null` and whitespace onto one stored
    // NULL, so `""` would be this app inventing an empty answer where somebody
    // simply skipped a question.
    const result = validateApplicationDraft({ ...filled, otherPets: "   " });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.otherPets).toBeNull();
  });

  it("refuses a short motivation with the reason, not a generic error", () => {
    const result = validateApplicationDraft({ ...filled, motivation: "corto" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/30 caracteres/);
  });

  it("refuses a motivation that is long enough only because of whitespace", () => {
    const result = validateApplicationDraft({ ...filled, motivation: `${" ".repeat(40)}corto` });
    expect(result.ok).toBe(false);
  });

  it("refuses a draft with consent unticked", () => {
    // Ley 25.326: consent is an act, not a default.
    const result = validateApplicationDraft({ ...filled, consent: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/permiso/);
  });

  it("refuses a draft with no housing type and names the field", () => {
    const result = validateApplicationDraft({ ...filled, housingType: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/dónde vivís/);
  });

  it("refuses a draft with no prior-pets answer", () => {
    const result = validateApplicationDraft({ ...filled, priorPets: null });
    expect(result.ok).toBe(false);
  });

  it("refuses an over-long answer", () => {
    const result = validateApplicationDraft({ ...filled, notes: "a".repeat(2001) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/2000/);
  });

  it("refuses the empty draft — the state the form opens in", () => {
    // NON-VACUITY for every "refuses" above: a validator that accepted
    // everything would pass none of them, but one that REFUSED everything would
    // pass all of them. The accept case at the top and this one bound it on both
    // sides.
    expect(validateApplicationDraft(EMPTY_APPLICATION_DRAFT).ok).toBe(false);
  });
});
