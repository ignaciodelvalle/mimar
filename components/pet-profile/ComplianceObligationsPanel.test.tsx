// ComplianceObligationsPanel — jurisdiction-tier treatment (spec CS2/CS3/CS4).
//
// Table fence: mandatory → the existing urgency styling (red allowed);
// recommended → distinct softer treatment, NEVER "vencida"/overdue styling;
// not_regulated → informational only, never an obligation card, never inside
// the compliance percentage. States derive from the REAL projection so the
// panel test can never drift from deriveComplianceState's contract.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  type ComplianceInput,
  type ComplianceObligations,
  deriveComplianceState,
} from "@/lib/projections/pet-compliance";
import { ComplianceObligationsPanel } from "./ComplianceObligationsPanel";

const NOW = new Date("2026-07-01T12:00:00Z");
const VET = { authorRole: "vet", authorVerified: true, authorOrganizationId: null };

// The LnBadge/LnVstamp danger palette — the "red" the fence bans off
// recommended/informational cards.
const DANGER_TOKEN = "--color-ln-err";

function obligations(
  overrides: Partial<Record<keyof ComplianceObligations, { requirementLevel: string }>> = {},
): ComplianceObligations {
  const mandatory = {
    requirementLevel: "mandatory" as const,
    legalBasis: null,
    authority: null,
    sourceUrl: null,
  };
  return {
    rabies: { ...mandatory, ...overrides.rabies } as ComplianceObligations["rabies"],
    sterilization: {
      ...mandatory,
      ...overrides.sterilization,
    } as ComplianceObligations["sterilization"],
    microchip: { ...mandatory, ...overrides.microchip } as ComplianceObligations["microchip"],
  };
}

// An expired VERIFIED rabies dose — urgent under mandatory, softened otherwise.
function expiredRabiesInput(obl: ComplianceObligations): ComplianceInput {
  return {
    now: NOW,
    events: [
      {
        eventType: "vaccination_administered",
        occurredAt: "2026-01-01T00:00:00Z",
        payload: { vaccine_name: "Antirrábica", next_due_at: "2026-06-01" },
        ...VET,
      },
    ],
    rabiesReminder: null,
    reservedRabiesTurno: null,
    microchipCode: null,
    pppApplies: false,
    obligations: obl,
  };
}

function render(input: ComplianceInput): string {
  return renderToStaticMarkup(
    <ComplianceObligationsPanel state={deriveComplianceState(input)} petPublicToken="TEST-0001" />,
  );
}

describe("ComplianceObligationsPanel — tier treatment table", () => {
  it("mandatory: an expired dose keeps the existing overdue (red) styling", () => {
    const html = render(expiredRabiesInput(obligations()));
    expect(html).toContain(DANGER_TOKEN);
    expect(html).not.toContain("Recomendación de tu jurisdicción");
  });

  it("recommended: same expired dose renders softer — no red, with the disclosure line", () => {
    const html = render(
      expiredRabiesInput(obligations({ rabies: { requirementLevel: "recommended" } })),
    );
    expect(html).not.toContain(DANGER_TOKEN);
    expect(html).toContain("Recomendación de tu jurisdicción — no es una obligación legal.");
  });

  it("not_regulated: a registered chip renders informational with its disclosure line", () => {
    const input: ComplianceInput = {
      now: NOW,
      events: [],
      rabiesReminder: null,
      reservedRabiesTurno: null,
      microchipCode: "982000123456789",
      pppApplies: false,
      obligations: obligations({ microchip: { requirementLevel: "not_regulated" } }),
    };
    const html = render(input);
    expect(html).toContain("Solo informativo — no es una obligación en tu jurisdicción.");
    // Excluded from the compliance percentage: only rabies + sterilization count.
    expect(html).toContain("0 de 2 al día");
  });

  it("not_regulated with nothing on record renders no card at all", () => {
    const input: ComplianceInput = {
      now: NOW,
      events: [],
      rabiesReminder: null,
      reservedRabiesTurno: null,
      microchipCode: null,
      pppApplies: false,
      obligations: obligations({ microchip: { requirementLevel: "not_regulated" } }),
    };
    const html = render(input);
    expect(html).not.toContain('data-obligation="microchip"');
    expect(html).toContain("0 de 2 al día");
  });
});

// A due date COMPUTED from the jurisdiction's cadence (dueSource "rule") is a
// suggestion: the panel prints the projection's own words in a plain badge,
// never the vaccine stamp's VENCIDA / POR VENCER, and never red.
describe("ComplianceObligationsPanel — rule-derived rabies date", () => {
  function ruleInput(frequencyMonths: number, frequencyLegalBasis?: string): ComplianceInput {
    return {
      now: NOW,
      events: [
        {
          eventType: "vaccination_administered",
          occurredAt: "2025-09-15T15:00:00Z",
          payload: { vaccine_name: "Antirrábica", next_due_at: null },
          ...VET,
        },
      ],
      rabiesReminder: null,
      reservedRabiesTurno: null,
      microchipCode: null,
      pppApplies: false,
      ruleParams: {
        rabies: { frequencyMonths, minAgeMonths: null, frequencyLegalBasis },
        sterilization: { minAgeMonths: null, mandatoryFromMonths: null },
      },
    };
  }

  it("a lapsed suggestion reads as a suggestion, in warning, with the turno action", () => {
    const html = render(ruleInput(6));
    expect(html).toContain("Refuerzo sugerido vencido");
    expect(html).toContain("Aplicada 15/09/2025 · refuerzo sugerido vencido el 15/03");
    expect(html).toContain(
      "Fecha calculada con la frecuencia de refuerzo que configuró tu jurisdicción (cada 6 meses); no la fijó un veterinario.",
    );
    expect(html).not.toContain("VENCIDA");
    expect(html).not.toContain("POR VENCER");
    expect(html).not.toContain(DANGER_TOKEN);
    expect(html).toContain("Programar turno");
  });

  it("an upcoming suggestion is neither VIGENTE nor SIN DATO", () => {
    const html = render(ruleInput(12));
    expect(html).toContain("Refuerzo sugerido");
    expect(html).not.toContain("VIGENTE");
    expect(html).not.toContain("SIN DATO");
  });

  // D5 (PO 2026-09-18): the SAME cadence with its norm cited is a deadline —
  // the vaccine stamp speaks, the suggestion copy is gone, the norm is shown.
  it("a SOURCED cadence stamps like a dated dose and cites the cadence norm", () => {
    const lapsed = render(ruleInput(6, "Norma de cadencia"));
    expect(lapsed).toContain("VENCIDA");
    expect(lapsed).not.toContain("Refuerzo sugerido");
    expect(lapsed).toContain("refuerzo cada 6 meses según Norma de cadencia");

    const upcoming = render(ruleInput(12, "Norma de cadencia"));
    expect(upcoming).toContain("VIGENTE");
    expect(upcoming).not.toContain("Refuerzo sugerido");
    expect(upcoming).not.toContain("SIN DATO");
  });
});

// ---------------------------------------------------------------------------
// RUPPPA export slot (L-11)
// ---------------------------------------------------------------------------
// The page decides eligibility and hands the affordance in as a slot; the panel
// only places it — on the PPP card of a pet the regime APPLIES to, never on the
// "Faltan datos" nudge and never when the caller passed nothing.

describe("ComplianceObligationsPanel — RUPPPA export slot", () => {
  const SLOT = <span>SLOT-PPP-EXPORT</span>;

  function pppInput(overrides: Partial<ComplianceInput>): ComplianceInput {
    return { ...expiredRabiesInput(obligations()), ...overrides };
  }

  function renderWith(
    input: ComplianceInput,
    pppExport: Parameters<typeof ComplianceObligationsPanel>[0]["pppExport"],
  ): string {
    return renderToStaticMarkup(
      <ComplianceObligationsPanel
        state={deriveComplianceState(input)}
        petPublicToken="TEST-0001"
        pppExport={pppExport}
      />,
    );
  }

  it("renders the slot inside the PPP card when the regime applies", () => {
    const html = renderWith(pppInput({ pppApplies: true, species: "dog" }), SLOT);
    const pppCard = html.split('data-obligation="ppp"')[1] ?? "";
    expect(pppCard).toContain('data-slot="ppp-export"');
    expect(pppCard).toContain("SLOT-PPP-EXPORT");
  });

  it("renders no slot when the caller passes none (not the legal owner)", () => {
    const html = renderWith(pppInput({ pppApplies: true, species: "dog" }), null);
    expect(html).toContain('data-obligation="ppp"');
    expect(html).not.toContain('data-slot="ppp-export"');
  });

  it("never renders it on the 'Faltan datos' nudge — the dog is not known to be PPP", () => {
    const html = renderWith(
      pppInput({ pppApplies: false, species: "dog", breed: null, estimatedWeightKg: null }),
      SLOT,
    );
    expect(html).toContain("Faltan datos");
    expect(html).not.toContain("SLOT-PPP-EXPORT");
  });

  it("never renders it when there is no PPP card at all", () => {
    const html = renderWith(pppInput({ pppApplies: false, species: "cat" }), SLOT);
    expect(html).not.toContain('data-obligation="ppp"');
    expect(html).not.toContain("SLOT-PPP-EXPORT");
  });
});

// ---------------------------------------------------------------------------
// The "Registrar atestación" door — T4-I1 / #753
// ---------------------------------------------------------------------------
//
// The door used to key on the literal state "Atestación requerida". #753 gave
// the card a THIRD state, "Declarada" (an attestation exists but cites no
// inscription number and carries no institutional signature), whose hint tells
// the person to add the number — and the only way to add one is to file a new
// attestation through this very door. A door shut there would print an
// instruction with no way to follow it, so it now keys on `tone !== "ok"`,
// which is also the fact the mobile owner face reads.
describe("ComplianceObligationsPanel — the attestation door (#753)", () => {
  const DOOR = "Registrar atestación";

  function pppPanel(overrides: Partial<ComplianceInput>): string {
    return renderToStaticMarkup(
      <ComplianceObligationsPanel
        state={deriveComplianceState({
          ...expiredRabiesInput(obligations()),
          pppApplies: true,
          species: "dog",
          ...overrides,
        })}
        petPublicToken="TEST-0001"
      />,
    );
  }

  const attestation = (payload: Record<string, unknown>, author = {}) => [
    {
      eventType: "dangerous_breed_attested",
      occurredAt: new Date("2026-01-10T12:00:00Z"),
      payload,
      authorRole: "owner",
      authorVerified: false,
      ...author,
    },
  ];

  it("offers the door when nothing is on record", () => {
    const html = pppPanel({});
    expect(html).toContain("Atestación requerida");
    expect(html).toContain(DOOR);
  });

  it("STILL offers it on a Declarada card — that is how the number gets added", () => {
    const html = pppPanel({
      events: attestation({ registry: "caba_4078", registry_id: null }),
    });
    expect(html).toContain("Declarada");
    expect(html).toContain(DOOR);
  });

  it("withdraws it once the attestation counts", () => {
    const html = pppPanel({
      events: attestation({ registry: "caba_4078", registry_id: "RUPPPA-12345" }),
    });
    expect(html).toContain("Atestada");
    expect(html).not.toContain(DOOR);
  });

  // The indeterminado nudge is a DIFFERENT card: that dog is not yet known to
  // be PPP, so offering to register it in the dangerous-breed registry would
  // be the panel answering a question it has not asked yet.
  it("never offers it on the 'Faltan datos' nudge", () => {
    const html = pppPanel({ pppApplies: false, breed: null, estimatedWeightKg: null });
    expect(html).toContain("Faltan datos");
    expect(html).not.toContain(DOOR);
  });
});
