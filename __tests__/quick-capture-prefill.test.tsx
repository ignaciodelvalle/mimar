/**
 * A11 — Quick-capture prefill tests.
 *
 * Verifies that the 4 forms that previously opened empty when reached via
 * intent / quick-capture now pre-fill correctly when a `defaults` prop is
 * supplied (same pattern as DewormingForm, VaccinationForm, WeightForm, etc.).
 *
 * Pattern: renderToStaticMarkup (repo convention — no jsdom required).
 * Each test passes a `defaults` object and asserts the captured value appears
 * in the rendered HTML as a `value="…"` attribute on the relevant input.
 *
 * Forms covered:
 *   1. MedicationEndForm  — occurredAt + notes
 *   2. BiteForm           — occurredAt
 *   3. SymptomForm        — freeText + onsetAt
 *   4. ClinicalInfoForm   — occurredAt + notes
 */

import { todayIsoInAr } from "@/lib/utils/format";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared mocks required by all forms
// ---------------------------------------------------------------------------

// useIdempotencyKey — returns a stable key for SSR
vi.mock("@/lib/ui/use-idempotency-key", () => ({
  useIdempotencyKey: () => ({ key: "test-idempotency-key" }),
}));

// useFormErrorFocus — no-op ref in static rendering
vi.mock("@/lib/ui/use-form-error-focus", () => ({
  useFormErrorFocus: () => ({ current: null }),
}));

// AttachmentField — empty stub (avoids filesystem / icon side-effects)
vi.mock("@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/AttachmentField", () => ({
  AttachmentField: () => React.createElement("div", { "data-testid": "attachment-field" }),
}));

// LocationFields — empty stub
vi.mock("@/components/LocationFields", () => ({
  LocationFields: () => React.createElement("div", { "data-testid": "location-fields" }),
}));

// Icon — empty stub
vi.mock("@/components/Icon", () => ({
  Icon: () => React.createElement("span", { "data-testid": "icon" }),
}));

// ---------------------------------------------------------------------------
// MedicationEndForm — mock drugs lookup not needed; no drug catalog here
// ---------------------------------------------------------------------------

describe("MedicationEndForm — captura-rápida prefill (A11)", () => {
  it("prefills occurredAt from defaults", async () => {
    const { MedicationEndForm } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/medicacion-fin/MedicationEndForm"
    );

    const action = async (_: unknown, __: FormData) => ({ error: null });
    const openMeds = [{ id: "med-1", drugName: "Amoxicilina", startedDate: "01/06/2026" }];

    const html = renderToStaticMarkup(
      React.createElement(MedicationEndForm, {
        action,
        openMedications: openMeds,
        defaults: { occurredAt: "2026-06-20", notes: null },
      }),
    );

    expect(html).toContain('value="2026-06-20"');
  });

  it("prefills notes from defaults", async () => {
    const { MedicationEndForm } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/medicacion-fin/MedicationEndForm"
    );

    const action = async (_: unknown, __: FormData) => ({ error: null });
    const openMeds = [{ id: "med-1", drugName: "Amoxicilina", startedDate: "01/06/2026" }];

    const html = renderToStaticMarkup(
      React.createElement(MedicationEndForm, {
        action,
        openMedications: openMeds,
        defaults: { occurredAt: null, notes: "Tratamiento completado" },
      }),
    );

    expect(html).toContain("Tratamiento completado");
  });

  it("falls back to today when occurredAt default is null", async () => {
    const { MedicationEndForm } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/medicacion-fin/MedicationEndForm"
    );

    const today = todayIsoInAr();
    const action = async (_: unknown, __: FormData) => ({ error: null });
    const openMeds = [{ id: "med-1", drugName: "Amoxicilina", startedDate: "01/06/2026" }];

    const html = renderToStaticMarkup(
      React.createElement(MedicationEndForm, {
        action,
        openMedications: openMeds,
        defaults: { occurredAt: null, notes: null },
      }),
    );

    expect(html).toContain(`value="${today}"`);
  });
});

// ---------------------------------------------------------------------------
// BiteForm — occurredAt prefill
// ---------------------------------------------------------------------------

describe("BiteForm — captura-rápida prefill (A11)", () => {
  it("prefills occurredAt from defaults", async () => {
    const { BiteForm } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/mordedura/BiteForm"
    );

    const action = async (_: unknown, __: FormData) => ({ error: null });

    const html = renderToStaticMarkup(
      React.createElement(BiteForm, {
        action,
        petName: "Fido",
        defaults: { occurredAt: "2026-06-15" },
      }),
    );

    expect(html).toContain('value="2026-06-15"');
  });

  it("falls back to today when occurredAt default is null", async () => {
    const { BiteForm } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/mordedura/BiteForm"
    );

    const today = todayIsoInAr();
    const action = async (_: unknown, __: FormData) => ({ error: null });

    const html = renderToStaticMarkup(
      React.createElement(BiteForm, {
        action,
        petName: "Fido",
        defaults: { occurredAt: null },
      }),
    );

    expect(html).toContain(`value="${today}"`);
  });
});

// ---------------------------------------------------------------------------
// SymptomForm — freeText + onsetAt prefill
// ---------------------------------------------------------------------------

describe("SymptomForm — captura-rápida prefill (A11)", () => {
  it("prefills freeText from defaults", async () => {
    const { SymptomForm } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/sintoma/SymptomForm"
    );

    const action = async (_: unknown, __: FormData) => ({ error: null });

    const html = renderToStaticMarkup(
      React.createElement(SymptomForm, {
        action,
        petName: "Fido",
        defaults: { freeText: "vomita y no come", onsetAt: null },
      }),
    );

    expect(html).toContain("vomita y no come");
  });

  it("prefills onsetAt from defaults", async () => {
    const { SymptomForm } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/sintoma/SymptomForm"
    );

    const action = async (_: unknown, __: FormData) => ({ error: null });

    const html = renderToStaticMarkup(
      React.createElement(SymptomForm, {
        action,
        petName: "Fido",
        defaults: { freeText: null, onsetAt: "2026-06-18" },
      }),
    );

    expect(html).toContain('value="2026-06-18"');
  });

  it("renders empty onsetAt when defaults are null", async () => {
    const { SymptomForm } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/sintoma/SymptomForm"
    );

    const action = async (_: unknown, __: FormData) => ({ error: null });

    const html = renderToStaticMarkup(
      React.createElement(SymptomForm, {
        action,
        petName: "Fido",
        defaults: { freeText: null, onsetAt: null },
      }),
    );

    // onsetAt input should have an empty value when default is null.
    // We check the onsetAt input renders with value="" (not a date string).
    expect(html).toContain('name="onsetAt" value=""');
  });
});

// ---------------------------------------------------------------------------
// ClinicalInfoForm — occurredAt + notes prefill
// ---------------------------------------------------------------------------

describe("ClinicalInfoForm — captura-rápida prefill (A11)", () => {
  it("prefills occurredAt from defaults", async () => {
    const { ClinicalInfoForm } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/clinico/ClinicalInfoForm"
    );

    const action = async (_: unknown, __: FormData) => ({ error: null });

    const html = renderToStaticMarkup(
      React.createElement(ClinicalInfoForm, {
        action,
        defaults: { occurredAt: "2026-06-22", notes: null },
      }),
    );

    expect(html).toContain('value="2026-06-22"');
  });

  it("prefills notes from defaults", async () => {
    const { ClinicalInfoForm } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/clinico/ClinicalInfoForm"
    );

    const action = async (_: unknown, __: FormData) => ({ error: null });

    const html = renderToStaticMarkup(
      React.createElement(ClinicalInfoForm, {
        action,
        defaults: { occurredAt: null, notes: "Análisis para control anual" },
      }),
    );

    expect(html).toContain("Análisis para control anual");
  });

  it("falls back to today when occurredAt default is null", async () => {
    const { ClinicalInfoForm } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/clinico/ClinicalInfoForm"
    );

    const today = todayIsoInAr();
    const action = async (_: unknown, __: FormData) => ({ error: null });

    const html = renderToStaticMarkup(
      React.createElement(ClinicalInfoForm, {
        action,
        defaults: { occurredAt: null, notes: null },
      }),
    );

    expect(html).toContain(`value="${today}"`);
  });
});
