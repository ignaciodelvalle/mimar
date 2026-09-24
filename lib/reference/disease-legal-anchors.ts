// Legal anchor lookup for diseases (spec
// 2026-05-19-eno-vet-direct-report-and-owner-alerts §4).
//
// Maps `DISEASE.code` → the Argentine norms that compel reporting +
// related zoonosis frameworks. Used by case detail and outbreak-signal
// detail surfaces to render "Por qué te llega esto: Ley X, Res. Y".
//
// The data is NOT a database table — laws change rarely. When they do,
// edit this file and every historical signal picks up the new text on
// next render. Snapshot-into-payload only matters if a signal is being
// cited textually in an external proceeding; that's an attachments
// problem, not a data-layer one.

import { DISEASES } from "./diseases";

export interface LegalReference {
  /** Stable slug — used for dedup + UI deep-linking. */
  id: string;
  /** Display label, es-AR. */
  label: string;
  /** One-line description of what the law/norm requires. */
  scope: string;
  jurisdiction: "national" | "province" | "locality";
  /** When jurisdiction !== 'national', restricts where this anchor applies. */
  appliesTo?: { country?: string; province?: string; locality?: string };
  fullTextUrl?: string;
}

// Anchors reused across multiple disease entries. Declared once for
// trivial dedup of long objects.
const LEY_15465: LegalReference = {
  id: "ley_15465_60",
  label: "Ley 15.465 / 1960",
  scope: "Régimen legal de Enfermedades de Notificación Obligatoria (ENO)",
  jurisdiction: "national",
  fullTextUrl: "https://www.argentina.gob.ar/normativa/nacional/ley-15465-195093/texto",
};

const RES_MS_1144: LegalReference = {
  id: "res_ms_1144_2018",
  label: "Res. MS 1144 / 2018",
  scope: "Guía nacional de Prevención, Vigilancia y Control de la Rabia",
  jurisdiction: "national",
  fullTextUrl:
    "https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-1144-2018-311546/texto",
};

const RES_MS_1715: LegalReference = {
  id: "res_ms_1715_2007",
  label: "Res. MS 1715 / 2007",
  scope: "Vigilancia ENO — incluye leptospirosis",
  jurisdiction: "national",
};

const RES_MS_1811: LegalReference = {
  id: "res_ms_1811_2011",
  label: "Res. MS 1811 / 2011",
  scope: "Programa Nacional de Control de Enfermedades Zoonóticas",
  jurisdiction: "national",
};

const RES_MS_546: LegalReference = {
  id: "res_ms_546_85",
  label: "Res. MS 546 / 1985",
  scope: "Manual de procedimientos para el control de hidatidosis",
  jurisdiction: "national",
};

const DL_8056_PBA: LegalReference = {
  id: "dl_8056_73_pba",
  label: "DL 8056 / 1973 (PBA)",
  scope: "Profilaxis antirrábica en PBA — notificación obligatoria",
  jurisdiction: "province",
  appliesTo: { province: "Buenos Aires" },
};

const ORD_CABA_41831: LegalReference = {
  id: "ord_caba_41831_87",
  label: "Ord. CABA 41.831 / 1987",
  scope: "Profilaxis antirrábica en CABA — observación obligatoria 10 días",
  jurisdiction: "province",
  appliesTo: { province: "CABA" },
};

const LEY_5325_PBA: LegalReference = {
  id: "ley_5325_48_pba",
  label: "Ley 5325 / 1948 (PBA)",
  scope: "Denuncia obligatoria de enfermedades transmisibles dentro de 24hs",
  jurisdiction: "province",
  appliesTo: { province: "Buenos Aires" },
};

const RES_CVPBA_05: LegalReference = {
  id: "res_cvpba_05_2020",
  label: "Res. CVPBA 05 / 2020",
  scope: "ENO en pequeños animales (PBA) — incluye lepto, brucelosis, leishmaniasis",
  jurisdiction: "province",
  appliesTo: { province: "Buenos Aires" },
};

const LEY_6115_PBA: LegalReference = {
  id: "ley_6115_59_pba",
  label: "Ley 6115 / 1959 (PBA)",
  scope: "Profilaxis obligatoria de zoonosis (brucelosis, hidatidosis, TBC)",
  jurisdiction: "province",
  appliesTo: { province: "Buenos Aires" },
};

export const DISEASE_LEGAL_ANCHORS: Record<string, readonly LegalReference[]> = {
  rabies_confirmed: [LEY_15465, RES_MS_1144, DL_8056_PBA, ORD_CABA_41831],
  rabies_suspected: [LEY_15465, RES_MS_1144, DL_8056_PBA, ORD_CABA_41831],
  leptospirosis: [LEY_15465, RES_MS_1715, RES_CVPBA_05, LEY_5325_PBA],
  canine_brucellosis: [RES_CVPBA_05, LEY_6115_PBA],
  visceral_leishmaniasis: [RES_MS_1811, RES_CVPBA_05],
  hydatidosis: [RES_MS_1811, RES_MS_546, LEY_6115_PBA],
  tuberculosis: [LEY_15465, LEY_6115_PBA],
  anthrax: [LEY_15465],
  toxoplasmosis: [LEY_15465],
};

/**
 * Returns the legal anchors that apply to `diseaseCode` in the given
 * jurisdiction. National anchors always apply; province/locality
 * anchors are filtered to those matching the input.
 */
export function getLegalAnchorsForDisease(
  diseaseCode: string,
  jurisdiction: { country?: string; province?: string | null; locality?: string | null },
): LegalReference[] {
  const all = DISEASE_LEGAL_ANCHORS[diseaseCode] ?? [];
  return all.filter((ref) => {
    if (ref.jurisdiction === "national") return true;
    if (!ref.appliesTo) return false;
    if (ref.appliesTo.province && ref.appliesTo.province !== jurisdiction.province) return false;
    if (ref.appliesTo.locality && ref.appliesTo.locality !== jurisdiction.locality) return false;
    return true;
  });
}

// Static load-time check: every reportable disease has at least one
// anchor. The coverage test makes the same assertion at runtime; this
// throw catches a missing entry at startup.
void (() => {
  const missing: string[] = [];
  for (const d of DISEASES) {
    if (!d.reportable) continue;
    const anchors = DISEASE_LEGAL_ANCHORS[d.code];
    if (!anchors || anchors.length === 0) missing.push(d.code);
  }
  if (missing.length > 0) {
    throw new Error(
      `lib/disease-legal-anchors.ts: missing legal anchors for reportable disease(s): ${missing.join(", ")}`,
    );
  }
})();
