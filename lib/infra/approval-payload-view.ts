// Pure helper: given an approval request type + raw jsonb payload, returns an
// ordered list of { label, value } rows for the operator review surface.
//
// Rules:
// - All labels are es-AR.
// - Only fields the operator legitimately needs to review are included.
// - No raw identity blobs (DNI, full names); matricula/jurisdiccion/registry
//   fields are operator-facing legitimately.
// - Unknown / missing payloads return [] (caller renders "Sin datos estructurados").
// - All field reads guard against missing/garbage input (payload is untrusted jsonb).

export type PayloadRow = {
  label: string;
  value: string;
};

/** Fields rendered for a `role_upgrade_vet` request. */
function vetRows(payload: Record<string, unknown>): PayloadRow[] {
  const rows: PayloadRow[] = [];

  const matricula = payload.matricula_number ?? payload.matriculaNumber;
  if (typeof matricula === "string" && matricula.trim()) {
    rows.push({ label: "N° de matrícula", value: matricula.trim() });
  }

  const jurisdiccion = payload.jurisdiccion ?? payload.jurisdiction;
  if (typeof jurisdiccion === "string" && jurisdiccion.trim()) {
    rows.push({ label: "Jurisdicción", value: jurisdiccion.trim() });
  }

  const evidence = payload.evidence_url ?? payload.evidenceUrl ?? payload.evidence;
  if (typeof evidence === "string" && evidence.trim()) {
    rows.push({ label: "Evidencia adjunta", value: evidence.trim() });
  }

  const college = payload.colegio ?? payload.college;
  if (typeof college === "string" && college.trim()) {
    rows.push({ label: "Colegio profesional", value: college.trim() });
  }

  const specialty = payload.especialidad ?? payload.specialty;
  if (typeof specialty === "string" && specialty.trim()) {
    rows.push({ label: "Especialidad", value: specialty.trim() });
  }

  return rows;
}

/** Fields rendered for an `organization_verification` request. */
function orgVerificationRows(payload: Record<string, unknown>): PayloadRow[] {
  const rows: PayloadRow[] = [];

  const cuit = payload.cuit;
  if (typeof cuit === "string" && cuit.trim()) {
    rows.push({ label: "CUIT", value: cuit.trim() });
  }

  const legalName = payload.legal_name ?? payload.legalName;
  if (typeof legalName === "string" && legalName.trim()) {
    rows.push({ label: "Razón social", value: legalName.trim() });
  }

  const orgType = payload.org_type ?? payload.orgType;
  if (typeof orgType === "string" && orgType.trim()) {
    rows.push({ label: "Tipo de organización", value: orgType.trim() });
  }

  const address = payload.address ?? payload.domicilio;
  if (typeof address === "string" && address.trim()) {
    rows.push({ label: "Domicilio", value: address.trim() });
  }

  const phone = payload.phone ?? payload.telefono;
  if (typeof phone === "string" && phone.trim()) {
    rows.push({ label: "Teléfono", value: phone.trim() });
  }

  const notes = payload.notes ?? payload.notas;
  if (typeof notes === "string" && notes.trim()) {
    rows.push({ label: "Notas", value: notes.trim() });
  }

  return rows;
}

/** Fields rendered for a `service_dog_credential_verification` request.
 *  The detailed serviceDogContext block on the page already shows pet + RUPGA
 *  fields. This helper renders any additional payload-level fields not already
 *  in that block (e.g. applicant notes, self-declared training info). */
function serviceDogRows(payload: Record<string, unknown>): PayloadRow[] {
  const rows: PayloadRow[] = [];

  const notes = payload.notes ?? payload.notas;
  if (typeof notes === "string" && notes.trim()) {
    rows.push({ label: "Notas del solicitante", value: notes.trim() });
  }

  const trainingCenter = payload.training_center ?? payload.trainingCenter;
  if (typeof trainingCenter === "string" && trainingCenter.trim()) {
    rows.push({ label: "Centro de entrenamiento (declarado)", value: trainingCenter.trim() });
  }

  const rupga = payload.rupga_credential ?? payload.rupgaCredential;
  if (typeof rupga === "string" && rupga.trim()) {
    rows.push({ label: "N° RUPGA (declarado)", value: rupga.trim() });
  }

  return rows;
}

/**
 * Given an approval request `type` and raw `payload` (jsonb → unknown), returns
 * an ordered list of es-AR label/value rows for operator display.
 *
 * Returns [] when there is nothing to show (unknown type, null/empty payload,
 * no recognised fields). Callers should render "Sin datos estructurados" in
 * that case instead of falling back to raw JSON.
 */
export function buildPayloadRows(type: string, payload: unknown): PayloadRow[] {
  if (payload === null || payload === undefined) return [];
  if (typeof payload !== "object" || Array.isArray(payload)) return [];

  const p = payload as Record<string, unknown>;

  switch (type) {
    case "role_upgrade_vet":
      return vetRows(p);
    case "organization_verification":
      return orgVerificationRows(p);
    case "service_dog_credential_verification":
      return serviceDogRows(p);
    default:
      return [];
  }
}
