// SENASA sanitary-event vocabulary (compliance handoff PR 3).
//
// TS const mirror of the seed data in migration 0060 (ref.tipo_evento_sanitario,
// ref.via_aplicacion, ref.jurisdiccion_sanitaria). The DB is the source of
// truth — these constants exist so app code (forms, badges, validation) can
// reason about the vocabulary without a round-trip per render.
//
// Drift discipline: if you change the seed in 0060, mirror the change here.
// A test in __tests__/sanitary-vocab.test.ts pins the constants against the
// live DB rows on every CI run.

export const TIPO_EVENTO_SANITARIO = [
  {
    code: "vacunacion_antirrabica",
    labelEs: "Vacunación antirrábica",
    normaOrigen: "Ley 22.953/1983 + Res. MS 1144/2018",
    requiereLote: true,
    requiereVia: true,
    notificableEno: true,
  },
  {
    code: "vacunacion_quintuple",
    labelEs: "Vacunación quíntuple",
    normaOrigen: "LSUCyF (SENASA, 2022)",
    requiereLote: true,
    requiereVia: true,
    notificableEno: false,
  },
  {
    code: "vacunacion_sextuple",
    labelEs: "Vacunación séxtuple",
    normaOrigen: "LSUCyF (SENASA, 2022)",
    requiereLote: true,
    requiereVia: true,
    notificableEno: false,
  },
  {
    code: "vacunacion_octuple",
    labelEs: "Vacunación óctuple",
    normaOrigen: "LSUCyF (SENASA, 2022)",
    requiereLote: true,
    requiereVia: true,
    notificableEno: false,
  },
  {
    code: "vacunacion_triple_felina",
    labelEs: "Vacunación triple felina",
    normaOrigen: "LSUCyF (SENASA, 2022)",
    requiereLote: true,
    requiereVia: true,
    notificableEno: false,
  },
  {
    code: "desparasitacion_interna",
    labelEs: "Desparasitación interna",
    normaOrigen: "Res. MS 546/1985 (hidatidosis)",
    requiereLote: true,
    requiereVia: false,
    notificableEno: false,
  },
  {
    code: "desparasitacion_externa",
    labelEs: "Desparasitación externa",
    normaOrigen: "LSUCyF (SENASA, 2022)",
    requiereLote: true,
    requiereVia: false,
    notificableEno: false,
  },
  {
    code: "prescripcion_electronica",
    labelEs: "Receta Electrónica Veterinaria",
    normaOrigen: "Res. SENASA 80/2025",
    requiereLote: false,
    requiereVia: false,
    notificableEno: false,
  },
  {
    code: "consulta_clinica",
    labelEs: "Consulta clínica",
    normaOrigen: "Ley 14.072/1951",
    requiereLote: false,
    requiereVia: false,
    notificableEno: false,
  },
  {
    code: "cirugia_general",
    labelEs: "Cirugía general",
    normaOrigen: "Ley 14.072/1951",
    requiereLote: false,
    requiereVia: false,
    notificableEno: false,
  },
  {
    code: "esterilizacion_quirurgica",
    labelEs: "Esterilización quirúrgica",
    normaOrigen: "Ley CABA 1.338/2004 / PBA 13.879/2008",
    requiereLote: false,
    requiereVia: false,
    notificableEno: false,
  },
  {
    code: "observacion_antirrabica",
    labelEs: "Observación antirrábica (10 días)",
    normaOrigen: "Ord. CABA 41.831 art. 9°",
    requiereLote: false,
    requiereVia: false,
    notificableEno: true,
  },
  {
    code: "mordedura_notificada",
    labelEs: "Mordedura — notificación",
    normaOrigen: "Ley 15.465/1960 (ENO)",
    requiereLote: false,
    requiereVia: false,
    notificableEno: true,
  },
  {
    code: "defuncion",
    labelEs: "Defunción",
    normaOrigen: "Ord. CABA 41.831 art. 11",
    requiereLote: false,
    requiereVia: false,
    notificableEno: false,
  },
  {
    code: "transferencia_tenencia",
    labelEs: "Transferencia de tenencia",
    normaOrigen: "Art. 1947 CCyCN",
    requiereLote: false,
    requiereVia: false,
    notificableEno: false,
  },
  {
    code: "extravio_reportado",
    labelEs: "Extravío reportado",
    normaOrigen: "Decreto 1.088/2011",
    requiereLote: false,
    requiereVia: false,
    notificableEno: false,
  },
  {
    code: "recuperacion_reportada",
    labelEs: "Recuperación reportada",
    normaOrigen: "Decreto 1.088/2011",
    requiereLote: false,
    requiereVia: false,
    notificableEno: false,
  },
] as const;

export type TipoEventoSanitarioCode = (typeof TIPO_EVENTO_SANITARIO)[number]["code"];

export const VIA_APLICACION = [
  { code: "sc", labelEs: "Subcutánea" },
  { code: "im", labelEs: "Intramuscular" },
  { code: "iv", labelEs: "Endovenosa" },
  { code: "vo", labelEs: "Oral" },
  { code: "top", labelEs: "Tópica" },
  { code: "in", labelEs: "Intranasal" },
] as const;

export type ViaAplicacionCode = (typeof VIA_APLICACION)[number]["code"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIPO_INDEX = new Map(TIPO_EVENTO_SANITARIO.map((t) => [t.code, t]));

export function tipoEventoLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return TIPO_INDEX.get(code as TipoEventoSanitarioCode)?.labelEs ?? null;
}

export function tipoEventoNorma(code: string | null | undefined): string | null {
  if (!code) return null;
  return TIPO_INDEX.get(code as TipoEventoSanitarioCode)?.normaOrigen ?? null;
}

/** Returns true if the type requires a biologic lot (vaccines, dewormers). */
export function requiresLote(code: string | null | undefined): boolean {
  if (!code) return false;
  return TIPO_INDEX.get(code as TipoEventoSanitarioCode)?.requiereLote ?? false;
}

/** Returns true if the type requires an application route (vaccines). */
export function requiresVia(code: string | null | undefined): boolean {
  if (!code) return false;
  return TIPO_INDEX.get(code as TipoEventoSanitarioCode)?.requiereVia ?? false;
}

/**
 * Returns true if the type triggers an ENO (Enfermedades de Notificación
 * Obligatoria) outbox row. Used to drive the auto-fanout in a future PR.
 */
export function notificableEno(code: string | null | undefined): boolean {
  if (!code) return false;
  return TIPO_INDEX.get(code as TipoEventoSanitarioCode)?.notificableEno ?? false;
}
