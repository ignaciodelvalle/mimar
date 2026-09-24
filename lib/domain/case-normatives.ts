// Case-normatives lookup — `(case_kind, jurisdiction) → LawReference[]`.
//
// The case UI renders the union of all matching entries: country-level +
// province-level (if matched) + locality-level (if matched). De-duped by
// law id at the helper.
//
// This is NOT a database table. Laws change rarely; if/when they do, the
// constants here are updated and every historical case picks up the new
// text on next render. If a snapshot of "the law as it was when the case
// was opened" becomes necessary (cita textual en una resolución, por
// ejemplo), that is a separate problem solved via attaching a doc to
// the case — not by snapshotting law text into the case row.
//
// Sources: lifecycles spec §§5.7, 6.7, 7.7, 8.7, 9.7, 10.7, 11.7 +
// `docs/legal-framework-full.md`.

import { CASE_KINDS, type CaseKind } from "@/src/modules/cases/domain/case-kinds";

export interface LawReference {
  /** Stable slug — used for dedup + future UI deep-linking. */
  id: string;
  /** Display label, es-AR. */
  label: string;
  /** One-line description of scope (what this law covers in plain Spanish). */
  scope: string;
  /** Optional link to infoleg.gob.ar or equivalent. */
  fullTextUrl?: string;
}

export interface CaseNormativesJurisdiction {
  country: string;
  province?: string;
  locality?: string;
}

export interface CaseNormativesEntry {
  kind: CaseKind;
  jurisdiction: CaseNormativesJurisdiction;
  laws: LawReference[];
}

export const CASE_NORMATIVES: CaseNormativesEntry[] = [
  // -------------------------------------------------------------------------
  // bite_incident (lifecycles spec §5.7)
  // -------------------------------------------------------------------------
  {
    kind: "bite_incident",
    jurisdiction: { country: "AR" },
    laws: [
      {
        id: "ley_15465_60_decreto_3640_64",
        label: "Ley 15.465/60 + Decreto 3640/64",
        scope: "Rabia es enfermedad de notificación obligatoria nacional",
      },
      {
        id: "res_ms_1144_2018",
        label: "Res. MS 1144/2018",
        scope: "Guía nacional de prevención, vigilancia y control de rabia; APR",
      },
    ],
  },
  {
    kind: "bite_incident",
    jurisdiction: { country: "AR", province: "Buenos Aires" },
    laws: [
      {
        id: "decreto_4669_1973_pba",
        label: "Decreto 4669/1973 PBA",
        scope: "Observación antirrábica obligatoria de 10 días",
      },
      {
        id: "ley_5325_1948_pba",
        label: "Ley 5325/1948 PBA",
        scope: "Denuncia obligatoria de enfermedades transmisibles dentro de 24hs",
      },
    ],
  },
  {
    kind: "bite_incident",
    jurisdiction: { country: "AR", province: "CABA" },
    laws: [
      {
        id: "ord_caba_41831_1987",
        label: "Ord. CABA 41.831/1987",
        scope: "Análogo CABA — observación en Instituto Pasteur o domicilio",
      },
      {
        // Sanción 01/12/2011 (BOCBA publicación 27/01/2012) — sanction-year
        // convention, consistent with lib/reference/legal-knowledge-base.ts.
        // Verified 2026-07-18 against the research package.
        id: "ley_caba_4078_2011_res_93_apra_2021",
        label: "Ley CABA 4078/2011 + Res. 93/APRA/2021",
        scope: "Notif <48hs para PPP (perros potencialmente peligrosos)",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // lost_pet_episode (§6.7) — no specific framework
  // -------------------------------------------------------------------------
  {
    kind: "lost_pet_episode",
    jurisdiction: { country: "AR" },
    laws: [],
  },

  // -------------------------------------------------------------------------
  // welfare_denuncia (§7.7)
  // -------------------------------------------------------------------------
  {
    kind: "welfare_denuncia",
    jurisdiction: { country: "AR" },
    laws: [
      {
        id: "ley_nacional_14346_1954",
        label: "Ley Nacional 14.346 (1954)",
        scope: "Malos tratos y actos de crueldad contra animales",
      },
    ],
  },
  {
    kind: "welfare_denuncia",
    jurisdiction: { country: "AR", province: "CABA" },
    laws: [
      {
        id: "caba_mpf_pipeline",
        label: "MPF CABA — Unidad Fiscal de Maltrato Animal",
        scope: "Pipeline de denuncia formal (referencia operativa, no marco legal)",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // adoption_listing (§8.7) — contractual private agreement
  // -------------------------------------------------------------------------
  {
    kind: "adoption_listing",
    jurisdiction: { country: "AR" },
    laws: [
      {
        id: "contractual_privado",
        label: "Contrato privado de adopción",
        scope: "Acuerdo bilateral refugio/adopter; no rige norma específica nacional",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // adoption_application (§9.7) — reuses adoption_listing framework
  // -------------------------------------------------------------------------
  {
    kind: "adoption_application",
    jurisdiction: { country: "AR" },
    laws: [
      {
        id: "contractual_privado",
        label: "Contrato privado de adopción",
        scope: "Acuerdo bilateral refugio/adopter; no rige norma específica nacional",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // custody_dispute (§10.7)
  // -------------------------------------------------------------------------
  {
    kind: "custody_dispute",
    jurisdiction: { country: "AR" },
    laws: [
      {
        id: "codigo_civil_y_comercial",
        label: "Código Civil y Comercial",
        scope: "Animales como bienes / cosas; régimen de copropiedad y guarda",
      },
      {
        id: "caso_por_caso",
        // This text renders VERBATIM on the public case page (/casos/[code]).
        // It used to carry spec-speak — a raw column name in backticks and the
        // English word "proceeding" — shown to a pet owner reading their own
        // dispute (found live by the 9-role external run, 2026-08-18). Copy
        // here is user-facing es-AR: no schema identifiers, no jargon.
        label: "Causa judicial del caso",
        scope:
          "Si la disputa llega a la justicia, cada caso tiene su propia carátula y juzgado; la referencia del expediente queda registrada en el caso",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // foster_placement (§11.7)
  // -------------------------------------------------------------------------
  {
    kind: "foster_placement",
    jurisdiction: { country: "AR" },
    laws: [
      {
        id: "sin_norma_especifica",
        label: "Sin norma específica nacional",
        scope:
          "Acuerdo bilateral org/foster. Aplican normas generales de tenencia responsable de la jurisdicción donde reside el foster",
      },
    ],
  },

  { kind: "custody_transfer_handshake", jurisdiction: { country: "AR" }, laws: [] },

  // -------------------------------------------------------------------------
  // foster_proposal — internal workflow, no specific legal framework
  // -------------------------------------------------------------------------
  { kind: "foster_proposal", jurisdiction: { country: "AR" }, laws: [] },

  // -------------------------------------------------------------------------
  // rehome_request — a private arrangement between the titular and a verified
  // org (rehome-by-titular). Same footing as foster_proposal: no specific law.
  // The adoption that may follow carries adoption_listing's framework.
  // -------------------------------------------------------------------------
  { kind: "rehome_request", jurisdiction: { country: "AR" }, laws: [] },

  // -------------------------------------------------------------------------
  // custody_episode — decomiso spec DC10 + Ley 14.346 for seizure cases
  // -------------------------------------------------------------------------
  {
    kind: "custody_episode",
    jurisdiction: { country: "AR" },
    laws: [
      {
        id: "ley_nacional_14346_1954_custody",
        label: "Ley Nacional 14.346 (1954)",
        scope: "Malos tratos y actos de crueldad — fundamento legal del decomiso",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // outbreak_investigation — attachment spec §6, same notif-obligatoria
  // framework as bite_incident (attachment spec §7.8 cross-ref)
  // -------------------------------------------------------------------------
  {
    kind: "outbreak_investigation",
    jurisdiction: { country: "AR" },
    laws: [
      {
        id: "ley_15465_60_decreto_3640_64",
        label: "Ley 15.465/60 + Decreto 3640/64",
        scope:
          "Enfermedades de notificación obligatoria nacional; base del sistema de vigilancia epidemiológica",
      },
      {
        id: "res_ms_2827_2022",
        label: "Res. MS 2827/2022",
        scope:
          "Aprueba el Manual de Normas y Procedimientos ENO; designa SNVS 2.0 como sistema oficial de notificación",
      },
      {
        id: "ley_3959_policia_sanitaria_animal",
        label: "Ley 3.959 (Policía Sanitaria Animal)",
        scope:
          "Ley fundacional de SENASA; base de las atribuciones federales de sanidad animal y notificación zoonótica",
      },
    ],
  },
  {
    kind: "outbreak_investigation",
    jurisdiction: { country: "AR", province: "Buenos Aires" },
    laws: [
      {
        id: "ley_5325_1948_pba",
        label: "Ley 5325/1948 PBA",
        scope: "Denuncia obligatoria de enfermedades transmisibles dentro de 24hs",
      },
    ],
  },
  {
    kind: "microchip_remediation",
    jurisdiction: { country: "AR" },
    // Provisional — exact SENASA resolution TBD (see plan 2026-05-20-microchip-replaced-ui.md §3.1).
    laws: [
      {
        id: "reglamentacion_local_identificacion_animal_ar",
        label: "Reglamentación local de identificación animal",
        scope:
          "Marco normativo nacional para identificación electrónica obligatoria de mascotas (SENASA / jurisdicciones locales)",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helper: resolve normatives for a case given its kind + jurisdiction
// ---------------------------------------------------------------------------

/**
 * Returns the union of LawReferences whose jurisdiction matches the
 * input. Matching is hierarchical: country-level always matches; a
 * province-level entry matches when the input province equals the
 * entry's; locality-level entry matches when both province AND
 * locality equal. De-dupe by law id (provincial may include the same
 * law as country-level intentionally).
 */
export function getNormativesForCase(
  kind: CaseKind,
  jurisdiction: CaseNormativesJurisdiction,
): LawReference[] {
  const matches = CASE_NORMATIVES.filter((entry) => {
    if (entry.kind !== kind) return false;
    if (entry.jurisdiction.country !== jurisdiction.country) return false;
    if (entry.jurisdiction.province !== undefined) {
      if (entry.jurisdiction.province !== jurisdiction.province) return false;
    }
    if (entry.jurisdiction.locality !== undefined) {
      if (entry.jurisdiction.locality !== jurisdiction.locality) return false;
    }
    return true;
  });

  const seen = new Set<string>();
  const out: LawReference[] = [];
  for (const m of matches) {
    for (const law of m.laws) {
      if (seen.has(law.id)) continue;
      seen.add(law.id);
      out.push(law);
    }
  }
  return out;
}

// Tiny static check at load: every CASE_KIND has at least one entry
// (even if `laws: []`). Coverage test enforces this too.
void (() => {
  const covered = new Set(CASE_NORMATIVES.map((e) => e.kind));
  const missing = CASE_KINDS.filter((k) => !covered.has(k));
  if (missing.length > 0) {
    throw new Error(
      `lib/case-normatives.ts: missing entries for case_kind(s): ${missing.join(", ")}`,
    );
  }
})();
