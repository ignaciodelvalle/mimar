// Safe, curated projection of approval_requests.payload for operator display.
//
// WHY: the govt review surface (/gob/cola/[publicToken]) must NEVER render the
// raw payload via JSON.stringify — that is the "never return raw event/request
// payloads to the client" rule (AGENTS.md) and can leak fields the operator has
// no need to see. This module projects ONLY the explicitly-known fields for each
// approval type into localized (es-AR) label/value pairs. Unknown types and
// unknown keys are dropped, not dumped — an additive-by-allowlist projection,
// the same discipline as the public case timeline's field render.
//
// The field set mirrors lib/infra/approval-payloads.ts (the Zod schemas that
// validate these payloads at the insert site). Keep the two in sync when a new
// approval type or field lands.

import type { ApprovalRequestType } from "@/db/schema";

export type ApprovalPayloadRow = { label: string; value: string };

const ORG_TYPE_LABELS: Record<string, string> = {
  clinic: "Clínica veterinaria",
  shelter: "Refugio",
  rescue_network: "Red de rescate",
  sanitary_authority: "Autoridad sanitaria",
  other: "Otra",
};

// Safe accessor: payload is jsonb (unknown at the type level).
function field(payload: unknown, key: string): unknown {
  if (payload && typeof payload === "object" && key in payload) {
    return (payload as Record<string, unknown>)[key];
  }
  return undefined;
}

function asDisplayString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Objects/arrays are intentionally NOT stringified — no raw payload dumps.
  return null;
}

function push(rows: ApprovalPayloadRow[], label: string, value: unknown): void {
  const display = asDisplayString(value);
  if (display !== null) rows.push({ label, value: display });
}

/**
 * Projects a validated approval_requests.payload into a curated list of
 * label/value display rows. Returns an empty array for unknown types or when no
 * known field is present — the caller renders a neutral empty state, never the
 * raw payload.
 */
export function summarizeApprovalPayload(
  type: ApprovalRequestType,
  payload: unknown,
): ApprovalPayloadRow[] {
  const rows: ApprovalPayloadRow[] = [];

  switch (type) {
    case "role_upgrade_vet": {
      push(rows, "Matrícula", field(payload, "matricula_number"));
      push(rows, "Jurisdicción de matrícula", field(payload, "matricula_jurisdiccion"));
      push(rows, "Especialidad", field(payload, "especialidad"));
      push(rows, "Años de experiencia", field(payload, "anos_experiencia"));
      break;
    }
    case "organization_verification": {
      const orgType = field(payload, "org_type");
      if (typeof orgType === "string") {
        push(rows, "Tipo de organización", ORG_TYPE_LABELS[orgType] ?? orgType);
      }
      push(rows, "CUIT", field(payload, "cuit"));
      push(rows, "Personería jurídica", field(payload, "personeria_juridica_number"));
      push(rows, "Documentación adicional", field(payload, "additional_documents_summary"));
      break;
    }
    default:
      // Unknown/future type: render nothing structured. Never dump the payload.
      break;
  }

  return rows;
}
