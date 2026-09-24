// Shared helper: pure functions to derive ReminderCard display state.
// No DB access — all inputs are pre-loaded by the call site.

import { normalizeText } from "@/lib/utils/text-normalize";

/**
 * Cinco variantes de visualización para un recordatorio de vacuna.
 *
 * - upcoming          → vence en 8+ días.
 * - due_soon          → vence en 1–7 días.
 * - overdue           → vencida hace 0–30 días.
 * - overdue_critical  → vencida hace >30 días Y la vacuna es reportable
 *                       (rabia, parvo, distemper en perro; rabia, panleucopenia en gato).
 * - success           → recordatorio resuelto (vacuna registrada).
 */
export type ReminderVariant = "upcoming" | "due_soon" | "overdue" | "overdue_critical" | "success";

/**
 * Deriva la variante de visualización a partir de los días hasta el vencimiento.
 *
 * @param daysUntilDue - Días hasta el vencimiento. Negativo = ya vencida.
 * @param isReportable - True cuando la vacuna pertenece a `REPORTABLE_VACCINES_BY_SPECIES`
 *                       para la especie del pet. El caller lo resuelve con `isVaccineReportable`.
 *
 * Reglas de borde:
 *  - daysUntilDue = 8  → upcoming  (techo exclusivo de due_soon).
 *  - daysUntilDue = 1  → due_soon  (techo exclusivo de overdue).
 *  - daysUntilDue = 0  → overdue   (vence hoy = ya vencida semánticamente).
 *  - daysUntilDue = -30 → overdue  (el umbral crítico es >30, no >=30).
 *  - daysUntilDue = -31 → overdue_critical (si isReportable=true), overdue si no.
 */
export function getReminderVariant(daysUntilDue: number, isReportable: boolean): ReminderVariant {
  if (daysUntilDue >= 8) return "upcoming";
  if (daysUntilDue >= 1) return "due_soon";
  if (daysUntilDue > -30) return "overdue";
  // Vencida hace más de 30 días.
  return isReportable ? "overdue_critical" : "overdue";
}

/**
 * Horizonte (en días) dentro del cual un vencimiento de vacuna cuenta como
 * "próximo" en el saludo del home del dueño (#45, PO QA §2).
 *
 * El QA detectó que el contador "N vencimientos próximos" incluía recordatorios
 * a 363/364 días (la próxima dosis anual recién registrada), inflando la
 * urgencia: una dosis que vence dentro de ~1 año NO es "próxima". Con este
 * horizonte, sólo los recordatorios vencidos o que vencen dentro de 60 días
 * cuentan como próximos. Los que están más lejos siguen apareciendo en la lista
 * completa de recordatorios; simplemente no inflan el contador.
 *
 * 60 días (≈ 2 meses) da margen accionable sin arrastrar dosis del año que
 * viene. Los vencidos (daysUntilDue negativo) siempre cuentan: son lo más
 * urgente, nunca "lejanos".
 */
export const PROXIMOS_HORIZON_DAYS = 60;

/**
 * True cuando un recordatorio es "próximo": vencido o dentro del horizonte.
 */
export function isReminderProximo(
  daysUntilDue: number,
  horizonDays: number = PROXIMOS_HORIZON_DAYS,
): boolean {
  return daysUntilDue <= horizonDays;
}

/**
 * Cuenta los recordatorios que son realmente "próximos" (vencidos + los que
 * vencen dentro del horizonte). Genérico sobre cualquier fila que exponga
 * `daysUntilDue`, así el home puede pasar sus `ActiveReminderRow[]` sin acoplar
 * este módulo puro a la capa de datos.
 */
export function countProximosReminders<T extends { daysUntilDue: number }>(
  reminders: readonly T[],
  horizonDays: number = PROXIMOS_HORIZON_DAYS,
): number {
  return reminders.reduce(
    (n, r) => n + (isReminderProximo(r.daysUntilDue, horizonDays) ? 1 : 0),
    0,
  );
}

/** Los "próximos" partidos en las dos cosas distintas que son. */
export type ProximosSplit = {
  /** Ya vencidos (el plazo pasó). */
  vencidas: number;
  /** Todavía en plazo, pero vencen dentro del horizonte. */
  porVencer: number;
  /** vencidas + porVencer — el total que `countProximosReminders` devuelve. */
  total: number;
};

/**
 * Parte el bucket "próximos" en VENCIDAS y POR VENCER (D-11, Lote D).
 *
 * El landing por-mascota ya distingue las dos: `getReminderVariant` arriba las
 * separa y `rabiesFromVariant` (lib/projections/pet-compliance.ts) las rotula
 * "Vencida" y "Por vencer", con fecha. El rollup de /mis-mascotas las plegaba en
 * un solo número — así, dos dueños con la misma cifra podían estar en
 * situaciones opuestas: uno con tres dosis fuera de plazo (incumplimiento hoy) y
 * otro con tres dosis por vencer el mes que viene (nada que hacer todavía).
 *
 * REUSA el clasificador, no lo reimplementa: la línea vencida/por-vencer sale de
 * `getReminderVariant`, la misma función que alimenta las tarjetas por mascota,
 * así que el rollup y el detalle no pueden discrepar. `isReportable` se pasa en
 * false a propósito: sólo separa `overdue` de `overdue_critical`, y ambas SON
 * vencidas — la criticidad es otra pregunta, y fingir que la conocemos acá
 * exigiría la especie de cada mascota, que este módulo puro no tiene.
 */
export function splitProximosReminders<T extends { daysUntilDue: number }>(
  reminders: readonly T[],
  horizonDays: number = PROXIMOS_HORIZON_DAYS,
): ProximosSplit {
  let vencidas = 0;
  let porVencer = 0;
  for (const r of reminders) {
    if (!isReminderProximo(r.daysUntilDue, horizonDays)) continue;
    const variant = getReminderVariant(r.daysUntilDue, false);
    if (variant === "overdue" || variant === "overdue_critical") vencidas += 1;
    else porVencer += 1;
  }
  return { vencidas, porVencer, total: vencidas + porVencer };
}

/**
 * Deriva la variante `success` cuando el recordatorio está marcado como completado.
 *
 * Decisión de API (C1): el caller pasa un booleano `completed` en lugar de `completedAt`
 * porque la comparación de fechas ya ocurrió en `loadActiveRemindersForUser` (C3) al filtrar
 * filas. El helper solo necesita saber si el recordatorio fue resuelto.
 *
 * @param completed - True cuando `reminders.completed_at IS NOT NULL`.
 */
export function getCompletedVariant(completed: boolean): ReminderVariant | null {
  return completed ? "success" : null;
}

// ---------------------------------------------------------------------------
// Catálogo de vacunas reportables (hardcoded — decisión C-D2)
//
// TODO(eno): reemplazar por `getReportableVaccines(species, jurisdiction)` importado
// desde `lib/disease-public-alert-catalog.ts` una vez que el diseño
// `docs/superpowers/specs/2026-05-19-eno-vet-direct-report-and-owner-alerts-design.md`
// sea implementado. La API pública ya acepta `jurisdiction` por lo que el swap
// es no-breaking (decisión C-D2).
// ---------------------------------------------------------------------------

const REPORTABLE_VACCINES_BY_SPECIES: Record<string, readonly string[]> = {
  dog: ["rabia", "parvo", "distemper"],
  cat: ["rabia", "panleucopenia"],
};

// Internal matching roots, diacritics-free. "rabi" covers both "rabia" and "antirrábica"
// ("antirrabica".includes("rabia") = false because the embedded root is "rrabica", not "rabia").
// These roots are not exposed — they only drive isVaccineReportable substring matching.
const REPORTABLE_MATCH_ROOTS_BY_SPECIES: Record<string, readonly string[]> = {
  dog: ["rabi", "parvo", "distemper"],
  cat: ["rabi", "panleucopenia"],
};

/**
 * Retorna la lista de vacunas reportables para una especie y jurisdicción.
 *
 * @param species      - Especie del pet ("dog", "cat", etc.)
 * @param _jurisdiction - Jurisdicción (ignorada en esta versión hardcoded; se usará
 *                        en la implementación de `disease-public-alert-catalog.ts`).
 * @returns Array de strings con los nombres de vacunas reportables. Vacío si la especie
 *          no tiene vacunas reportables registradas.
 */
export function getReportableVaccines(species: string, _jurisdiction: string): readonly string[] {
  return REPORTABLE_VACCINES_BY_SPECIES[species] ?? [];
}

/**
 * Normaliza un string para comparación: lowercase + elimina diacríticos (NFD decompose + strip marks)
 * + colapsa espacios.
 * Permite que "Antirrábica" matchee "rabia": "antirrabica".includes("rabia") → true.
 *
 * Exportada para reuso fuera de este módulo (ej: matching case/accent-insensitive
 * de títulos de recordatorios de vacuna en vaccination-use-case.ts, ya que no existe
 * una clave estructural de tipo-de-vacuna en `reminders` — el título es texto libre).
 *
 * Re-exportada desde la implementación canónica en lib/utils/text-normalize.ts
 * (compartida con lib/domain/symptom-matcher.ts y lib/reference/vaccine-fuzzy-match.ts).
 * Único cambio de comportamiento vs. la versión previa: ahora también colapsa
 * espacios — no afecta a ningún caller existente (compara substrings/igualdad
 * de títulos, nunca depende de espacios crudos).
 */
export const normalize = normalizeText;

/**
 * Determina si una vacuna es reportable (obligatoria por ley) para una especie y jurisdicción.
 *
 * La comparación es case-insensitive y diacritic-insensitive, busca por substring.
 * Por ejemplo, "Antirrábica" matchea "rabia": normalize("Antirrábica") = "antirrabica",
 * que contiene normalize("rabia") = "rabia".
 *
 * @param vaccineName  - Nombre de la vacuna como aparece en el registro (ej: "Antirrábica anual").
 * @param species      - Especie del pet.
 * @param jurisdiction - Jurisdicción del pet (CABA, PROV_BA, etc.).
 */
export function isVaccineReportable(
  vaccineName: string,
  species: string,
  jurisdiction: string,
): boolean {
  const roots = REPORTABLE_MATCH_ROOTS_BY_SPECIES[species] ?? [];
  const normalizedName = normalize(vaccineName);
  return roots.some((root) => normalizedName.includes(normalize(root)));
}
