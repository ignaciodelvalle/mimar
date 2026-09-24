// opened-reason-render — es-AR labels for structured case open reasons.
//
// This is what a funcionario reads. opened-reason-prose.ts is what gets stored.
//
// WHY A MAPPED RECORD AND NOT A SWITCH
// ------------------------------------
// `RENDERERS` is typed `{ [C in OpenedReasonCode]: Renderer<C> }`. Add a member
// to the union without adding a key here and `tsc` fails: "property X is
// missing in type RendererMap". That is writer #19's fence, and it fires at the
// TYPE level — no test has to cover the new code for it to work.
//
// A switch cannot do this, and the difference is not stylistic.
// `caseClosedReasonLabel` (opened-reason-display.ts) is a switch that returns
// `string` from every branch; a missing case just falls to `default` and
// returns the raw value. It compiles. It ships. It renders English. That is
// EXACTLY how "direct custody handoff to_role=owner" reached funcionarios for
// months — the failure was silent because nothing could make it loud.
// `assertNever` in a default branch does not help either: it only fires if the
// branch is reachable, and with every case returning a string, it never is.
//
// The mapped Record is categorically stronger: exhaustiveness is a property of
// the TYPE, checked at declaration, not a property of a code path someone has
// to remember to exercise.
//
// PRIVACY: renderers only ever receive parsed union params. The internal UUIDs
// that live in the audit prose (OpenedReasonAudit) are not in scope here — not
// by discipline, but structurally. A renderer cannot leak an id it has no way
// to name.

import { pluralizeEs } from "@/lib/utils/format";

import type { OpenedReason, OpenedReasonCode, OpenedReasonParams } from "./opened-reason";
import {
  BITE_SEVERITY_LABEL,
  BITE_VICTIM_LABEL,
  CHIP_REASON_LABEL,
  CUSTODY_HANDOFF_ROLE_LABEL,
  DISPUTE_RAISED_BY_ROLE_LABEL,
  INTAKE_REASON_LABEL,
  REPORTER_ROLE_LABEL,
  SEIZURE_MOTIVE_LABEL,
  TRANSFER_REASON_LABEL,
  WELFARE_KIND_LABEL,
  WELFARE_SEVERITY_LABEL,
  label,
} from "./opened-reason-labels";

type Renderer<C extends OpenedReasonCode> = (params: OpenedReasonParams<C>) => string;
type RendererMap = { [C in OpenedReasonCode]: Renderer<C> };

const RENDERERS: RendererMap = {
  adoption_listing_opened: () =>
    "Publicación en adopción abierta automáticamente: la mascota fue marcada como apta para adopción",

  adoption_application_submitted: () => "Postulación de adopción enviada",

  welfare_report_citizen: (p) =>
    `Denuncia de bienestar ${p.referenceCode} — tipo: ${label(WELFARE_KIND_LABEL, p.kind)}, gravedad: ${label(WELFARE_SEVERITY_LABEL, p.severity)}`,

  welfare_report_org: (p) =>
    `Denuncia de bienestar registrada por ${p.orgDisplayName} (${p.referenceCode})`,

  foster_placement_assigned: (p) =>
    `Tránsito asignado por ${p.actorOrgDisplayName}${
      p.expectedWeeks
        ? ` — duración estimada: ${p.expectedWeeks} ${pluralizeEs(p.expectedWeeks, "semana")}`
        : ""
    }`,

  // The volunteer and org ids are audit-only and not params — there is nothing
  // to strip here, which is the improvement over the regex layer.
  foster_proposal_sent: () => "Propuesta de tránsito enviada a una persona voluntaria",

  // No public token → the id is OMITTED, never replaced by the internal UUID
  // (spec R1#16). The UUID is not reachable from here anyway.
  pet_marked_lost: (p) => {
    const head = p.petPublicToken
      ? `Mascota ${p.petPublicToken} reportada como perdida por su dueño`
      : "Mascota reportada como perdida por su dueño";
    return p.ownerNote ? `${head} — ${p.ownerNote}` : head;
  },

  // reactivate-lost-search.ts already wrote es-AR prose, so it rendered
  // correctly BY ACCIDENT — via the free-text passthrough, with no rule at all.
  // Rendering from the code makes that deliberate, and drops the English "pet"
  // its prose still carries (spec R1: zero English tokens).
  lost_search_reactivated: (p) =>
    `Búsqueda reactivada por el dueño tras cierre automático por inactividad (mascota ${p.petPublicToken})`,

  decomiso_executed: (p) =>
    `Decomiso — motivo: ${label(SEIZURE_MOTIVE_LABEL, p.motive)}${
      p.judicialRef ? ` — ref. judicial: ${p.judicialRef}` : ""
    }`,

  decomiso_handoff_accepted: (p) =>
    `Traspaso de decomiso aceptado desde el caso ${p.sourceCasePublicCode}`,

  bite_reported_owner: (p) =>
    `Mordedura reportada por el dueño — víctima: ${label(BITE_VICTIM_LABEL, p.victimKind)}, gravedad: ${label(BITE_SEVERITY_LABEL, p.severity)}`,

  bite_reported_org: (p) =>
    `Mordedura reportada por ${p.orgDisplayName} (${label(REPORTER_ROLE_LABEL, p.reporterRole)}) — víctima: ${label(BITE_VICTIM_LABEL, p.victimKind)}, gravedad: ${label(BITE_SEVERITY_LABEL, p.severity)}`,

  // The change of legal responsible. This label is the whole reason the change
  // exists — it used to read "Apertura automática — direct custody handoff
  // to_role=owner".
  custody_handoff_direct: (p) =>
    `Traspaso directo de custodia — pasa a: ${label(CUSTODY_HANDOFF_ROLE_LABEL, p.toRole)}`,

  cross_org_transfer_proposed: (p) =>
    `Transferencia entre organizaciones propuesta — motivo: ${label(TRANSFER_REASON_LABEL, p.reason)}`,

  org_intake: (p) =>
    `Ingreso registrado por la organización — motivo: ${label(INTAKE_REASON_LABEL, p.intakeReason)}`,

  microchip_replaced: (p) =>
    `Reemplazo de microchip — motivo: ${label(CHIP_REASON_LABEL, p.reason)}${
      p.duplicateDetected ? " — se detectó otra mascota con el mismo chip" : ""
    }`,

  custody_dispute_raised: (p) =>
    `Disputa de custodia iniciada por ${label(DISPUTE_RAISED_BY_ROLE_LABEL, p.raisedByRole)} sobre la mascota`,

  // The `manual [code]:` prefix is a machine dedupe key, not prose to
  // eliminate (spec R1#17), so it is preserved as a distinct, deliberate
  // grammar — bracketed disease code and all.
  outbreak_investigation_manual: (p) =>
    p.note
      ? `Apertura manual [${p.diseaseCode}] — ${p.note}`
      : `Apertura manual [${p.diseaseCode}]`,

  // rehome-by-titular. Names the org the titular asked, nothing else.
  rehome_requested: (p) => `Solicitud de nuevo hogar enviada por el titular a ${p.orgDisplayName}`,
};

/** Render a structured open reason as the es-AR label a funcionario reads. */
export function renderOpenedReason(reason: OpenedReason): string {
  const { code, ...params } = reason;
  const renderer = RENDERERS[code] as Renderer<typeof code>;
  return renderer(params as OpenedReasonParams<typeof code>);
}
