// ============================================================================
// LEGAL BASELINE DATASET — ar-v2 — ⚠️ UNSIGNED DRAFT, PENDING LEGAL REVIEW ⚠️
// ============================================================================
//
// STATUS: DRAFT. No sign-off record exists and none is written by this change.
// `data/legal-baseline/ar-v2.signoff.json` DOES NOT EXIST on purpose — the seed
// is fail-closed on checksum + signature precisely so a draft cannot reach a
// database. Do not create it; only the PO does, and only after recording the
// engram decision `sdd/jurisdiction-compliance/baseline-signoff` quoting
// ar-v2's own hash. The committed manifest here proves only WHAT was drafted,
// never that anyone approved it.
//
// ar-v1 (2 rows, sha256 de683461…5e856c64a) is FROZEN and untouched — the PO's
// deploy runbook uses that exact file and hash. The seed's `--dataset` flag
// defaults to ar-v1, so nothing here changes what that runbook does.
//
// ar-v2 is SELF-CONTAINED: it carries forward ar-v1's two rabies rows, now with
// the official source URLs and authorities that ar-v1 left as TODOs.
//
// ----------------------------------------------------------------------------
// HOW THIS WAS RESEARCHED
// ----------------------------------------------------------------------------
// Every row traces to an official text that was FETCHED AND READ (InfoLEG /
// argentina.gob.ar normativa, normas.gba.gob.ar, the CABA Boletín Oficial, the
// Santa Fe Boletín Oficial, SENASA) — never to a news article, blog or
// law-firm digest. Where only a secondary source could be found, NO row ships
// and the gap is listed as a TODO. Per-row research notes live in engram under
// `sdd/jurisdiction-compliance/ar-v2-draft`.
//
// ============================================================================
// ⚠️ FINDING 1 — THE PRODUCT'S MICROCHIP CLAIM IS WRONG (not merely narrow)
// ============================================================================
// `lib/metrics/metric-legal-basis.ts:53-56` and `AGENTS.md:333` assert that
// PBA Ley 14.107 and CABA Ley 4078 mandate microchip identification. Neither
// official text supports it, and SENASA says so at the national level.
//
//   - SENASA, official page: "En la REPUBLICA ARGENTINA no existe a la fecha
//     una reglamentación referida a la obligatoriedad de la identificación
//     electrónica individual con microchips de perros y gatos residentes en el
//     país." An official statement of ABSENCE — the cleanest possible basis for
//     a country-level `not_regulated` row.
//
//   - Ley Prov. 14.107 (PBA) applies ONLY to potentially dangerous breeds
//     (Anexo I + cruces), NOT the general pet population. Even for those dogs
//     art. 8 inc. b reads "Identificar al perro mediante la colocación de un
//     chip O DE UN TATUAJE" — the chip is one of two permitted options, so the
//     law does not mandate a microchip even within its own narrow scope.
//     AGENTS.md:333 calls it "obligatory microchip identification". It is not.
//
//   - Ley CABA 4.078 also covers only potentially dangerous dogs, and its
//     identification duty (art. 6) is "un collar con una chapa identificatoria"
//     — the law contains NO microchip mandate at all.
//
// Consequence for C1 (microchip penetration): its denominator is every active
// pet, while the only norms cited govern a breed subset — and mandate a chip in
// neither case.
//
// This INVERTS the blocker recorded in the archive report. T8/RG2 (commit
// 96277c05, flipping the microchip default to not_regulated) was parked because
// flipping it would contradict metric-legal-basis.ts's claim that PBA and CABA
// mandate the chip. That claim does not survive its own sources. The
// contradiction resolves by CORRECTING metric-legal-basis.ts, not by adding
// `mandatory` microchip rows — there is no jurisdiction anywhere in Argentina
// to add one for. Correcting that file is NOT part of this dataset change.
//
// ============================================================================
// ⚠️ FINDING 2 — THE PANORAMA STERILIZATION CLAIM IS WRONG
// ============================================================================
// `src/modules/panorama/application/get-panorama-kpis.ts:791` states
// sterilization is "obligatoria por ley provincial en Santa Fe, Mendoza,
// La Rioja, Chubut y San Juan". For the two provinces whose official texts were
// read in full, that is not what the law says — in both, sterilization is a
// STATE PROGRAM, not a duty on the owner:
//
//   - Santa Fe Ley 13.383 art. 3 establishes surgical sterilization as the
//     "único método prioritario para el control de crecimiento poblacional" —
//     how the province controls the population, not an owner obligation.
//   - San Juan Ley 6.535 art. 22 has the province organise a "servicio
//     municipal permanente de esterilización, así como campañas masivas, el que
//     será gratuito", and art. 4 exempts sterilized animals from a tax — an
//     incentive, which only makes sense because the act is voluntary.
//
// All five provinces were assessed and the claim fails for every one of them.
// Mendoza (Ley 7.603) and Chubut (Ley I N° 655) show the SAME state-program
// shape but could only be read in secondary sources, so they get NO row
// (TODO 1, 3). La Rioja is worse than unconfirmed: no provincial sterilization
// law appears to exist at all, and the claim most plausibly comes from LA
// RIOJA, SPAIN, whose Ley 6/2018 really was an owner-obligation sterilization
// law (TODO 2). Correcting that copy is NOT part of this dataset change.
//
// ============================================================================
// ⚠️ FINDING 3 — ar-v1's CABA `frequency_months: 12` IS UNSOURCED
// ============================================================================
// Ord. CABA 41.831 art. 9 reads: "Es obligatoria la aplicación de la vacuna
// antirrábica EN EL TIEMPO Y FORMA QUE LA DIRECCIÓN GENERAL DE MEDIO AMBIENTE
// DETERMINE PERIÓDICAMENTE, a todos los animales susceptibles de rabia." The
// ordinance deliberately does NOT fix an interval — it delegates the cadence to
// a periodic administrative determination. The "12 months" in ar-v1's CABA row
// (and in the spec's CABA scenario) traces to no norm that was located.
//
// ar-v2 therefore carried the CABA row WITHOUT `frequency_months` until the
// PO adjudicated it. ar-v1 is frozen and still carries the 12 (with no cadence
// citation) — this file does not and must not touch it.
//
// ADJUDICATED — PO decision 2026-09-18 (D5): CABA rabies revaccination is
// ANNUAL and SOURCED. The interval is fixed by the national anchors the
// product's legal framework lists for antirrábica ("obligatoria desde los 3
// meses, anual": Ley 22.953 + Res. MS 1144/2018 + Res. SENASA 580/2014), and
// Ord. 41.831 art. 9 applies them locally. The CABA row now carries
// `frequency_months: 12` together with `frequency_legal_basis`, the payload
// field that says WHICH norm fixes the interval. The compliance projection
// treats a cadence WITH that field as a legal deadline (Vigente / Vencida,
// cited, counted "al día") and a cadence WITHOUT it as a suggestion, so no
// other jurisdiction's behaviour changes until its own cadence is sourced.
//
// ============================================================================
// ✅ FINDING 4 — FOUR REAL RABIES MANDATES CONFIRMED
// ============================================================================
// The provincial laws the product cites for STERILIZATION do carry a genuine,
// explicit obligation — it is just a different one. Santa Fe 13.383 art. 4 and
// San Juan 6.535 art. 6 both declare vaccination mandatory province-wide, and
// PBA has its own long-standing rabies mandate. Together with the national law
// these make a non-CABA mandatory-rabies province realizable (spec §2
// scenario), which ar-v1 could not do.
//
// ----------------------------------------------------------------------------
// TODO — COULD NOT BE CONFIRMED, SO NO ROW SHIPS
// ----------------------------------------------------------------------------
//  1. sterilization / Mendoza — the norm is Ley 7.603 (2006), modified by Ley
//     7.756 (2007). Art. 2 ("Adóptase como método ético y eficiente para el
//     control del crecimiento poblacional de animales domésticos, la práctica
//     de la esterilización quirúrgica en todo el ámbito de la Provincia") was
//     read on an official hcdmza.gob.ar page, but that page is a legislature
//     NEWS item, not the norm text; the full articulado was only available from
//     a secondary legal database. Same STATE-PROGRAM shape as Santa Fe and San
//     Juan, so the product's claim is almost certainly wrong here too — but a
//     lead is not a citation. NEXT PASS: retrieve Ley 7.603 from the Mendoza
//     Boletín Oficial and ship a `not_regulated` row.
//  2. sterilization / La Rioja — NO provincial sterilization law exists as far
//     as 15+ official-source searches could establish (legislaturalarioja.gob.ar
//     incl. its digesto, SAIJ, FAOLEX, larioja.gob.ar). Only a MUNICIPAL norm
//     was found (Ordenanza C.D. 5.717/2019, capital city). ⚠️ LIKELY ROOT CAUSE
//     OF THE PRODUCT'S CLAIM: searches are dominated by LA RIOJA, SPAIN, whose
//     Ley 6/2018 WAS a genuine owner-obligation sterilization law (since
//     repealed by Ley 10/2023). The panorama copy most plausibly names the
//     Argentine La Rioja on the strength of a Spanish statute. Of the five
//     provinces this is the one with no supportable claim of any kind.
//  3. sterilization / Chubut — the norm is Ley I N° 655 ("Declaración de Chubut
//     No Eutanásica", sanc. 2019-05-31). Four independent secondary sources
//     agree its art. 4 establishes "la castración quirúrgica gratuita, masiva,
//     temprana, abarcativa, sistemática y extendida" as the sole population
//     control method — again a state program — and that art. 8 makes only
//     ANTIPARASITIC treatment obligatory, not sterilization. The official
//     Boletín Oficial / digesto text could not be retrieved. Secondary only, so
//     no row. NEXT PASS: retrieve Ley I N° 655's official text.
//  4. effectiveFrom for EVERY row. Sanction/publication dates were found (Ley
//     22.953 sanctioned 1983-10-19, BO 1983-10-21; PBA 14.107 sanctioned
//     2009-12-09, in force 90 days post-promulgation; CABA 4.078 sanctioned
//     2011-12-01, BOCBA 2012-01-27; San Juan 6.535 sanctioned 1994-12-17,
//     published 1995-01-30; Santa Fe 13.383 promulgated by Decreto 4336/2013,
//     registered 2014-01-09) but a publication date is NOT an entry-into-force
//     date, and approximating one would be inventing law.
//  5. VACCINATION FREQUENCY, everywhere. No norm read here fixes an interval.
//     Ley 22.953 art. 14 delegates reglamentación to the PEN; Ord. CABA 41.831
//     art. 9 delegates to the Dirección General de Medio Ambiente; PBA Decreto
//     4669/1973 art. 5 states the duty without an interval. A SENASA
//     informational page states "anual" and San Juan Decreto 0556-SESP/97 is
//     reported to fix it, but neither was confirmed against primary text.
//     Only the CABA row carries `frequency_months`, by PO adjudication
//     (FINDING 3, D5 2026-09-18); every other row still has none.
//  6. Whether Santa Fe 13.383 art. 4's generic "la vacunación" reaches
//     ANTIRRÁBICA specifically. The article sits among "métodos preventivos
//     contra enfermedades zoonóticas" and rabies is the canonical zoonosis, so
//     the reading is strong — but it is a reading, and legal review must
//     confirm it. San Juan's art. 6 needs no such reading: it says "vacunación
//     antirrábica" in those words.
//  7. A single named `authority` for Ley 22.953. Art. 2 spreads enforcement
//     across "la autoridad sanitaria nacional, la de cada provincia, la de la
//     Municipalidad de la Ciudad de Buenos Aires" — no one organism to name.
//  8. Whether Ord. CABA 41.831 art. 9 survived Leyes 5346/2015, 429/2000 and
//     5471/2015 untouched. Those amendments hit arts. 7(c), 29, 32 and 33; art.
//     9 was not reported among them, but that negative was not independently
//     verified against each amending text.
//  9. A general (non-PPP) microchip mandate anywhere in Argentina. None found;
//     SENASA states none exists. A 2022 CABA proyecto and a 2025 Santa Fe media
//     sanción were located but neither is enacted law.
// 10. rabies_vaccination beyond nacional / CABA / Buenos Aires / Santa Fe /
//     San Juan.
// ============================================================================

import type { LegalBaselineDataset } from "./schema";

export const AR_V2: LegalBaselineDataset = {
  version: "ar-v2",
  rows: [
    // =======================================================================
    // microchip_required — no confirmed mandate anywhere in Argentina. All
    // rows are `not_regulated`, which under OR5 write-both parity forces
    // payload.required === false.
    // =======================================================================
    {
      // Country-wide. SENASA states outright that no microchip-obligation
      // regulation exists in Argentina. A cited country-level row beats a
      // silent default: it makes the absence a reviewable claim.
      ruleKey: "microchip_required",
      jurisdiction: { country: "AR", province: null, locality: null },
      requirementLevel: "not_regulated",
      legalBasis:
        "SENASA — no existe en la República Argentina reglamentación que obligue a la identificación electrónica individual con microchip de perros y gatos.",
      authority: "SENASA",
      sourceUrl: "https://www.argentina.gob.ar/senasa/consideraciones-generales-y-legislacion",
      effectiveFrom: null, // TODO 4
      rulePayload: { required: false },
      reviewStatus: "pending_legal_review",
    },
    {
      // PBA. Ley 14.107 art. 8 inc. b: "Identificar al perro mediante la
      // colocación de un chip o de un tatuaje" — chip OR tattoo, and only for
      // the potentially-dangerous breeds of Anexo I.
      ruleKey: "microchip_required",
      jurisdiction: { country: "AR", province: "Buenos Aires", locality: null },
      requirementLevel: "not_regulated",
      legalBasis:
        "Ley Prov. 14.107 art. 8 inc. b — alcance limitado a perros potencialmente peligrosos (Anexo I); admite chip O tatuaje. Sin obligación general de microchip.",
      authority: null, // TODO — the law creates a Registro with municipal delegations
      sourceUrl: "https://normas.gba.gob.ar/documentos/0PNzEIAB.html",
      effectiveFrom: null, // TODO 4
      rulePayload: { required: false },
      reviewStatus: "pending_legal_review",
    },
    {
      // CABA. Ley 4.078 art. 6 requires "un collar con una chapa
      // identificatoria" for potentially dangerous dogs. The law never mentions
      // a microchip.
      ruleKey: "microchip_required",
      jurisdiction: { country: "AR", province: "CABA", locality: null },
      requirementLevel: "not_regulated",
      legalBasis:
        "Ley CABA 4.078 art. 6 — identificación por collar con chapa identificatoria, sólo para perros potencialmente peligrosos. La ley no exige microchip.",
      authority: null, // TODO
      sourceUrl: "https://boletinoficial.buenosaires.gob.ar/normativaba/norma/302801",
      effectiveFrom: null, // TODO 4
      rulePayload: { required: false },
      reviewStatus: "pending_legal_review",
    },

    // =======================================================================
    // rabies_vaccination — four confirmed mandates. Only CABA carries a
    // `frequency_months`, with its cadence citation, by PO adjudication
    // (FINDING 3, D5 2026-09-18); the rest stay without one (TODO 5).
    // =======================================================================
    {
      // National. Ley 22.953 art. 6, Secc. I inc. a puts the duty on the
      // keeper in as many words: "Vacunar a los perros y gatos bajo su
      // tenencia." Carried forward from ar-v1, now with its official source.
      ruleKey: "rabies_vaccination",
      jurisdiction: { country: "AR", province: null, locality: null },
      requirementLevel: "mandatory",
      legalBasis: "Ley 22.953 art. 6 secc. I inc. a",
      authority: null, // TODO 7 — art. 2 names no single organism
      sourceUrl: "https://www.argentina.gob.ar/normativa/nacional/ley-22953-184650/texto",
      effectiveFrom: null, // TODO 4
      rulePayload: {},
      reviewStatus: "pending_legal_review",
    },
    {
      // CABA override — the local ordinance on top of the national law.
      // Annual revaccination by PO adjudication (FINDING 3, D5 2026-09-18):
      // art. 9 delegates the cadence, and the national anchors cited in
      // frequency_legal_basis fix it at one year.
      ruleKey: "rabies_vaccination",
      jurisdiction: { country: "AR", province: "CABA", locality: null },
      requirementLevel: "mandatory",
      legalBasis: "Ley 22.953 · Ord. CABA 41.831 art. 9",
      authority: "Dirección General de Medio Ambiente (GCBA)",
      sourceUrl: "https://boletinoficial.buenosaires.gob.ar/normativaba/norma/30564",
      effectiveFrom: null, // TODO 4
      rulePayload: {
        frequency_months: 12,
        frequency_legal_basis: "Ley 22.953 · Res. MS 1144/2018 · Res. SENASA 580/2014",
      },
      reviewStatus: "pending_legal_review",
    },
    {
      // PBA. Decreto 4669/1973 art. 5 (reglamentario of Decreto-ley 8056/1973)
      // is explicit: "Declárase obligatoria la vacunación de perros y gatos que
      // tengan su asiento habitual, transitorio o circunstancial en territorio
      // provincial." Decreto-ley 8056/1973 art. 7 secc. I inc. a is the
      // enabling provision. The same 4669/1973 the product already cites for
      // the 10-day rabies observation window.
      ruleKey: "rabies_vaccination",
      jurisdiction: { country: "AR", province: "Buenos Aires", locality: null },
      requirementLevel: "mandatory",
      legalBasis:
        "Decreto-ley Prov. 8.056/1973 art. 7 secc. I inc. a · Decreto Prov. 4.669/1973 art. 5",
      authority: null, // TODO — art. 3 splits it across municipal intendentes and a provincial organism
      sourceUrl: "https://normas.gba.gob.ar/documentos/VGOWA8fW.html",
      effectiveFrom: null, // TODO 4
      rulePayload: {},
      reviewStatus: "pending_legal_review",
    },
    {
      // San Juan Ley 6.535 art. 6: "Es obligatoria la vacunación antirrábica y
      // desparacitación de la totalidad de los perros y/o gatos existentes en
      // cada Municipio". Explicit, province-wide, and names antirrábica
      // directly — the highest-confidence row in this dataset.
      ruleKey: "rabies_vaccination",
      jurisdiction: { country: "AR", province: "San Juan", locality: null },
      requirementLevel: "mandatory",
      legalBasis: "Ley Prov. 6.535 art. 6",
      authority: "Secretaría de Estado de Salud Pública de la Provincia de San Juan",
      sourceUrl:
        "https://www.argentina.gob.ar/normativa/provincial/ley-6535-123456789-0abc-defg-535-6000jvorpyel/actualizacion",
      effectiveFrom: null, // TODO 4
      rulePayload: {},
      reviewStatus: "pending_legal_review",
    },
    {
      // Santa Fe Ley 13.383 art. 4: "Declárase obligatoria en la Provincia, la
      // vacunación, el tratamiento antiparasitario de perros y gatos". Generic
      // "vacunación" rather than "antirrábica" — see TODO 6, this row's one
      // open interpretive question.
      ruleKey: "rabies_vaccination",
      jurisdiction: { country: "AR", province: "Santa Fe", locality: null },
      requirementLevel: "mandatory",
      legalBasis: "Ley Prov. 13.383 art. 4",
      authority: null, // TODO — art. 6 delegates the designation to the Poder Ejecutivo
      sourceUrl:
        "https://www.santafe.gob.ar/boletinoficial/ver.php?seccion=9-01-2014ley13383-2014.html",
      effectiveFrom: null, // TODO 4
      rulePayload: {},
      reviewStatus: "pending_legal_review",
    },

    // =======================================================================
    // sterilization — the two provinces whose texts were read say STATE
    // PROGRAM, not owner duty. `not_regulated` is the honest tier for an
    // owner-facing obligation the norm does not create (spec CS4: informational,
    // never an obligation card, never in a compliance percentage). Mendoza,
    // La Rioja and Chubut ship NO row (TODO 1-3).
    // =======================================================================
    {
      // Santa Fe Ley 13.383 art. 3: sterilization is the province's "único
      // método prioritario para el control de crecimiento poblacional" — a
      // directive to the state, not an obligation on the titular.
      ruleKey: "sterilization",
      jurisdiction: { country: "AR", province: "Santa Fe", locality: null },
      requirementLevel: "not_regulated",
      legalBasis:
        "Ley Prov. 13.383 art. 3 — la esterilización quirúrgica es el método prioritario del Estado para el control poblacional; la ley no impone un deber al titular.",
      authority: null, // TODO
      sourceUrl:
        "https://www.santafe.gob.ar/boletinoficial/ver.php?seccion=9-01-2014ley13383-2014.html",
      effectiveFrom: null, // TODO 4
      rulePayload: {},
      reviewStatus: "pending_legal_review",
    },
    {
      // San Juan Ley 6.535 art. 22 (servicio municipal gratuito + campañas
      // masivas) and art. 4 (exención de tasa para animales esterilizados). A
      // tax exemption is an incentive, which presupposes the act is voluntary.
      // Ley Prov. 7.864 (2007) adds a "Programa de Esterilización Masiva"
      // scoped to animals "en la vía pública" — strays, not owned pets. It is
      // left out of legalBasis because 6.535 alone settles the tier; it is
      // recorded here so a later pass does not mistake it for an owner duty.
      ruleKey: "sterilization",
      jurisdiction: { country: "AR", province: "San Juan", locality: null },
      requirementLevel: "not_regulated",
      legalBasis:
        "Ley Prov. 6.535 arts. 22 y 4 — servicio municipal permanente y gratuito de esterilización más exención de tasa; la ley no impone un deber al titular.",
      authority: "Secretaría de Estado de Salud Pública de la Provincia de San Juan",
      sourceUrl:
        "https://www.argentina.gob.ar/normativa/provincial/ley-6535-123456789-0abc-defg-535-6000jvorpyel/actualizacion",
      effectiveFrom: null, // TODO 4
      rulePayload: {},
      reviewStatus: "pending_legal_review",
    },
  ],
};
