// The ENO diagnosis step's parser (PO S2) — shared by the web clinical record
// and the clinic panel, so both doors refuse the same things in the same words.

import { describe, expect, it } from "vitest";

import { notifiableDiagnosisOptions } from "@/lib/reference/notifiable-diseases";

import { parseDiseaseDiagnosisForm } from "./disease-diagnosis-form";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const OK = { diseaseCode: "leptospirosis", diagnosisDate: "2026-09-20", method: "clinico" };

describe("parseDiseaseDiagnosisForm", () => {
  it("a clinical diagnosis parses with no lab", () => {
    const r = parseDiseaseDiagnosisForm(form({ ...OK, labName: "ignored" }));
    expect(r).toMatchObject({
      ok: true,
      value: { diseaseCode: "leptospirosis", confirmedByLab: false, labName: null },
    });
  });

  it("a lab diagnosis requires the lab's name", () => {
    expect(parseDiseaseDiagnosisForm(form({ ...OK, method: "laboratorio" }))).toEqual({
      ok: false,
      error: "Para un diagnóstico de laboratorio indicá el nombre del laboratorio.",
    });
    const r = parseDiseaseDiagnosisForm(
      form({ ...OK, method: "laboratorio", labName: "INPPAZ", labReportReference: "R-1" }),
    );
    expect(r).toMatchObject({
      ok: true,
      value: { confirmedByLab: true, labName: "INPPAZ", labReportReference: "R-1" },
    });
  });

  it("refuses a disease outside the notifiable list", () => {
    expect(parseDiseaseDiagnosisForm(form({ ...OK, diseaseCode: "parvovirus" }))).toMatchObject({
      ok: false,
    });
    expect(parseDiseaseDiagnosisForm(form({ ...OK, diseaseCode: "toxoplasmosis" }))).toMatchObject({
      ok: false,
    });
  });

  it("refuses a missing date, a bad date and a missing method", () => {
    expect(parseDiseaseDiagnosisForm(form({ ...OK, diagnosisDate: "" })).ok).toBe(false);
    expect(parseDiseaseDiagnosisForm(form({ ...OK, diagnosisDate: "ayer" })).ok).toBe(false);
    expect(parseDiseaseDiagnosisForm(form({ ...OK, method: "" })).ok).toBe(false);
  });
});

describe("notifiableDiagnosisOptions", () => {
  it("a dog is offered rabies, leptospirosis and canine brucellosis, never parvovirus", () => {
    const codes = notifiableDiagnosisOptions("dog").map((o) => o.code);
    expect(codes).toEqual(
      expect.arrayContaining(["rabies_confirmed", "leptospirosis", "canine_brucellosis"]),
    );
    expect(codes).not.toContain("parvovirus");
    expect(codes).not.toContain("toxoplasmosis");
  });

  it("every option carries the legal window it opens", () => {
    for (const o of notifiableDiagnosisOptions(null)) expect(o.notifyHours).toBeGreaterThan(0);
  });
});
