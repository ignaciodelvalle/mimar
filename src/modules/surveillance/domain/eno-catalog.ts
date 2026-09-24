// ENO catalog — Enfermedades de Notificación Obligatoria (Argentina).
//
// Source: spec 2026-05-21-eno-pipeline-design.md (ENO-D1 = A — Lista corta core).
// Decision ENO-D1: 5 zoonotic diseases + severity tiers critical/high.
//
// DO NOT add diseases here without updating the spec. The list is locked per
// ENO-D1 (2026-05-21).
//
// Legal framework: SENASA + ministerios provinciales bajo Ley 15.465/1960
// (Decreto 3640/64) + Res. MS 2827/2022 (Manual ENO; SNVS 2.0) + Res. SENASA 422/2003.
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
  /**
   * When true, the owner is NOT auto-notified.
   * The vet communicates the diagnosis directly to preserve the sensitive
   * clinical context (ENO-D4 = B — stigma filter).
   */
  stigmaSensitive: boolean;
  /** Legal anchor cited in the audit trail and future govt UI. */
  legalAnchor: string;
};

export const ENO_DISEASES_AR: readonly EnoDisease[] = [
  {
    code: "rabies",
    label: "Rabia",
    severity: "critical",
    notifyHours: 24,
    stigmaSensitive: false,
    legalAnchor: "Ley 22.953 (control rabia)",
  },
  {
    code: "leptospirosis",
    label: "Leptospirosis",
    severity: "high",
    notifyHours: 48,
    stigmaSensitive: false,
    legalAnchor: "Ley 15.465 (ENO nacional) + Decreto 1088/2011 (ProTenencia)",
  },
  {
    code: "hidatidosis",
    label: "Hidatidosis / Equinococosis",
    severity: "high",
    notifyHours: 48,
    stigmaSensitive: false,
    legalAnchor: "Res. SENASA 422/2003 (Anexo II) + Decreto 1088/2011 (ProTenencia)",
  },
  {
    code: "brucelosis_canina",
    label: "Brucelosis canina",
    severity: "high",
    notifyHours: 72,
    stigmaSensitive: true,
    legalAnchor: "Res. SENASA 422/2003 (Anexo II)",
  },
  {
    code: "leishmaniasis",
    label: "Leishmaniasis visceral canina",
    severity: "critical",
    notifyHours: 48,
    stigmaSensitive: true,
    legalAnchor: "Res. SENASA 422/2003 (Anexo II)",
  },
] as const;

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
};

/**
 * Normalizes a diagnosis-form disease_code to its matching ENO catalog code.
 * Returns the input unchanged when no mapping exists (including already-
 * canonical catalog codes).
 */
export function diseaseCodeToEnoCode(code: string): string {
  return DISEASE_TO_ENO_CODE[code] ?? code;
}
