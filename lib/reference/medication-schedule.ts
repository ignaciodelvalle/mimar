// Frequency model and dose schedule generator for medication reminders.
// No medical-advice calculations — this is scheduling arithmetic only.

import type { FrequencyKind } from "@/lib/reference/drugs";
import { parseArDatetimeLocal } from "@/lib/utils/format";

// Maximum number of auto-generated reminders when no duration is specified.
// 28 = 14 days × 2 doses/day (the most common twice-daily antibiotics).
// This prevents runaway reminder creation for indefinite-duration medications.
export const MAX_AUTO_REMINDERS = 28;

export type { FrequencyKind };

// Human-readable es-AR labels for each frequency kind.
export const FREQUENCY_LABELS: Record<FrequencyKind, string> = {
  once_daily: "1 vez al día",
  twice_daily: "2 veces al día",
  three_times_daily: "3 veces al día",
  four_times_daily: "4 veces al día",
  single_dose: "Dosis única",
  custom: "Personalizada",
};

/**
 * Returns the interval in hours between doses, or null for single_dose.
 * For "custom", `customHours` is required (1–24).
 */
export function intervalHoursForFrequency(
  kind: FrequencyKind,
  customHours?: number | null,
): number | null {
  switch (kind) {
    case "once_daily":
      return 24;
    case "twice_daily":
      return 12;
    case "three_times_daily":
      return 8;
    case "four_times_daily":
      return 6;
    case "single_dose":
      return null;
    case "custom":
      return customHours ?? null;
    default:
      return null;
  }
}

/**
 * Generates an array of Date objects representing when each dose is due.
 * - single_dose: returns [firstDoseAt] only.
 * - intervalHours null: returns [firstDoseAt] (safety fallback).
 * - durationDays null: generates up to MAX_AUTO_REMINDERS doses.
 * - Never returns more than MAX_AUTO_REMINDERS entries regardless of duration.
 */
export function generateDoseSchedule(input: {
  firstDoseAt: Date;
  intervalHours: number | null;
  durationDays: number | null;
}): Date[] {
  const { firstDoseAt, intervalHours, durationDays } = input;

  // Single dose or no interval: exactly one reminder.
  if (intervalHours === null) {
    return [new Date(firstDoseAt)];
  }

  // Compute the cutoff timestamp.
  let maxDoses: number;
  if (durationDays !== null) {
    // +1 to include the last dose on the final day when the interval divides cleanly.
    const totalHours = durationDays * 24 + 1;
    maxDoses = Math.ceil(totalHours / intervalHours);
  } else {
    maxDoses = MAX_AUTO_REMINDERS;
  }

  // Cap regardless of input.
  maxDoses = Math.min(maxDoses, MAX_AUTO_REMINDERS);

  const schedule: Date[] = [];
  const intervalMs = intervalHours * 60 * 60 * 1000;
  for (let i = 0; i < maxDoses; i++) {
    schedule.push(new Date(firstDoseAt.getTime() + i * intervalMs));
  }
  return schedule;
}

/**
 * Validates and coerces frequency-related form fields.
 * Returns an error string on failure, or the parsed values on success.
 */
export function parseFrequencyFields(
  frequencyRaw: string,
  customHoursRaw: string | null,
  durationDaysRaw: string | null,
  firstDoseAtRaw: string | null,
):
  | { error: string }
  | {
      error: null;
      frequency: FrequencyKind;
      customHours: number | null;
      durationDays: number | null;
      firstDoseAt: Date;
    } {
  const VALID_FREQUENCIES: FrequencyKind[] = [
    "once_daily",
    "twice_daily",
    "three_times_daily",
    "four_times_daily",
    "single_dose",
    "custom",
  ];

  if (!VALID_FREQUENCIES.includes(frequencyRaw as FrequencyKind)) {
    return { error: "Frecuencia inválida." };
  }
  const frequency = frequencyRaw as FrequencyKind;

  let customHours: number | null = null;
  if (frequency === "custom") {
    const raw = customHoursRaw ?? "";
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 24) {
      return { error: "El intervalo personalizado debe ser entre 1 y 24 horas." };
    }
    customHours = parsed;
  }

  let durationDays: number | null = null;
  if (durationDaysRaw && durationDaysRaw.trim() !== "") {
    const parsed = Number.parseInt(durationDaysRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) {
      return { error: "La duración debe ser entre 1 y 90 días." };
    }
    durationDays = parsed;
  }

  // Parse firstDoseAt from a datetime-local string ("YYYY-MM-DDTHH:mm") as AR
  // wall-clock time. NOT "local browser time read as-is": this code runs on
  // the SERVER, where an offset-less `new Date(...)` parses in the server's
  // zone (UTC) — every dose reminder then fires 3 hours early.
  if (!firstDoseAtRaw || firstDoseAtRaw.trim() === "") {
    return { error: "Falta la fecha/hora de la primera dosis." };
  }
  const firstDoseAt = parseArDatetimeLocal(firstDoseAtRaw);
  if (!firstDoseAt) {
    return { error: "Fecha/hora de primera dosis inválida." };
  }

  return { error: null, frequency, customHours, durationDays, firstDoseAt };
}
