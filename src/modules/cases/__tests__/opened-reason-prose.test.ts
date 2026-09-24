// opened-reason-prose — BYTE-EQUALITY GATE.
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │ This is the highest-consequence test in the structured-open-reason work.  │
// │ Read this before changing an expected string below.                       │
// └───────────────────────────────────────────────────────────────────────────┘
//
// The dual-write keeps populating `cases.opened_reason` with the SAME BYTES the
// 18 pre-cutover writers emit today (the 19th, rehome_requested, was born after
// the cutover and has no legacy prose). Not approximately — exactly. Three things depend on it,
// and only the first one fails loudly:
//
//  1. `opened_reason` IS A LIVE SQL QUERY KEY. surveillance-repository.ts
//     (findOpenInvestigationsForDisease) runs
//         opened_reason LIKE 'manual [{diseaseCode}]:%'
//     to dedupe open outbreak investigations per disease per jurisdiction. Drift
//     one byte in the outbreak template and the dedupe silently stops matching:
//     duplicate open investigations, NO compile-time signal, NO test failure
//     anywhere else. That is why this test exists and why it is written first.
//  2. Rollback. Post-cutover prose still matches the frozen regexes, so
//     reverting the code renders every row correctly — including new ones.
//  3. `cases_opened_reason_min_length` (>= 10) holds by construction.
//
// Each expected string below is COPIED FROM THE WRITER'S SOURCE, not from the
// es-AR translation. If one looks wrong or ugly — English, raw `key=value`,
// a UUID — that is correct. This column is audit, not UI. The es-AR a
// funcionario reads is opened-reason-render.ts's job.

import { describe, expect, it } from "vitest";
import { OPENED_REASON_CODES, type OpenedReason } from "../domain/opened-reason";
import { openedReasonProse } from "../domain/opened-reason-prose";

const VOLUNTEER_ID = "3f1a9c2e-1111-4222-8333-444455556666";
const ORG_ID = "7a2b4d6f-8888-4999-8aaa-bbbbccccdddd";
const PET_ID = "c1d2e3f4-5555-4666-8777-888899990000";
const SECONDARY_PET_ID = "d4e5f6a7-2222-4333-8444-555566667777";

// code → [OpenedReason, audit, exact prose the writer emits TODAY]
const CASES: Array<[OpenedReason, Parameters<typeof openedReasonProse>[1], string]> = [
  // adoption-repository.ts:297
  [
    { code: "adoption_listing_opened" },
    undefined,
    "auto: adoption listing opened — pet marked eligible for adoption",
  ],
  // adoption-repository.ts:565
  [{ code: "adoption_application_submitted" }, undefined, "auto: adoption application submitted"],
  // create-welfare-report.ts:197
  [
    {
      code: "welfare_report_citizen",
      referenceCode: "DEN-2026-0012",
      kind: "physical_abuse",
      severity: "high",
    },
    undefined,
    "Welfare denuncia DEN-2026-0012 — kind=physical_abuse, severity=high",
  ],
  // create-org-welfare-report.ts:199
  [
    {
      code: "welfare_report_org",
      referenceCode: "DEN-2026-0044",
      orgDisplayName: "Refugio Esperanza",
    },
    undefined,
    "auto: org-side welfare report by Refugio Esperanza (DEN-2026-0044)",
  ],
  // foster-repository.ts:798 — with expectedWeeks
  [
    {
      code: "foster_placement_assigned",
      actorOrgDisplayName: "Refugio Esperanza",
      expectedWeeks: 6,
    },
    undefined,
    "Foster placement assigned by Refugio Esperanza — expected 6 weeks",
  ],
  // foster-repository.ts:798 — without expectedWeeks
  [
    {
      code: "foster_placement_assigned",
      actorOrgDisplayName: "Refugio Esperanza",
      expectedWeeks: null,
    },
    undefined,
    "Foster placement assigned by Refugio Esperanza",
  ],
  // foster-repository.ts:922 — the two UUIDs live in AUDIT, never in params
  [
    { code: "foster_proposal_sent" },
    { volunteerUserId: VOLUNTEER_ID, orgId: ORG_ID },
    `Foster proposal to volunteer ${VOLUNTEER_ID} by org ${ORG_ID}`,
  ],
  // set-pet-lost-use-case.ts:205 — public token + owner note
  [
    {
      code: "pet_marked_lost",
      petPublicToken: "DIM-A1B2-C3D4",
      ownerNote: "se escapó en la plaza",
    },
    { petId: PET_ID },
    "Pet DIM-A1B2-C3D4 marked as lost by owner — se escapó en la plaza",
  ],
  // set-pet-lost-use-case.ts:205 — no note
  [
    { code: "pet_marked_lost", petPublicToken: "DIM-A1B2-C3D4", ownerNote: null },
    { petId: PET_ID },
    "Pet DIM-A1B2-C3D4 marked as lost by owner",
  ],
  // set-pet-lost-use-case.ts:205 — `petPublicToken || petId`: no token falls
  // back to the internal UUID in the AUDIT prose (as today). The renderer
  // never sees it.
  [
    { code: "pet_marked_lost", petPublicToken: null, ownerNote: null },
    { petId: PET_ID },
    `Pet ${PET_ID} marked as lost by owner`,
  ],
  // reactivate-lost-search.ts:73 — already es-AR today
  [
    { code: "lost_search_reactivated", petPublicToken: "DIM-A1B2-C3D4" },
    undefined,
    "Búsqueda reactivada por el dueño tras cierre automático por inactividad (pet DIM-A1B2-C3D4)",
  ],
  // execute-decomiso.ts:204 — with judicial ref
  [
    { code: "decomiso_executed", motive: "maltrato_fisico", judicialRef: "IPP-123/26" },
    undefined,
    "auto: decomiso motivo=maltrato_fisico judicial_ref=IPP-123/26",
  ],
  // execute-decomiso.ts:204 — `?? "sin_ref"`
  [
    { code: "decomiso_executed", motive: "acumulacion", judicialRef: null },
    undefined,
    "auto: decomiso motivo=acumulacion judicial_ref=sin_ref",
  ],
  // accept-decomiso-handoff.ts:253
  [
    { code: "decomiso_handoff_accepted", sourceCasePublicCode: "CASO-2026-0007" },
    undefined,
    "auto: decomiso handoff aceptado desde caso CASO-2026-0007",
  ],
  // report-bite.ts:123
  [
    { code: "bite_reported_owner", victimKind: "human", severity: "moderate" },
    undefined,
    "Bite incident reported by owner — victim=human, severity=moderate",
  ],
  // report-bite-from-org.ts:147
  [
    {
      code: "bite_reported_org",
      orgDisplayName: "Clínica Veterinaria Norte",
      reporterRole: "vet",
      victimKind: "human",
      severity: "severe",
    },
    undefined,
    "Bite incident reported by Clínica Veterinaria Norte (vet) — victim=human, severity=severe",
  ],
  // transfer-custody.ts:155 — THE ORIGINAL LEAK
  [
    { code: "custody_handoff_direct", toRole: "owner" },
    undefined,
    "auto: direct custody handoff to_role=owner",
  ],
  [
    { code: "custody_handoff_direct", toRole: "shelter_custody" },
    undefined,
    "auto: direct custody handoff to_role=shelter_custody",
  ],
  // propose-cross-org-transfer.ts:137
  [
    { code: "cross_org_transfer_proposed", reason: "space_constraint" },
    undefined,
    "auto: cross-org transfer proposed reason=space_constraint",
  ],
  // create-intake.ts:439
  [{ code: "org_intake", intakeReason: "rescue" }, undefined, "auto: org intake reason=rescue"],
  // replace-microchip.ts:212 — no duplicate
  [
    { code: "microchip_replaced", reason: "fraud_detected", duplicateDetected: false },
    { secondaryPetId: null },
    "auto: microchip_replaced reason=fraud_detected",
  ],
  // replace-microchip.ts:203 — `secondaryNote` when a duplicate pet exists
  [
    { code: "microchip_replaced", reason: "duplicate_detected", duplicateDetected: true },
    { secondaryPetId: SECONDARY_PET_ID },
    `auto: microchip_replaced reason=duplicate_detected secondaryPetId=${SECONDARY_PET_ID}`,
  ],
  // submit-claim-dispute.ts:105
  [
    { code: "custody_dispute_raised", raisedByRole: "owner" },
    undefined,
    "Custody dispute raised on pet — raised_by_role=owner",
  ],
  // outbreak-investigation.ts:177 — THE DEDUPE CONTRACT
  [
    {
      code: "outbreak_investigation_manual",
      diseaseCode: "rabia",
      note: "tres casos confirmados en la zona sur",
    },
    undefined,
    "manual [rabia]: tres casos confirmados en la zona sur",
  ],
  // src/modules/rehome (2026-08) — a post-cutover writer: its prose IS the
  // es-AR label, because the frozen legacy layer has no rule for it and a
  // rollback would render this row through the passthrough.
  [
    { code: "rehome_requested", orgDisplayName: "Refugio Padrino" },
    undefined,
    "Solicitud de nuevo hogar enviada por el titular a Refugio Padrino",
  ],
];

describe("openedReasonProse — byte-identical to what each writer emits today", () => {
  it.each(CASES)("%o → %s", (reason, audit, expected) => {
    expect(openedReasonProse(reason, audit)).toBe(expected);
  });

  it("covers every code in the union", () => {
    const covered = new Set(CASES.map(([r]) => r.code));
    expect([...covered].sort()).toEqual([...OPENED_REASON_CODES].sort());
  });
});

describe("openedReasonProse — the outbreak dedupe contract", () => {
  // surveillance-repository.ts:533 executes this LIKE as SQL. These assertions
  // are the contract that query depends on. If they fail, outbreak dedupe is
  // broken and nothing else will tell you.
  it("emits the exact `manual [{diseaseCode}]:` prefix the LIKE matches", () => {
    for (const diseaseCode of ["rabia", "rabies", "leptospirosis"]) {
      const prose = openedReasonProse({
        code: "outbreak_investigation_manual",
        diseaseCode,
        note: "cluster detectado",
      });
      // The literal SQL pattern, minus its trailing wildcard.
      expect(prose.startsWith(`manual [${diseaseCode}]:`)).toBe(true);
    }
  });

  it("keeps the single space between the prefix and the note", () => {
    expect(
      openedReasonProse({
        code: "outbreak_investigation_manual",
        diseaseCode: "rabia",
        note: "cluster",
      }),
    ).toBe("manual [rabia]: cluster");
  });
});

describe("openedReasonProse — satisfies cases_opened_reason_min_length", () => {
  it("every template is >= 10 chars, so the dual-write cannot trip the CHECK", () => {
    for (const [reason, audit, expected] of CASES) {
      expect(
        openedReasonProse(reason, audit).length,
        `${reason.code}: ${expected}`,
      ).toBeGreaterThanOrEqual(10);
    }
  });
});
