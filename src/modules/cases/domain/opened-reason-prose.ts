// opened-reason-prose — the AUDIT prose written to `cases.opened_reason`.
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │ These strings are NOT UI. Nobody reads them. Do not "fix" the English,    │
// │ the `key=value` pairs, or the UUIDs — that is what they are supposed to   │
// │ look like. The es-AR a funcionario reads is opened-reason-render.ts.      │
// └───────────────────────────────────────────────────────────────────────────┘
//
// WHAT THIS IS
// ------------
// Every template here is BYTE-IDENTICAL to what its writer emitted before the
// structured cutover. The 18 templates did not disappear in this change — they
// RELOCATED, from 18 scattered writers into this one file, and lost their job
// as the display source. That relocation is the point: the English string is no
// longer what anyone reads, but it is still exactly what gets stored.
//
// WHY BYTE-IDENTICAL (see opened-reason-prose.test.ts, which pins all 18 — plus
// the one post-cutover writer, rehome_requested, whose prose is its own label)
// ----------------------------------------------------------------------
//  1. `opened_reason` is a LIVE SQL QUERY KEY: surveillance-repository.ts
//     dedupes open outbreak investigations with
//     `opened_reason LIKE 'manual [{diseaseCode}]:%'`. Byte-identical prose
//     means that dedupe needs zero change and matches both cohorts — pre- and
//     post-cutover rows alike. Drift breaks it SILENTLY.
//  2. Rollback is free: revert the structured code and every row, new ones
//     included, still renders through the frozen regex layer.
//  3. `cases_opened_reason_min_length` (>= 10) holds by construction.
//
// The mapped Record (not a switch) makes a new union member a `tsc` error here
// — same mechanism as the renderer. See opened-reason-render.ts for why a
// switch would not.

import type { OpenedReason, OpenedReasonAudit, OpenedReasonCode } from "./opened-reason";
import type { OpenedReasonParams } from "./opened-reason";

type ProseTemplate<C extends OpenedReasonCode> = (
  params: OpenedReasonParams<C>,
  audit: OpenedReasonAudit,
) => string;

type ProseMap = { [C in OpenedReasonCode]: ProseTemplate<C> };

const PROSE: ProseMap = {
  // adoption-repository.ts:297
  adoption_listing_opened: () => "auto: adoption listing opened — pet marked eligible for adoption",

  // adoption-repository.ts:565
  adoption_application_submitted: () => "auto: adoption application submitted",

  // create-welfare-report.ts:197
  welfare_report_citizen: (p) =>
    `Welfare denuncia ${p.referenceCode} — kind=${p.kind}, severity=${p.severity}`,

  // create-org-welfare-report.ts:199
  welfare_report_org: (p) =>
    `auto: org-side welfare report by ${p.orgDisplayName} (${p.referenceCode})`,

  // foster-repository.ts:798
  foster_placement_assigned: (p) =>
    `Foster placement assigned by ${p.actorOrgDisplayName}${
      p.expectedWeeks ? ` — expected ${p.expectedWeeks} weeks` : ""
    }`,

  // foster-repository.ts:922. The volunteer + org UUIDs are audit-only: they
  // are in this string (as they always have been) but not in params, so the
  // renderer cannot reach them.
  foster_proposal_sent: (_p, a) =>
    `Foster proposal to volunteer ${a.volunteerUserId} by org ${a.orgId}`,

  // set-pet-lost-use-case.ts:205 — `petPublicToken || petId`: the internal pet
  // UUID is the fallback in AUDIT prose only. The renderer omits the id
  // entirely instead (never shows a UUID).
  pet_marked_lost: (p, a) =>
    `Pet ${p.petPublicToken || a.petId} marked as lost by owner${
      p.ownerNote ? ` — ${p.ownerNote}` : ""
    }`,

  // reactivate-lost-search.ts:73 — the one writer that already spoke es-AR.
  // Its prose is preserved verbatim like every other: this file is audit, and
  // the renderer produces this writer's label independently.
  lost_search_reactivated: (p) =>
    `Búsqueda reactivada por el dueño tras cierre automático por inactividad (pet ${p.petPublicToken})`,

  // execute-decomiso.ts:204
  decomiso_executed: (p) =>
    `auto: decomiso motivo=${p.motive} judicial_ref=${p.judicialRef ?? "sin_ref"}`,

  // accept-decomiso-handoff.ts:253
  decomiso_handoff_accepted: (p) =>
    `auto: decomiso handoff aceptado desde caso ${p.sourceCasePublicCode}`,

  // report-bite.ts:123
  bite_reported_owner: (p) =>
    `Bite incident reported by owner — victim=${p.victimKind}, severity=${p.severity}`,

  // report-bite-from-org.ts:147
  bite_reported_org: (p) =>
    `Bite incident reported by ${p.orgDisplayName} (${p.reporterRole}) — victim=${p.victimKind}, severity=${p.severity}`,

  // transfer-custody.ts:155 — the writer whose missing regex rule started all
  // of this. The prose stays exactly as it was; it just stopped being read.
  custody_handoff_direct: (p) => `auto: direct custody handoff to_role=${p.toRole}`,

  // propose-cross-org-transfer.ts:137
  cross_org_transfer_proposed: (p) => `auto: cross-org transfer proposed reason=${p.reason}`,

  // create-intake.ts:439
  org_intake: (p) => `auto: org intake reason=${p.intakeReason}`,

  // replace-microchip.ts:203,212 — `secondaryNote`. The UUID is audit-only;
  // params carry only the FACT (`duplicateDetected`).
  microchip_replaced: (p, a) =>
    `auto: microchip_replaced reason=${p.reason}${
      a.secondaryPetId ? ` secondaryPetId=${a.secondaryPetId}` : ""
    }`,

  // submit-claim-dispute.ts:105. The writer hardcodes `owner` today; the
  // template takes the role so the other three CHECK-legal roles produce
  // consistent prose if a writer ever raises one.
  custody_dispute_raised: (p) => `Custody dispute raised on pet — raised_by_role=${p.raisedByRole}`,

  // outbreak-investigation.ts:161,177 — DEDUPE CONTRACT.
  // `manual [{code}]:` is matched as a SQL LIKE prefix in
  // surveillance-repository.ts. The prefix, the brackets, the colon and the
  // single space are load-bearing. Do not touch this line.
  outbreak_investigation_manual: (p) => `manual [${p.diseaseCode}]: ${p.note}`,

  // rehome-by-titular (2026-08) — a writer born AFTER the cutover, so there is
  // no legacy prose to preserve and no regex rule in the frozen layer. The
  // prose is therefore the es-AR label itself: a rollback renders this row
  // through the passthrough and a reader sees the same text either way. Same
  // posture as lost_search_reactivated, the one pre-cutover writer in es-AR.
  rehome_requested: (p) => `Solicitud de nuevo hogar enviada por el titular a ${p.orgDisplayName}`,
};

/**
 * Render the audit prose for `cases.opened_reason` — byte-identical to what the
 * writer emitted before the structured cutover.
 *
 * @param reason the structured reason (code + params)
 * @param audit internal ids that belong in prose but never in params
 *              (see OpenedReasonAudit). Omit for the 16 codes that need none.
 */
export function openedReasonProse(reason: OpenedReason, audit: OpenedReasonAudit = {}): string {
  const { code, ...params } = reason;
  const template = PROSE[code] as ProseTemplate<typeof code>;
  return template(params as OpenedReasonParams<typeof code>, audit);
}
