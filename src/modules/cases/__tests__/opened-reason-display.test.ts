// Unit tests for the es-AR display layer over cases.opened_reason /
// cases.closed_reason, plus the caseKindLabel unknown-kind fallback.
// Layer: Unit (pure functions, no DB, no Next.js).

import { describe, expect, it } from "vitest";

import { caseKindLabel } from "@/src/modules/cases/domain/case-kinds";
import {
  caseClosedReasonLabel,
  openedReasonDisplay,
} from "@/src/modules/cases/domain/opened-reason-display";

const VOLUNTEER_UUID = "0b6a2f0e-3c4d-4a5b-8c9d-1e2f3a4b5c6d";
const ORG_UUID = "9f8e7d6c-5b4a-4c3d-a2b1-0f9e8d7c6b5a";
const PET_UUID = "12345678-90ab-4cde-8f01-234567890abc";

// ---------------------------------------------------------------------------
// openedReasonDisplay — writer grammars
// ---------------------------------------------------------------------------

describe("openedReasonDisplay", () => {
  it("renders null/empty as 'Sin motivo registrado'", () => {
    expect(openedReasonDisplay(null)).toBe("Sin motivo registrado");
    expect(openedReasonDisplay("")).toBe("Sin motivo registrado");
    expect(openedReasonDisplay("   ")).toBe("Sin motivo registrado");
  });

  it("translates the adoption listing auto-open (adoption-repository:292)", () => {
    expect(
      openedReasonDisplay("auto: adoption listing opened — pet marked eligible for adoption"),
    ).toBe(
      "Publicación en adopción abierta automáticamente: la mascota fue marcada como apta para adopción",
    );
  });

  it("translates the adoption application auto-open (adoption-repository:560)", () => {
    expect(openedReasonDisplay("auto: adoption application submitted")).toBe(
      "Postulación de adopción enviada",
    );
  });

  it("translates welfare denuncia key=value enums (create-welfare-report:197)", () => {
    expect(
      openedReasonDisplay("Welfare denuncia DEN-2026-0012 — kind=physical_abuse, severity=high"),
    ).toBe("Denuncia de bienestar DEN-2026-0012 — tipo: maltrato físico, gravedad: alta");
  });

  it("translates the org-side welfare report (create-org-welfare-report:199)", () => {
    expect(
      openedReasonDisplay("auto: org-side welfare report by Refugio Esperanza (DEN-2026-0044)"),
    ).toBe("Denuncia de bienestar registrada por Refugio Esperanza (DEN-2026-0044)");
  });

  it("translates foster placement with expected weeks (foster-repository:757)", () => {
    expect(
      openedReasonDisplay("Foster placement assigned by Refugio Esperanza — expected 6 weeks"),
    ).toBe("Tránsito asignado por Refugio Esperanza — duración estimada: 6 semanas");
  });

  it("translates foster placement without expected weeks", () => {
    expect(openedReasonDisplay("Foster placement assigned by Refugio Esperanza")).toBe(
      "Tránsito asignado por Refugio Esperanza",
    );
  });

  it("strips volunteer + org UUIDs from foster proposals (foster-repository:881)", () => {
    const out = openedReasonDisplay(
      `Foster proposal to volunteer ${VOLUNTEER_UUID} by org ${ORG_UUID}`,
    );
    expect(out).toBe("Propuesta de tránsito enviada a una persona voluntaria");
    expect(out).not.toContain(VOLUNTEER_UUID);
    expect(out).not.toContain(ORG_UUID);
  });

  it("translates pet-lost with public token and free-text reason (set-pet-lost:190)", () => {
    expect(
      openedReasonDisplay("Pet DIM-A1B2-C3D4 marked as lost by owner — se escapó en la plaza"),
    ).toBe("Mascota DIM-A1B2-C3D4 reportada como perdida por su dueño — se escapó en la plaza");
  });

  it("strips the internal pet UUID when the pet had no public token", () => {
    const out = openedReasonDisplay(`Pet ${PET_UUID} marked as lost by owner`);
    expect(out).toBe("Mascota reportada como perdida por su dueño");
    expect(out).not.toContain(PET_UUID);
  });

  it("translates decomiso with judicial reference (execute-decomiso:204)", () => {
    expect(
      openedReasonDisplay("auto: decomiso motivo=maltrato_fisico judicial_ref=IPP-123/26"),
    ).toBe("Decomiso — motivo: maltrato físico — ref. judicial: IPP-123/26");
  });

  it("omits the judicial reference when it is sin_ref", () => {
    expect(openedReasonDisplay("auto: decomiso motivo=acumulacion judicial_ref=sin_ref")).toBe(
      "Decomiso — motivo: acumulación",
    );
  });

  it("translates the decomiso handoff acceptance (accept-decomiso-handoff:253)", () => {
    expect(openedReasonDisplay("auto: decomiso handoff aceptado desde caso CASO-2026-0007")).toBe(
      "Traspaso de decomiso aceptado desde el caso CASO-2026-0007",
    );
  });

  it("translates owner bite reports with enum values (report-bite:112)", () => {
    expect(
      openedReasonDisplay("Bite incident reported by owner — victim=human, severity=moderate"),
    ).toBe("Mordedura reportada por el dueño — víctima: persona, gravedad: moderada");
  });

  it("translates org bite reports with reporter role (report-bite-from-org:137)", () => {
    expect(
      openedReasonDisplay(
        "Bite incident reported by Clínica San Roque (vet) — victim=animal, severity=severe",
      ),
    ).toBe(
      "Mordedura reportada por Clínica San Roque (veterinaria) — víctima: animal, gravedad: grave",
    );
  });

  it("translates cross-org transfer proposals (propose-cross-org-transfer:137)", () => {
    expect(openedReasonDisplay("auto: cross-org transfer proposed reason=space_constraint")).toBe(
      "Transferencia entre organizaciones propuesta — motivo: falta de espacio",
    );
  });

  // This writer shipped with no rule and leaked to production: the generic
  // `auto:` catch-all rendered it as "Apertura automática — direct custody
  // handoff to_role=owner". The catch-all is why it survived — it wraps unknown
  // English in a Spanish prefix, so the failure looks like a translation.
  it("translates direct custody handoffs (transfer-custody:155)", () => {
    expect(openedReasonDisplay("auto: direct custody handoff to_role=owner")).toBe(
      "Traspaso directo de custodia — pasa a: dueño permanente",
    );
    expect(openedReasonDisplay("auto: direct custody handoff to_role=shelter_custody")).toBe(
      "Traspaso directo de custodia — pasa a: custodia temporal",
    );
  });

  it("never leaks the raw English of a known writer through the auto: catch-all", () => {
    for (const raw of [
      "auto: direct custody handoff to_role=owner",
      "auto: cross-org transfer proposed reason=space_constraint",
      "auto: org intake reason=stray_found",
    ]) {
      const out = openedReasonDisplay(raw);
      expect(out).not.toContain("Apertura automática —");
      expect(out).not.toMatch(/to_role=|reason=[a-z_]+$/);
    }
  });

  it("translates org intakes (create-intake:426)", () => {
    expect(openedReasonDisplay("auto: org intake reason=stray_found")).toBe(
      "Ingreso registrado por la organización — motivo: animal callejero encontrado",
    );
  });

  it("translates microchip replacement and strips the secondary pet UUID (replace-microchip:212)", () => {
    const out = openedReasonDisplay(
      `auto: microchip_replaced reason=duplicate_detected secondaryPetId=${PET_UUID}`,
    );
    expect(out).toBe(
      "Reemplazo de microchip — motivo: duplicado detectado — se detectó otra mascota con el mismo chip",
    );
    expect(out).not.toContain(PET_UUID);
  });

  it("translates microchip replacement without a secondary pet", () => {
    expect(openedReasonDisplay("auto: microchip_replaced reason=fraud_detected")).toBe(
      "Reemplazo de microchip — motivo: fraude detectado",
    );
  });

  it("translates custody disputes raised by the owner (submit-claim-dispute:105)", () => {
    expect(openedReasonDisplay("Custody dispute raised on pet — raised_by_role=owner")).toBe(
      "Disputa de custodia iniciada por el dueño sobre la mascota",
    );
  });

  it("renders the manual [code] grammar with its free-text tail (outbreak-investigation:169)", () => {
    expect(openedReasonDisplay("manual [rabia]: tres casos confirmados en la zona sur")).toBe(
      "Apertura manual [rabia] — tres casos confirmados en la zona sur",
    );
  });

  it("degrades unknown auto strings to a generic es-AR prefix", () => {
    expect(openedReasonDisplay("auto: status_changed to lost")).toBe(
      "Apertura automática — status_changed to lost",
    );
  });

  it("passes genuine free text through unchanged", () => {
    const freeText = "Vecino reporta perro suelto hace tres días en Barrio Norte.";
    expect(openedReasonDisplay(freeText)).toBe(freeText);
  });

  it("passes an unknown enum value through inside a recognized grammar", () => {
    expect(openedReasonDisplay("auto: org intake reason=future_reason")).toBe(
      "Ingreso registrado por la organización — motivo: future_reason",
    );
  });
});

// ---------------------------------------------------------------------------
// caseClosedReasonLabel
// ---------------------------------------------------------------------------

describe("caseClosedReasonLabel", () => {
  it("maps the four CASE_CLOSED_REASONS to es-AR", () => {
    expect(caseClosedReasonLabel("resolved")).toBe("Resuelta");
    expect(caseClosedReasonLabel("cancelled")).toBe("Cancelada");
    expect(caseClosedReasonLabel("auto_expired")).toBe("Cerrada automáticamente");
    expect(caseClosedReasonLabel("merged")).toBe("Fusionada");
  });

  it("renders null as empty (callers guard for presence)", () => {
    expect(caseClosedReasonLabel(null)).toBe("");
  });

  it("passes unknown values through", () => {
    expect(caseClosedReasonLabel("future_reason")).toBe("future_reason");
  });
});

// ---------------------------------------------------------------------------
// caseKindLabel — unknown-kind fallback
// ---------------------------------------------------------------------------

describe("caseKindLabel fallback", () => {
  it("still labels union kinds", () => {
    expect(caseKindLabel("bite_incident")).toBe("Mordedura / observación rábica");
  });

  // NOT a supported kind — a retired one. Nothing opens 'rabies_observation'
  // any more (the seed now writes 'bite_incident', the kind that has a
  // closer), but rows written before that fix still sit in staging/prod and
  // must not render blank. The label is a read-side courtesy for legacy data,
  // never a licence to write the kind again — __tests__/seed-case-kinds.test.ts
  // is what stops that.
  it("still labels the retired rabies_observation kind so legacy rows never render blank", () => {
    expect(caseKindLabel("rabies_observation")).toBe("Observación antirrábica");
  });

  it("falls back to the raw key for unknown kinds — never blank", () => {
    expect(caseKindLabel("some_future_kind")).toBe("some_future_kind");
  });

  it("falls back to a generic label for an empty kind", () => {
    expect(caseKindLabel("")).toBe("Caso");
  });
});
