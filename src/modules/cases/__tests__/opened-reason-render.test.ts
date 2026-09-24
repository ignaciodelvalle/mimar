// opened-reason-render — the es-AR label a funcionario actually reads.
//
// These assertions are spec R1's acceptance table, one scenario per writer
// family. Two properties are non-negotiable and tested as invariants over ALL
// 19 codes at the bottom of this file:
//
//   - ZERO English. The bug this whole change exists to kill rendered as
//     "Apertura automática — direct custody handoff to_role=owner" for months:
//     English plus a raw enum key wrapped in a Spanish prefix, so it read like
//     a translation and nobody noticed.
//   - ZERO internal identifiers. No UUID, no org id, no volunteer id, no bare
//     `key=value`. The legacy regex layer strips these at render time; the
//     structured path makes them unreachable, and this pins that.

import { describe, expect, it } from "vitest";
import { OPENED_REASON_CODES, type OpenedReason } from "../domain/opened-reason";
import { openedReasonDisplay } from "../domain/opened-reason-legacy";
import { openedReasonProse } from "../domain/opened-reason-prose";
import { renderOpenedReason } from "../domain/opened-reason-render";

const VOLUNTEER_ID = "3f1a9c2e-1111-4222-8333-444455556666";
const ORG_ID = "7a2b4d6f-8888-4999-8aaa-bbbbccccdddd";
const PET_ID = "c1d2e3f4-5555-4666-8777-888899990000";
const SECONDARY_PET_ID = "d4e5f6a7-2222-4333-8444-555566667777";

// ---------------------------------------------------------------------------
// Spec R1 acceptance table — one row per writer family
// ---------------------------------------------------------------------------

const R1: Array<[string, OpenedReason, string]> = [
  [
    "R1#3 adoption listing",
    { code: "adoption_listing_opened" },
    "Publicación en adopción abierta automáticamente: la mascota fue marcada como apta para adopción",
  ],
  [
    "R1#4 adoption application",
    { code: "adoption_application_submitted" },
    "Postulación de adopción enviada",
  ],
  [
    "R1#1 welfare (citizen)",
    {
      code: "welfare_report_citizen",
      referenceCode: "DEN-2026-0012",
      kind: "physical_abuse",
      severity: "high",
    },
    "Denuncia de bienestar DEN-2026-0012 — tipo: maltrato físico, gravedad: alta",
  ],
  [
    "R1#2 welfare (org)",
    {
      code: "welfare_report_org",
      referenceCode: "DEN-2026-0044",
      orgDisplayName: "Refugio Esperanza",
    },
    "Denuncia de bienestar registrada por Refugio Esperanza (DEN-2026-0044)",
  ],
  [
    "R1#14 foster placement (with duration)",
    {
      code: "foster_placement_assigned",
      actorOrgDisplayName: "Refugio Esperanza",
      expectedWeeks: 6,
    },
    "Tránsito asignado por Refugio Esperanza — duración estimada: 6 semanas",
  ],
  [
    "R1#14 foster placement (no duration)",
    {
      code: "foster_placement_assigned",
      actorOrgDisplayName: "Refugio Esperanza",
      expectedWeeks: null,
    },
    "Tránsito asignado por Refugio Esperanza",
  ],
  [
    "R1#15 foster proposal — neither id appears",
    { code: "foster_proposal_sent" },
    "Propuesta de tránsito enviada a una persona voluntaria",
  ],
  [
    "R1#16 lost pet (public token)",
    {
      code: "pet_marked_lost",
      petPublicToken: "DIM-A1B2-C3D4",
      ownerNote: "se escapó en la plaza",
    },
    "Mascota DIM-A1B2-C3D4 reportada como perdida por su dueño — se escapó en la plaza",
  ],
  [
    // "if no token exists, the id is omitted entirely rather than showing the UUID"
    "R1#16 lost pet (no token → id omitted, NEVER the UUID)",
    { code: "pet_marked_lost", petPublicToken: null, ownerNote: null },
    "Mascota reportada como perdida por su dueño",
  ],
  [
    "R1#18 lost-search reactivation",
    { code: "lost_search_reactivated", petPublicToken: "DIM-A1B2-C3D4" },
    "Búsqueda reactivada por el dueño tras cierre automático por inactividad (mascota DIM-A1B2-C3D4)",
  ],
  [
    "R1#7 decomiso (with judicial ref)",
    { code: "decomiso_executed", motive: "maltrato_fisico", judicialRef: "IPP-123/26" },
    "Decomiso — motivo: maltrato físico — ref. judicial: IPP-123/26",
  ],
  [
    "R1#7 decomiso (no judicial ref)",
    { code: "decomiso_executed", motive: "acumulacion", judicialRef: null },
    "Decomiso — motivo: acumulación",
  ],
  [
    "R1#8 decomiso handoff — public code, no internal UUID",
    { code: "decomiso_handoff_accepted", sourceCasePublicCode: "CASO-2026-0007" },
    "Traspaso de decomiso aceptado desde el caso CASO-2026-0007",
  ],
  [
    "R1#9 bite (owner-reported)",
    { code: "bite_reported_owner", victimKind: "human", severity: "moderate" },
    "Mordedura reportada por el dueño — víctima: persona, gravedad: moderada",
  ],
  [
    "R1#10 bite (org-reported)",
    {
      code: "bite_reported_org",
      orgDisplayName: "Clínica Veterinaria Norte",
      reporterRole: "vet",
      victimKind: "human",
      severity: "severe",
    },
    "Mordedura reportada por Clínica Veterinaria Norte (veterinaria) — víctima: persona, gravedad: grave",
  ],
  [
    // THE ORIGINAL LEAK. Was: "Apertura automática — direct custody handoff to_role=owner"
    "R1#5 direct custody handoff — the proven leak",
    { code: "custody_handoff_direct", toRole: "owner" },
    "Traspaso directo de custodia — pasa a: dueño permanente",
  ],
  [
    "R1#5 direct custody handoff (shelter)",
    { code: "custody_handoff_direct", toRole: "shelter_custody" },
    "Traspaso directo de custodia — pasa a: custodia temporal",
  ],
  [
    "R1#6 cross-org transfer",
    { code: "cross_org_transfer_proposed", reason: "space_constraint" },
    "Transferencia entre organizaciones propuesta — motivo: falta de espacio",
  ],
  [
    "R1#11 intake",
    { code: "org_intake", intakeReason: "rescue" },
    "Ingreso registrado por la organización — motivo: rescate",
  ],
  [
    "R1#12 microchip (no duplicate)",
    { code: "microchip_replaced", reason: "fraud_detected", duplicateDetected: false },
    "Reemplazo de microchip — motivo: fraude detectado",
  ],
  [
    "R1#12 microchip (duplicate detected — the fact, never the UUID)",
    { code: "microchip_replaced", reason: "duplicate_detected", duplicateDetected: true },
    "Reemplazo de microchip — motivo: duplicado detectado — se detectó otra mascota con el mismo chip",
  ],
  [
    "R1#13 claim dispute",
    { code: "custody_dispute_raised", raisedByRole: "owner" },
    "Disputa de custodia iniciada por el dueño sobre la mascota",
  ],
  [
    // "the dedupe-contract prefix format itself is preserved as a distinct,
    //  documented grammar (it is a machine dedupe key, not prose to eliminate)"
    "R1#17 outbreak investigation — prefix grammar preserved",
    {
      code: "outbreak_investigation_manual",
      diseaseCode: "rabia",
      note: "tres casos confirmados en la zona sur",
    },
    "Apertura manual [rabia] — tres casos confirmados en la zona sur",
  ],
  [
    // rehome-by-titular (2026-08): born after the cutover, es-AR from day one.
    "rehome request to a sponsoring org",
    { code: "rehome_requested", orgDisplayName: "Refugio Padrino" },
    "Solicitud de nuevo hogar enviada por el titular a Refugio Padrino",
  ],
];

describe("renderOpenedReason — spec R1 acceptance table", () => {
  it.each(R1)("%s", (_name, reason, expected) => {
    expect(renderOpenedReason(reason)).toBe(expected);
  });

  it("covers every code in the union", () => {
    expect([...new Set(R1.map(([, r]) => r.code))].sort()).toEqual([...OPENED_REASON_CODES].sort());
  });
});

// ---------------------------------------------------------------------------
// R1 invariants — properties that must hold for EVERY code, not just the table
// ---------------------------------------------------------------------------

describe("renderOpenedReason — zero internal identifiers (spec R1, non-negotiable)", () => {
  const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // Every code, with an internal id supplied wherever one exists.
  const ALL: OpenedReason[] = R1.map(([, r]) => r);

  it.each(ALL)("no UUID appears in the label for %o", (reason) => {
    expect(renderOpenedReason(reason)).not.toMatch(UUID_ANYWHERE);
  });

  it("the audit UUIDs are structurally unreachable from the renderer", () => {
    // These ids exist in the AUDIT prose. They must not appear in any label.
    const withIds: Array<[OpenedReason, Record<string, string | null>]> = [
      [{ code: "foster_proposal_sent" }, { volunteerUserId: VOLUNTEER_ID, orgId: ORG_ID }],
      [{ code: "pet_marked_lost", petPublicToken: null, ownerNote: null }, { petId: PET_ID }],
      [
        { code: "microchip_replaced", reason: "duplicate_detected", duplicateDetected: true },
        { secondaryPetId: SECONDARY_PET_ID },
      ],
    ];
    for (const [reason, audit] of withIds) {
      const label = renderOpenedReason(reason);
      const prose = openedReasonProse(reason, audit);
      for (const id of Object.values(audit)) {
        if (!id) continue;
        expect(prose).toContain(id); // the id IS in the audit column, as today
        expect(label).not.toContain(id); // and never in what a human reads
      }
    }
  });

  it.each(ALL)("no raw `key=value` token survives into the label for %o", (reason) => {
    // to_role=owner, victim=human, kind=physical_abuse, severity=high, ...
    expect(renderOpenedReason(reason)).not.toMatch(/\b[a-z_]+=[^\s]/);
  });
});

describe("renderOpenedReason — zero English (spec R1, the core bug)", () => {
  // Tokens from the 18 audit templates. Not a general English detector — a
  // regression net for the exact words that leaked.
  const ENGLISH = [
    "auto:",
    // NOT "manual [" — spec R1#17 keeps that grammar, and "Apertura manual" is
    // es-AR. The raw-prose marker is the `]:` separator the rendered form
    // replaces with an em dash.
    "]:",
    "direct custody handoff",
    "adoption listing opened",
    "adoption application submitted",
    "Welfare denuncia",
    "org-side welfare report",
    "Foster placement assigned",
    "Foster proposal",
    "marked as lost by owner",
    "decomiso motivo=",
    "Bite incident reported",
    "cross-org transfer proposed",
    "org intake",
    "microchip_replaced",
    "Custody dispute raised",
    " by org ",
    " weeks",
    "(pet ",
    "witness",
    "shelter",
    "unknown",
  ];

  it.each(R1)("%s leaks no English token", (_name, reason) => {
    const label = renderOpenedReason(reason);
    for (const token of ENGLISH) {
      expect(label, `leaked "${token}"`).not.toContain(token);
    }
  });
});

describe("renderOpenedReason — every reporter role renders es-AR", () => {
  // orgTypeToReporterRole defaults to "witness" for org types outside the
  // vet/shelter/govt buckets, so this value IS reachable in production.
  it.each(["vet", "shelter", "govt", "witness"] as const)(
    "role %s is translated",
    (reporterRole) => {
      const label = renderOpenedReason({
        code: "bite_reported_org",
        orgDisplayName: "Org",
        reporterRole,
        victimKind: "human",
        severity: "minor",
      });
      // Word-boundary, not substring: "vet" is legitimately inside "veterinaria".
      // What must not survive is the raw enum key as its own token.
      expect(label).not.toMatch(new RegExp(`\\b${reporterRole}\\b`));
    },
  );
});

describe("renderOpenedReason — every dispute role renders es-AR", () => {
  it.each(["owner", "org", "govt", "admin"] as const)("role %s is translated", (raisedByRole) => {
    const label = renderOpenedReason({ code: "custody_dispute_raised", raisedByRole });
    expect(label).not.toContain(`rol: ${raisedByRole}`);
    expect(label).toContain("Disputa de custodia iniciada");
  });
});

// ---------------------------------------------------------------------------
// Rollback equivalence — the dual-write's other payoff
// ---------------------------------------------------------------------------

describe("structured render == legacy render of the same row's prose", () => {
  // If the code column were reverted/dropped, every post-cutover row would
  // render from its prose through the frozen regexes. This asserts a reader
  // would see the SAME label either way — i.e. rollback is genuinely free.
  //
  // Three codes render BETTER structured than legacy, listed with why. They are
  // improvements, not drift: the prose bytes are still byte-identical (that is
  // opened-reason-prose.test.ts's gate), only the es-AR reading improves.
  const KNOWN_IMPROVEMENTS = new Set([
    // Legacy passes the writer's es-AR through verbatim, keeping the English
    // "(pet X)". The renderer says "(mascota X)". Spec R1 forbids English
    // tokens; scenario 18 forbids re-translation. Rendering from the CODE
    // satisfies both — there is no prose to re-translate.
    "lost_search_reactivated",
  ]);

  it.each(R1.filter(([, r]) => !KNOWN_IMPROVEMENTS.has(r.code)))(
    "%s renders identically through both paths",
    (_name, reason) => {
      const audit = {
        volunteerUserId: VOLUNTEER_ID,
        orgId: ORG_ID,
        petId: PET_ID,
        secondaryPetId:
          reason.code === "microchip_replaced" && reason.duplicateDetected
            ? SECONDARY_PET_ID
            : null,
      };
      expect(openedReasonDisplay(openedReasonProse(reason, audit))).toBe(
        renderOpenedReason(reason),
      );
    },
  );
});
