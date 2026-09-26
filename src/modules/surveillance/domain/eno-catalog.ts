// ENO catalog — Enfermedades de Notificación Obligatoria (Argentina).
//
// Source: spec 2026-05-21-eno-pipeline-design.md (ENO-D1 = A — Lista corta core),
// revised by the PO's legal research of 2026-09-26 (health chain S6 + addendum):
//   - Res. SENASA 422/2003 is DEROGATED (art. 22, Res. SENASA 153/2021) and is
//     no longer cited anywhere.
//   - Res. CVPBA 05/2020 (PBA small animals) says "inmediata" for its whole
//     list, cited as 24 h — the same figure as SENASA 153/2021 Grupo I and Ley
//     PBA 5325. The old 48 h / 72 h windows had no source.
//   - A window with no source for the disease is kept but flagged
//     `deadline.status: "a_confirmar"` (hidatidosis). Outside PBA the CVPBA
//     "inmediata" does not bind; any other province's longer window is "a
//     confirmar" too (each `deadline.source` says where its figure binds).
//
// DO NOT add diseases here without a PO decision naming the norm. Every
// disease the catalog marks `reportable` must be in this list or in the
// exemption map (eno-catalog.test.ts enforces it).
//
// Zero runtime imports — pure domain data.

export type EnoDisease = {
  /** Stable key used for indexing and payload discrimination. */
  code: string;
  /** Display name in Spanish. */
  label: string;
  /** Notification severity — drives badge color in govt inbox. */
  severity: "critical" | "high";
  /** Legal SLA window (hours) for notifying the govt authority. */
  notifyHours: number;
  /** Where `notifyHours` comes from, and whether a norm backs it. */
  deadline: {
    /** The norm (and scope) the window is read from, or why it is unconfirmed. */
    source: string;
    /** "sourced" = a norm in force states it; "a_confirmar" = kept pending a source. */
    status: "sourced" | "a_confirmar";
  };
  /**
   * When true, the owner is NOT auto-notified.
   * The vet communicates the diagnosis directly to preserve the sensitive
   * clinical context (ENO-D4 = B — stigma filter; PO S8).
   */
  stigmaSensitive: boolean;
  /**
   * Only a vet or a lab raises it — never an owner's or a witness's free text:
   * no symptom may link to it (__tests__/disease-legal-anchors.test.ts).
   */
  vetOnly: boolean;
  /**
   * Which authority the norm names as the receiver. "zoonosis" = the
   * municipal zoonosis centre (the CVPBA channel, onward to SNVS 2.0);
   * "senasa" = SENASA's local office (Res. SENASA 153/2021).
   */
  authority: "zoonosis" | "senasa";
  /** Legal anchor cited in the audit trail and future govt UI. */
  legalAnchor: string;
};

const CVPBA_24H = "Res. CVPBA 05/2020 («inmediata») = 24 h en PBA; fuera de PBA a confirmar";

export const ENO_DISEASES_AR: readonly EnoDisease[] = [
  {
    code: "rabies",
    label: "Rabia",
    severity: "critical",
    notifyHours: 24,
    deadline: { source: `${CVPBA_24H}; Ley PBA 5325 (24 h)`, status: "sourced" },
    stigmaSensitive: false,
    vetOnly: false,
    authority: "zoonosis",
    legalAnchor: "Ley 22.953 (control rabia) + Res. CVPBA 05/2020 (PBA)",
  },
  {
    code: "leptospirosis",
    label: "Leptospirosis",
    severity: "high",
    notifyHours: 24,
    deadline: { source: CVPBA_24H, status: "sourced" },
    stigmaSensitive: false,
    vetOnly: false,
    authority: "zoonosis",
    legalAnchor: "Ley 15.465 (ENO nacional) + Res. CVPBA 05/2020 (PBA)",
  },
  {
    code: "hidatidosis",
    label: "Hidatidosis / Equinococosis",
    severity: "high",
    notifyHours: 48,
    deadline: {
      source:
        "Plazo sin confirmar: la Res. CVPBA 05/2020 no la lista y no se halló norma que fije horas",
      status: "a_confirmar",
    },
    stigmaSensitive: false,
    vetOnly: false,
    authority: "zoonosis",
    legalAnchor: "Res. MS 546/85 + Ley PBA 6115/1959",
  },
  {
    code: "brucelosis_canina",
    label: "Brucelosis canina",
    severity: "high",
    notifyHours: 24,
    deadline: { source: CVPBA_24H, status: "sourced" },
    stigmaSensitive: true,
    vetOnly: false,
    authority: "zoonosis",
    legalAnchor: "Res. CVPBA 05/2020 (PBA) + Ley PBA 6115/1959",
  },
  {
    code: "leishmaniasis",
    label: "Leishmaniasis visceral canina",
    severity: "critical",
    notifyHours: 24,
    deadline: { source: CVPBA_24H, status: "sourced" },
    stigmaSensitive: true,
    vetOnly: false,
    authority: "zoonosis",
    legalAnchor: "Res. CVPBA 05/2020 (PBA) + Res. MS 1811/2011",
  },
  {
    // PO S6 (2026-09-26): "micobacteriosis en pequeños animales" in the CVPBA
    // list. National side: SENASA 153/2021 Grupo II, per the specific norm,
    // with no hour figure — hence "a confirmar" outside PBA.
    code: "tuberculosis",
    label: "Tuberculosis (micobacterias)",
    severity: "high",
    notifyHours: 24,
    deadline: { source: CVPBA_24H, status: "sourced" },
    stigmaSensitive: false,
    vetOnly: false,
    authority: "zoonosis",
    legalAnchor: "Res. CVPBA 05/2020 (micobacterias) + Ley PBA 6115/1959",
  },
  {
    // Carbunco: very rare in dogs and cats (rural, from carcasses). The
    // animal-side norm is SENASA's, and SENASA is the receiver — not the
    // municipal zoonosis centre. Never from owner text.
    code: "anthrax",
    label: "Carbunco (ántrax)",
    severity: "critical",
    notifyHours: 24,
    deadline: {
      source: "Res. SENASA 153/2021 Grupo I: dentro de las 24 h de la sospecha",
      status: "sourced",
    },
    stigmaSensitive: false,
    vetOnly: true,
    authority: "senasa",
    legalAnchor: "Res. SENASA 153/2021 (Grupo I)",
  },
  {
    // A feline zoonosis spread by scratches, in outbreak in the AMBA.
    // Stigma-sensitive like leishmaniasis: the vet tells the owner.
    code: "esporotricosis",
    label: "Esporotricosis",
    severity: "high",
    notifyHours: 24,
    deadline: { source: CVPBA_24H, status: "sourced" },
    stigmaSensitive: true,
    vetOnly: false,
    authority: "zoonosis",
    legalAnchor: "Res. CVPBA 05/2020 (PBA)",
  },
  {
    // Low priority; a lab finding — only a vet or a lab raises it.
    code: "dirofilariosis",
    label: "Dirofilariosis",
    severity: "high",
    notifyHours: 24,
    deadline: { source: CVPBA_24H, status: "sourced" },
    stigmaSensitive: false,
    vetOnly: true,
    authority: "zoonosis",
    legalAnchor: "Res. CVPBA 05/2020 (PBA)",
  },
] as const;

/**
 * Diseases the catalog marks `reportable` that are deliberately NOT in the ENO
 * list, each with the reason. A reportable code must be in ENO_DISEASES_AR or
 * here — never silently in neither (health audit #9). Empty since the PO's
 * legal research of 2026-09-26: anthrax entered the list and toxoplasmosis is
 * no longer reportable.
 */
export const ENO_EXEMPT_REPORTABLE: Readonly<Record<string, string>> = {};

// ---------------------------------------------------------------------------
// O(1) lookup index
// ---------------------------------------------------------------------------

const _indexByCode = new Map<string, EnoDisease>(ENO_DISEASES_AR.map((d) => [d.code, d]));

/**
 * Returns the EnoDisease for a given catalog code, or null if not found.
 * Callers that receive form-emitted disease codes MUST route through
 * diseaseCodeToEnoCode first.
 */
export function getEnoDisease(code: string): EnoDisease | null {
  return _indexByCode.get(code) ?? null;
}

/**
 * Returns true when the given code is a canonical ENO catalog code.
 * Form-emitted codes (e.g. 'rabies_confirmed') return false — use the bridge.
 */
export function isEnoCode(code: string): boolean {
  return _indexByCode.has(code);
}

// ---------------------------------------------------------------------------
// Bridge — diagnosis-form codes → ENO catalog codes
// ---------------------------------------------------------------------------
//
// The diagnosis form emits granular codes (e.g. 'rabies_confirmed',
// 'rabies_suspected'). The ENO catalog uses coarser locked-by-spec codes
// (e.g. 'rabies'). Every caller that wants "is this ENO?" or disease details
// MUST route the form code through this function first.

const DISEASE_TO_ENO_CODE: Readonly<Record<string, string>> = {
  rabies_confirmed: "rabies",
  rabies_suspected: "rabies",
  canine_brucellosis: "brucelosis_canina",
  visceral_leishmaniasis: "leishmaniasis",
  hydatidosis: "hidatidosis",
  sporotrichosis: "esporotricosis",
  dirofilariasis: "dirofilariosis",
  // disease_reported emits the short "lepto" (DISEASE_REPORTED_CODES). Inert
  // today — no outbox rule reads disease_reported, and adding one is a PO
  // decision — but without it that rule would silently miss leptospirosis
  // (health audit #2, 2026-09-26).
  lepto: "leptospirosis",
};

/**
 * Normalizes a diagnosis-form disease_code to its matching ENO catalog code.
 * Returns the input unchanged when no mapping exists (including already-
 * canonical catalog codes).
 */
export function diseaseCodeToEnoCode(code: string): string {
  return DISEASE_TO_ENO_CODE[code] ?? code;
}
