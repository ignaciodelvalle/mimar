// The "Estado al ingreso" form, parsed once (vet-visit-record, 2026-09-29).
//
// Fields (all names are the FormData keys):
//   generalCondition    — good | fair | poor | critical (required)
//   presentingComplaint — "Motivo de consulta", optional text ≤ 500
//   findings            — "Hallazgos", optional text ≤ 2000
//   temperatureC        — optional, decimal comma or point, 30–45 °C
//   heartRateBpm        — optional integer, 20–400
//   respiratoryRateRpm  — optional integer, 4–200
//   bodyConditionScore  — optional integer, 1–9
//   hydration           — optional: normal | mild | moderate | severe
//   mucousMembranes     — optional: pink | pale | cyanotic | icteric | hyperemic
//   weightKg            — optional, decimal comma or point, (0, MAX_WEIGHT_KG]
//   clientIdempotencyKey — optional uuid
//
// The refusals mirror the zod schema's bounds (INTAKE_VITAL_BOUNDS) so a vet
// reads a sentence about the field, never a schema error. Weight is parsed
// here but is NOT part of the intake payload: the use-case writes it as its
// own weight_recorded.

import {
  INTAKE_FINDINGS_MAX,
  INTAKE_GENERAL_CONDITIONS,
  INTAKE_HYDRATION_LEVELS,
  INTAKE_MUCOUS_MEMBRANES,
  INTAKE_PRESENTING_COMPLAINT_MAX,
  INTAKE_VITAL_BOUNDS,
} from "@/lib/events/event-schemas";
import { isUuid } from "@/lib/utils/uuid";
import { MAX_WEIGHT_KG } from "@dim/contract/input";

export type IntakeGeneralCondition = (typeof INTAKE_GENERAL_CONDITIONS)[number];
export type IntakeHydration = (typeof INTAKE_HYDRATION_LEVELS)[number];
export type IntakeMucousMembranes = (typeof INTAKE_MUCOUS_MEMBRANES)[number];

export type IntakeVitals = {
  temperature_c?: number;
  heart_rate_bpm?: number;
  respiratory_rate_rpm?: number;
  body_condition_score?: number;
  hydration?: IntakeHydration;
  mucous_membranes?: IntakeMucousMembranes;
};

export type ConditionAtIntakeFields = {
  generalCondition: IntakeGeneralCondition;
  presentingComplaint: string | null;
  findings: string | null;
  /** Absent when no vital was entered. */
  vitals: IntakeVitals | null;
  /** toFixed(2) string, the weight_recorded payload format; null when not weighed. */
  weightKg: string | null;
  clientIdempotencyKey: string | null;
};

export type ConditionAtIntakeParse =
  | { ok: true; value: ConditionAtIntakeFields }
  | { ok: false; error: string };

function text(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

/** es-AR decimals come with a comma; accept both. NaN when not a number. */
function decimal(raw: string): number {
  const normalized = raw.replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
}

function oneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | null | "invalid" {
  if (value === null) return null;
  return (allowed as readonly string[]).includes(value) ? (value as T) : "invalid";
}

/** toFixed(2) string, the weight_recorded payload format; null when not weighed. */
function parseWeightKg(
  formData: FormData,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const raw = text(formData, "weightKg");
  if (raw === null) return { ok: true, value: null };
  const kg = decimal(raw);
  if (!Number.isFinite(kg) || kg <= 0) return { ok: false, error: "Peso inválido." };
  if (kg > MAX_WEIGHT_KG) {
    return { ok: false, error: `El peso no puede superar los ${MAX_WEIGHT_KG} kg.` };
  }
  return { ok: true, value: kg.toFixed(2) };
}

/**
 * `client_idempotency_key` is a Postgres `uuid` column: a malformed value
 * here would otherwise surface as a raw "invalid input syntax for type uuid"
 * error out of the insert instead of a sentence the vet can read.
 */
function parseClientIdempotencyKey(
  formData: FormData,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const raw = text(formData, "clientIdempotencyKey");
  if (raw === null) return { ok: true, value: null };
  if (!isUuid(raw)) {
    return { ok: false, error: "Identificador de envío inválido. Volvé a intentar." };
  }
  return { ok: true, value: raw };
}

type Bounded = { min: number; max: number };

function boundedNumber(
  formData: FormData,
  key: string,
  bounds: Bounded,
  opts: { integer: boolean; label: string; unit: string },
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const raw = text(formData, key);
  if (raw === null) return { ok: true, value: undefined };
  const n = decimal(raw);
  const range = `entre ${bounds.min} y ${bounds.max}${opts.unit}`;
  if (!Number.isFinite(n) || (opts.integer && !Number.isInteger(n))) {
    return {
      ok: false,
      error: `${opts.label}: ingresá un número${opts.integer ? " entero" : ""} ${range}.`,
    };
  }
  if (n < bounds.min || n > bounds.max) {
    return { ok: false, error: `${opts.label}: tiene que estar ${range}.` };
  }
  return { ok: true, value: n };
}

export function parseConditionAtIntakeForm(formData: FormData): ConditionAtIntakeParse {
  const generalCondition = oneOf(text(formData, "generalCondition"), INTAKE_GENERAL_CONDITIONS);
  if (generalCondition === null || generalCondition === "invalid") {
    return { ok: false, error: "Elegí el estado general del animal al ingreso." };
  }

  const presentingComplaint = text(formData, "presentingComplaint");
  if (presentingComplaint && presentingComplaint.length > INTAKE_PRESENTING_COMPLAINT_MAX) {
    return {
      ok: false,
      error: `El motivo de consulta no puede superar los ${INTAKE_PRESENTING_COMPLAINT_MAX} caracteres.`,
    };
  }
  const findings = text(formData, "findings");
  if (findings && findings.length > INTAKE_FINDINGS_MAX) {
    return {
      ok: false,
      error: `Los hallazgos no pueden superar los ${INTAKE_FINDINGS_MAX} caracteres.`,
    };
  }

  const temperature = boundedNumber(formData, "temperatureC", INTAKE_VITAL_BOUNDS.temperature_c, {
    integer: false,
    label: "Temperatura",
    unit: " °C",
  });
  if (!temperature.ok) return temperature;
  const heartRate = boundedNumber(formData, "heartRateBpm", INTAKE_VITAL_BOUNDS.heart_rate_bpm, {
    integer: true,
    label: "Frecuencia cardíaca",
    unit: " lpm",
  });
  if (!heartRate.ok) return heartRate;
  const respiratoryRate = boundedNumber(
    formData,
    "respiratoryRateRpm",
    INTAKE_VITAL_BOUNDS.respiratory_rate_rpm,
    { integer: true, label: "Frecuencia respiratoria", unit: " rpm" },
  );
  if (!respiratoryRate.ok) return respiratoryRate;
  const bodyCondition = boundedNumber(
    formData,
    "bodyConditionScore",
    INTAKE_VITAL_BOUNDS.body_condition_score,
    { integer: true, label: "Condición corporal", unit: "" },
  );
  if (!bodyCondition.ok) return bodyCondition;

  const hydration = oneOf(text(formData, "hydration"), INTAKE_HYDRATION_LEVELS);
  if (hydration === "invalid") return { ok: false, error: "Elegí un grado de hidratación válido." };
  const mucous = oneOf(text(formData, "mucousMembranes"), INTAKE_MUCOUS_MEMBRANES);
  if (mucous === "invalid") return { ok: false, error: "Elegí un color de mucosas válido." };

  const vitals: IntakeVitals = {
    ...(temperature.value !== undefined ? { temperature_c: temperature.value } : {}),
    ...(heartRate.value !== undefined ? { heart_rate_bpm: heartRate.value } : {}),
    ...(respiratoryRate.value !== undefined ? { respiratory_rate_rpm: respiratoryRate.value } : {}),
    ...(bodyCondition.value !== undefined ? { body_condition_score: bodyCondition.value } : {}),
    ...(hydration ? { hydration } : {}),
    ...(mucous ? { mucous_membranes: mucous } : {}),
  };

  const weightKg = parseWeightKg(formData);
  if (!weightKg.ok) return weightKg;

  const clientIdempotencyKey = parseClientIdempotencyKey(formData);
  if (!clientIdempotencyKey.ok) return clientIdempotencyKey;

  return {
    ok: true,
    value: {
      generalCondition,
      presentingComplaint,
      findings,
      vitals: Object.keys(vitals).length > 0 ? vitals : null,
      weightKg: weightKg.value,
      clientIdempotencyKey: clientIdempotencyKey.value,
    },
  };
}
