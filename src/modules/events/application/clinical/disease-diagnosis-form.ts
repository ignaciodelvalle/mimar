// The ENO diagnosis step's fields, parsed ONCE for both doors (PO S2,
// 2026-09-26): the web clinical record (recordDiseaseDiagnosisAction) and the
// clinic panel's "Atender" (atenderDiseaseDiagnosisAction). Same fields, same
// refusals, same words.
//
//   diseaseCode        — a catalog disease that opens an ENO notice
//   diagnosisDate      — "YYYY-MM-DD"; the legal clock starts here (PO S5)
//   method             — "clinico" | "laboratorio"; laboratorio = confirmed by
//                        lab, and then the lab's name is required
//   labName, labReportReference, notes — optional text

import { isNotifiableDiagnosisCode } from "@/lib/reference/notifiable-diseases";
import { parseDateInput } from "@/lib/utils/format";

export type DiseaseDiagnosisFields = {
  diseaseCode: string;
  diagnosisDate: Date;
  confirmedByLab: boolean;
  labName: string | null;
  labReportReference: string | null;
  notes: string | null;
};

export type DiseaseDiagnosisParse =
  | { ok: true; value: DiseaseDiagnosisFields }
  | { ok: false; error: string };

function text(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

export function parseDiseaseDiagnosisForm(formData: FormData): DiseaseDiagnosisParse {
  const diseaseCode = text(formData, "diseaseCode");
  if (!diseaseCode) return { ok: false, error: "Elegí la enfermedad diagnosticada." };
  if (!isNotifiableDiagnosisCode(diseaseCode)) {
    return { ok: false, error: "Esa enfermedad no es de notificación obligatoria." };
  }

  const dateRaw = text(formData, "diagnosisDate");
  if (!dateRaw) return { ok: false, error: "Falta la fecha del diagnóstico." };
  const diagnosisDate = parseDateInput(dateRaw);
  if (!diagnosisDate) return { ok: false, error: "Fecha de diagnóstico inválida." };

  const method = text(formData, "method");
  if (method !== "clinico" && method !== "laboratorio") {
    return { ok: false, error: "Indicá si el diagnóstico es clínico o de laboratorio." };
  }
  const confirmedByLab = method === "laboratorio";
  const labName = text(formData, "labName");
  if (confirmedByLab && !labName) {
    return {
      ok: false,
      error: "Para un diagnóstico de laboratorio indicá el nombre del laboratorio.",
    };
  }

  return {
    ok: true,
    value: {
      diseaseCode,
      diagnosisDate,
      confirmedByLab,
      labName: confirmedByLab ? labName : null,
      labReportReference: confirmedByLab ? text(formData, "labReportReference") : null,
      notes: text(formData, "notes"),
    },
  };
}
