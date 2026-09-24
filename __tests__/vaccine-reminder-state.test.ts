// Pure unit tests for lib/vaccine-reminder-state.ts.
// No DB access. setup.ts only sets env vars — safe to run here.
import { describe, expect, test } from "vitest";

import {
  PROXIMOS_HORIZON_DAYS,
  countProximosReminders,
  getReminderVariant,
  getReportableVaccines,
  isReminderProximo,
  isVaccineReportable,
  splitProximosReminders,
} from "@/lib/domain/vaccine-reminder-state";

// ---------------------------------------------------------------------------
// getReminderVariant
// ---------------------------------------------------------------------------

describe("getReminderVariant", () => {
  // upcoming — 8+ días
  test("14 días → upcoming", () => {
    expect(getReminderVariant(14, false)).toBe("upcoming");
  });

  test("8 días → upcoming (borde techo de due_soon)", () => {
    expect(getReminderVariant(8, false)).toBe("upcoming");
  });

  // due_soon — 1..7 días
  test("7 días → due_soon", () => {
    expect(getReminderVariant(7, false)).toBe("due_soon");
  });

  test("1 día → due_soon (borde inferior)", () => {
    expect(getReminderVariant(1, false)).toBe("due_soon");
  });

  // overdue — 0..-30 días
  test("0 días → overdue (vence hoy = vencida semánticamente)", () => {
    expect(getReminderVariant(0, false)).toBe("overdue");
  });

  test("-1 día → overdue", () => {
    expect(getReminderVariant(-1, false)).toBe("overdue");
  });

  test("-30 días → overdue (borde: el umbral crítico es >30, no >=30)", () => {
    expect(getReminderVariant(-30, false)).toBe("overdue");
  });

  // overdue_critical — >30 días vencida + isReportable
  test("-31 días + reportable → overdue_critical", () => {
    expect(getReminderVariant(-31, true)).toBe("overdue_critical");
  });

  test("-31 días + no reportable → overdue (sin lista reportable, no sube a critical)", () => {
    expect(getReminderVariant(-31, false)).toBe("overdue");
  });

  test("-200 días + reportable → overdue_critical", () => {
    expect(getReminderVariant(-200, true)).toBe("overdue_critical");
  });
});

// ---------------------------------------------------------------------------
// getReportableVaccines
// ---------------------------------------------------------------------------

describe("getReportableVaccines", () => {
  test("dog / CABA → contiene rabia, parvo, distemper", () => {
    const result = getReportableVaccines("dog", "CABA");
    expect(result).toContain("rabia");
    expect(result).toContain("parvo");
    expect(result).toContain("distemper");
  });

  test("cat / CABA → contiene rabia, panleucopenia", () => {
    const result = getReportableVaccines("cat", "CABA");
    expect(result).toContain("rabia");
    expect(result).toContain("panleucopenia");
  });

  test("fish / CABA → array vacío (especie sin lista reportable)", () => {
    const result = getReportableVaccines("fish", "CABA");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isVaccineReportable
// ---------------------------------------------------------------------------

describe("isVaccineReportable", () => {
  test('"Antirrábica" + dog → true (substring match, case-insensitive)', () => {
    expect(isVaccineReportable("Antirrábica", "dog", "CABA")).toBe(true);
  });

  test('"Rabia anual" + dog → true', () => {
    expect(isVaccineReportable("Rabia anual", "dog", "CABA")).toBe(true);
  });

  test('"Bordetella" + dog → false (no está en la lista reportable del perro)', () => {
    expect(isVaccineReportable("Bordetella", "dog", "CABA")).toBe(false);
  });

  test('"rabia" + fish → false (especie sin lista reportable)', () => {
    expect(isVaccineReportable("rabia", "fish", "CABA")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isReminderProximo / countProximosReminders (#45 — vencimientos próximos)
// ---------------------------------------------------------------------------

describe("isReminderProximo", () => {
  test("default horizon is 60 días", () => {
    expect(PROXIMOS_HORIZON_DAYS).toBe(60);
  });

  test("vencido (daysUntilDue negativo) → próximo (lo más urgente)", () => {
    expect(isReminderProximo(-5)).toBe(true);
  });

  test("vence hoy (0) → próximo", () => {
    expect(isReminderProximo(0)).toBe(true);
  });

  test("borde del horizonte (60) → próximo", () => {
    expect(isReminderProximo(60)).toBe(true);
  });

  test("apenas fuera del horizonte (61) → NO próximo", () => {
    expect(isReminderProximo(61)).toBe(false);
  });

  test("dosis anual recién registrada (363) → NO próximo (el bug del QA §2)", () => {
    expect(isReminderProximo(363)).toBe(false);
  });
});

describe("countProximosReminders", () => {
  test("cuenta sólo los que están dentro del horizonte; excluye los lejanos", () => {
    const reminders = [
      { daysUntilDue: -10 }, // vencido → cuenta
      { daysUntilDue: 5 }, // pronto → cuenta
      { daysUntilDue: 60 }, // borde → cuenta
      { daysUntilDue: 120 }, // lejano → no
      { daysUntilDue: 363 }, // dosis anual → no
    ];
    expect(countProximosReminders(reminders)).toBe(3);
  });

  test("lista vacía → 0", () => {
    expect(countProximosReminders([])).toBe(0);
  });

  test("horizonte configurable", () => {
    const reminders = [{ daysUntilDue: 75 }, { daysUntilDue: 100 }];
    expect(countProximosReminders(reminders, 90)).toBe(1);
  });
});

// D-11 (Lote D) — el rollup de /mis-mascotas plegaba "ya vencida" y "vence
// dentro de 60 días" en un solo número, así que dos dueños en situaciones
// opuestas leían la misma cifra: uno en incumplimiento hoy, otro sin nada que
// hacer hasta el mes que viene. El landing por-mascota siempre las distinguió.
describe("splitProximosReminders", () => {
  const rem = (daysUntilDue: number) => ({ daysUntilDue });

  test("separa vencidas de por-vencer sobre el mismo conjunto que cuenta el total", () => {
    const reminders = [rem(-40), rem(-1), rem(0), rem(5), rem(59), rem(120)];
    const split = splitProximosReminders(reminders);
    // -40, -1 y 0 ya vencieron (0 = vence hoy = vencida, según getReminderVariant).
    expect(split.vencidas).toBe(3);
    // 5 y 59 están dentro del horizonte; 120 queda fuera y no cuenta.
    expect(split.porVencer).toBe(2);
    expect(split.total).toBe(5);
  });

  test("el total coincide SIEMPRE con countProximosReminders — un solo bucket, dos lentes", () => {
    const reminders = [rem(-90), rem(-3), rem(2), rem(30), rem(61), rem(364)];
    expect(splitProximosReminders(reminders).total).toBe(countProximosReminders(reminders));
  });

  test("respeta un horizonte personalizado, igual que el contador", () => {
    const reminders = [rem(-5), rem(20), rem(80)];
    const split = splitProximosReminders(reminders, 90);
    expect(split).toEqual({ vencidas: 1, porVencer: 2, total: 3 });
  });

  test("una vacuna vencida hace más de 30 días sigue siendo vencida (overdue_critical no es otra cosa)", () => {
    expect(splitProximosReminders([rem(-200)])).toEqual({
      vencidas: 1,
      porVencer: 0,
      total: 0 + 1,
    });
  });

  test("sin recordatorios devuelve ceros, no nulls", () => {
    expect(splitProximosReminders([])).toEqual({ vencidas: 0, porVencer: 0, total: 0 });
  });
});
