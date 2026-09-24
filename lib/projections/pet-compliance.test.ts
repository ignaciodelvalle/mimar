import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type ComplianceEvent,
  type ComplianceInput,
  type ComplianceObligationRule,
  type ComplianceObligations,
  NO_COUNTED_OBLIGATIONS_LABEL,
  composeLegalCitation,
  deriveComplianceState,
  lnPetStatusFromCompliance,
  microchipHeroTag,
} from "@/lib/projections/pet-compliance";

const NOW = new Date("2026-07-01T12:00:00Z");

// Provenance presets (H1): only professional/institutional events clear an
// obligation. VET → professional_verified; SELF (owner) → self_reported.
const VET = { authorRole: "vet", authorVerified: true, authorOrganizationId: null };
// The owner-declared fixture names its AUTHOR, and baseInput names the READER.
// Before 2026-08-01 it said only `authorRole: "owner"` and no reader existed at
// all, so "cargada por vos" was true by construction for every viewer — which
// is precisely how a transferred pet's dose came to greet the new titular as
// her own work.
const OWNER_USER = "user-owner";
const SELF = {
  authorRole: "owner",
  authorVerified: false,
  authorOrganizationId: null,
  recordedByUserId: OWNER_USER,
};
// VET-role trust keystone (#43): an org member WITHOUT a validated matrícula →
// org_registered. A valid record, but NOT professional-verified — it must NOT
// clear the "al día" gate (closes the "verificado por profesional" theater #45).
const ORG = { authorRole: "shelter", authorVerified: false, authorOrganizationId: "org-1" };

function baseInput(overrides: Partial<ComplianceInput> = {}): ComplianceInput {
  return {
    now: NOW,
    events: [],
    rabiesReminder: null,
    reservedRabiesTurno: null,
    microchipCode: null,
    pppApplies: false,
    viewerUserId: OWNER_USER,
    ...overrides,
  };
}

function vaccination(
  vaccineName: string,
  nextDueAt: string | null,
  prov: Partial<ComplianceEvent> = SELF,
): ComplianceEvent {
  return {
    eventType: "vaccination_administered",
    occurredAt: "2026-01-01T00:00:00Z",
    payload: { vaccine_name: vaccineName, next_due_at: nextDueAt },
    ...prov,
  };
}

describe("deriveComplianceState — card set + PPP gate", () => {
  it("always yields rabies, sterilization and microchip", () => {
    const { cards } = deriveComplianceState(baseInput());
    expect(cards.map((c) => c.key).sort()).toEqual(["microchip", "rabies", "sterilization"]);
  });

  it("omits the PPP card when the jurisdiction gate does not apply", () => {
    const { cards } = deriveComplianceState(baseInput({ pppApplies: false }));
    expect(cards.some((c) => c.key === "ppp")).toBe(false);
  });

  it("appends the PPP card when the gate applies", () => {
    const { cards } = deriveComplianceState(baseInput({ pppApplies: true }));
    expect(cards.some((c) => c.key === "ppp")).toBe(true);
  });
});

describe("deriveComplianceState — rabies state machine", () => {
  const dueAt = new Date("2026-08-01T00:00:00Z");
  // A verified rabies dose so the "Vigente" (ok) branch is backed (H1).
  const verifiedDose = vaccination("Antirrábica", "2026-08-01T00:00:00Z", VET);

  it("reserved turno wins over everything else", () => {
    const state = deriveComplianceState(
      baseInput({
        rabiesReminder: { variant: "overdue", dueAt },
        reservedRabiesTurno: { date: new Date("2026-07-10T00:00:00Z"), provider: "Vet Palermo" },
      }),
    );
    const rabies = state.cards.find((c) => c.key === "rabies");
    expect(rabies?.tone).toBe("reserved");
    expect(rabies?.state).toBe("Turno reservado");
    expect(rabies?.detail).toContain("Vet Palermo");
  });

  it("reserved turno without a provider shows just the date", () => {
    const state = deriveComplianceState(
      baseInput({
        reservedRabiesTurno: { date: new Date("2026-07-10T00:00:00Z"), provider: null },
      }),
    );
    const rabies = state.cards.find((c) => c.key === "rabies");
    expect(rabies?.tone).toBe("reserved");
    expect(rabies?.detail).not.toContain("·");
  });

  it("maps reminder variants to Vigente / Por vencer / Vencida (dose verified)", () => {
    const cases: Array<[ComplianceInput["rabiesReminder"], string, string]> = [
      [{ variant: "upcoming", dueAt }, "Vigente", "ok"],
      [{ variant: "success", dueAt }, "Vigente", "ok"],
      [{ variant: "due_soon", dueAt }, "Por vencer", "due"],
      [{ variant: "overdue", dueAt }, "Vencida", "over"],
      [{ variant: "overdue_critical", dueAt }, "Vencida", "over"],
    ];
    for (const [reminder, expectedState, expectedTone] of cases) {
      const state = deriveComplianceState(
        baseInput({ rabiesReminder: reminder, events: [verifiedDose] }),
      );
      const rabies = state.cards.find((c) => c.key === "rabies");
      expect(rabies?.state, `variant ${reminder?.variant}`).toBe(expectedState);
      expect(rabies?.tone, `variant ${reminder?.variant}`).toBe(expectedTone);
    }
  });

  it("falls back to the latest rabies vaccination event when there is no reminder", () => {
    // Overdue (past next_due) is not gated by provenance — it already signals "not met".
    const past = deriveComplianceState(
      baseInput({ events: [vaccination("Antirrábica", "2026-01-01T00:00:00Z", VET)] }),
    );
    expect(past.cards.find((c) => c.key === "rabies")?.tone).toBe("over");

    // Future next_due with a verified dose → Vigente.
    const future = deriveComplianceState(
      baseInput({ events: [vaccination("Antirrábica", "2027-01-01T00:00:00Z", VET)] }),
    );
    expect(future.cards.find((c) => c.key === "rabies")?.tone).toBe("ok");
  });

  it("ignores non-rabies vaccines in the events fallback", () => {
    const state = deriveComplianceState(
      baseInput({ events: [vaccination("Quíntuple", "2026-01-01T00:00:00Z", VET)] }),
    );
    expect(state.cards.find((c) => c.key === "rabies")?.state).toBe("Sin registro");
  });

  it("reports 'Sin registro' when nothing is known", () => {
    const state = deriveComplianceState(baseInput());
    const rabies = state.cards.find((c) => c.key === "rabies");
    expect(rabies?.state).toBe("Sin registro");
    expect(rabies?.tone).toBe("neutral");
  });

  // UX gate M5a: a recorded antirrábica dose with no next_due_at must NOT read
  // "Sin registro" — that contradicts the libreta asiento the owner can see.
  // task #78 Part 1 / #4: a declared rabies dose is now a DUAL honest card — not
  // a single flat badge. The badge is provenance-forward ("Declarada"), tone
  // neutral (not al-día), and it carries a dual block: what the owner HAS +
  // what the registry NEEDS.
  it("self-reported rabies dose without next_due_at → dual 'Declarada' card, never 'Sin registro'", () => {
    const state = deriveComplianceState(
      baseInput({ events: [vaccination("Antirrábica", null, SELF)] }),
    );
    const rabies = state.cards.find((c) => c.key === "rabies");
    expect(rabies?.state).toBe("Declarada");
    expect(rabies?.tone).toBe("neutral");
    expect(rabies?.detail).toBeTruthy();
    expect(rabies?.dual?.ownerLabel).toContain("cargada por vos");
    // Currency unknown (no next_due_at) → no currency chip.
    expect(rabies?.dual?.currencyLabel).toBeNull();
    expect(rabies?.dual?.registryLine).toBeTruthy();
  });

  it("vet-verified rabies dose without next_due_at → 'Registrada' (ok), never 'Sin registro'", () => {
    const state = deriveComplianceState(
      baseInput({ events: [vaccination("Antirrábica", null, VET)] }),
    );
    const rabies = state.cards.find((c) => c.key === "rabies");
    expect(rabies?.state).toBe("Registrada");
    expect(rabies?.tone).toBe("ok");
  });

  // C5/#1 (external design review, reproduced live): a dose on record with no
  // next_due_at has UNKNOWN currency. The projection already knew that
  // internally; the card did not carry it, so the panel stamped "VIGENTE" over
  // it and the summary counted it as "al día". Both are the project's own
  // stated rule inverted — "'no sabemos' nunca se sella VIGENTE"
  // (LibretaSanitariaView.tsx:127-132, which is why the "SIN DATO" vstamp
  // exists at all).
  it("a dose with no next_due_at reports its currency as UNKNOWN on the card", () => {
    const state = deriveComplianceState(
      baseInput({ events: [vaccination("Antirrábica", null, VET)] }),
    );
    const rabies = state.cards.find((c) => c.key === "rabies");
    expect(rabies?.currencyKnown).toBe(false);
  });

  it("a dose with a real next_due_at reports its currency as KNOWN", () => {
    const state = deriveComplianceState(
      baseInput({ events: [vaccination("Antirrábica", "2027-01-01T00:00:00Z", VET)] }),
    );
    const rabies = state.cards.find((c) => c.key === "rabies");
    expect(rabies?.currencyKnown).toBe(true);
  });

  it("does NOT count an unknown-currency dose as 'al día' in the summary", () => {
    const state = deriveComplianceState(
      baseInput({ events: [vaccination("Antirrábica", null, VET)] }),
    );
    const rabies = state.cards.find((c) => c.key === "rabies");
    // The card still reads "Registrada" — the libreta shows a real asiento and
    // this must never regress to "Sin registro" (UX gate M5a, pinned above).
    expect(rabies?.state).toBe("Registrada");
    // But "registered" is not "current": counting it would make the panel say
    // "N de N al día" beside a card stamped SIN DATO.
    expect(state.summary.ok).toBe(0);
  });
});

// H1 — provenance gates compliance: only professional/institutional events clear.
describe("deriveComplianceState — H1 provenance gate", () => {
  it("self-reported sterilization → 'Declarada', not counted", () => {
    const state = deriveComplianceState(
      baseInput({
        events: [{ eventType: "sterilization_performed", occurredAt: NOW, payload: {}, ...SELF }],
      }),
    );
    const card = state.cards.find((c) => c.key === "sterilization");
    expect(card?.state).toBe("Declarada");
    expect(card?.tone).toBe("neutral");
    expect(card?.hint).toBeTruthy();
    expect(state.summary.ok).toBe(0);
  });

  it("org-registered sterilization (no matrícula) → 'Declarada', NOT counted (#43)", () => {
    const state = deriveComplianceState(
      baseInput({
        events: [{ eventType: "sterilization_performed", occurredAt: NOW, payload: {}, ...ORG }],
      }),
    );
    const card = state.cards.find((c) => c.key === "sterilization");
    expect(card?.state).toBe("Declarada");
    expect(card?.tone).toBe("neutral");
    expect(state.summary.ok).toBe(0);
  });

  it("org-registered rabies dose (no matrícula) → not 'Vigente' (does not satisfy the gate) (#43)", () => {
    const state = deriveComplianceState(
      baseInput({ events: [vaccination("Antirrábica", "2027-01-01T00:00:00Z", ORG)] }),
    );
    const card = state.cards.find((c) => c.key === "rabies");
    // Dual card (declarado tier), NOT counted. An org RECORD is not "cargada por
    // vos" — the dual line says "registrada sin firma de matrícula".
    expect(card?.state).toBe("Declarada");
    expect(card?.tone).toBe("neutral");
    expect(card?.dual?.ownerLabel).toContain("sin firma");
    // Currency IS known (future next_due) → shows the "Vigente" chip.
    expect(card?.dual?.currencyLabel).toBe("Vigente");
    expect(card?.dual?.currencyTone).toBe("ok");
    expect(state.summary.ok).toBe(0);
  });

  it("vet-verified sterilization → 'Verificada' (ok), counted", () => {
    const state = deriveComplianceState(
      baseInput({
        events: [{ eventType: "sterilization_performed", occurredAt: NOW, payload: {}, ...VET }],
      }),
    );
    const card = state.cards.find((c) => c.key === "sterilization");
    expect(card?.state).toBe("Verificada");
    expect(card?.tone).toBe("ok");
    expect(state.summary.ok).toBe(1);
  });

  // Seal/footnote agreement: a declared (unverified) sterilization must NEVER
  // carry a footnote claiming the event is "verificado" — the seal reads
  // "Declarada", so a "Evento verificado en la libreta" footer
  // is a direct self-contradiction (adversarial-citizen 2026-07-06).
  it("self-reported sterilization footnote never claims 'verificado'", () => {
    const state = deriveComplianceState(
      baseInput({
        events: [{ eventType: "sterilization_performed", occurredAt: NOW, payload: {}, ...SELF }],
      }),
    );
    const card = state.cards.find((c) => c.key === "sterilization");
    expect(card?.state).toBe("Declarada");
    expect(card?.legalFootnote).not.toMatch(/verificad/i);
    expect(card?.legalFootnote).toBe("Declarado por el titular, sin verificación profesional");
  });

  it("vet-verified sterilization footnote says 'verificado en la libreta'", () => {
    const state = deriveComplianceState(
      baseInput({
        events: [{ eventType: "sterilization_performed", occurredAt: NOW, payload: {}, ...VET }],
      }),
    );
    const card = state.cards.find((c) => c.key === "sterilization");
    expect(card?.state).toBe("Verificada");
    expect(card?.legalFootnote).toBe("Evento verificado en la libreta");
  });

  it("sterilization with no record has a footnote that does not claim 'verificado'", () => {
    const state = deriveComplianceState(baseInput());
    const card = state.cards.find((c) => c.key === "sterilization");
    expect(card?.state).toBe("Sin registro");
    expect(card?.legalFootnote).not.toMatch(/verificad/i);
  });

  it("rabies currency from a self-reported dose → dual 'Declarada' card (not Vigente), keeps currency", () => {
    const state = deriveComplianceState(
      baseInput({ events: [vaccination("Antirrábica", "2027-01-01T00:00:00Z", SELF)] }),
    );
    const card = state.cards.find((c) => c.key === "rabies");
    expect(card?.state).toBe("Declarada");
    expect(card?.tone).toBe("neutral");
    // Dual: the owner's dose IS vigente (currency lens) even though it does not
    // count as "al día" (compliance lens) — both truths surfaced at once (#4).
    expect(card?.dual?.currencyLabel).toBe("Vigente");
    expect(card?.dual?.ownerLabel).toContain("cargada por vos");
  });

  it("a dose declared by a PREVIOUS titular is never 'cargada por vos' for the new one", () => {
    const state = deriveComplianceState(
      baseInput({
        events: [vaccination("Antirrábica", "2027-01-01T00:00:00Z", SELF)],
        viewerUserId: "user-someone-else",
      }),
    );
    const card = state.cards.find((c) => c.key === "rabies");
    expect(card?.dual?.ownerLabel).not.toContain("vos");
    expect(card?.dual?.ownerLabel).toBe("Antirrábica cargada por el titular");
    // Only the authorship claim moves — the dose is still declared, still
    // vigente, and still needs a matrícula.
    expect(card?.dual?.currencyLabel).toBe("Vigente");
    expect(card?.state).toBe("Declarada");
    // Keeps the due-date detail.
    expect(card?.detail).toBeTruthy();
  });

  it("declared rabies dose that is EXPIRED keeps its 'Vencida' urgency (provenance never hides an expiry)", () => {
    const state = deriveComplianceState(
      baseInput({ events: [vaccination("Antirrábica", "2026-01-01T00:00:00Z", SELF)] }),
    );
    const card = state.cards.find((c) => c.key === "rabies");
    expect(card?.state).toBe("Vencida");
    expect(card?.tone).toBe("over");
    expect(card?.dual?.currencyLabel).toBe("Vencida");
    expect(card?.dual?.currencyTone).toBe("over");
  });

  it("a vet-signed vigente rabies dose reads 'Vigente' (ok), no dual block", () => {
    const state = deriveComplianceState(
      baseInput({ events: [vaccination("Antirrábica", "2027-01-01T00:00:00Z", VET)] }),
    );
    const card = state.cards.find((c) => c.key === "rabies");
    expect(card?.state).toBe("Vigente");
    expect(card?.tone).toBe("ok");
    expect(card?.dual).toBeUndefined();
  });

  it("rabies currency from a professional_verified dose → 'Vigente' (ok)", () => {
    const state = deriveComplianceState(
      baseInput({ events: [vaccination("Antirrábica", "2027-01-01T00:00:00Z", VET)] }),
    );
    const card = state.cards.find((c) => c.key === "rabies");
    expect(card?.state).toBe("Vigente");
    expect(card?.tone).toBe("ok");
  });

  it("microchip code present but implant self-reported → 'Declarado'", () => {
    const state = deriveComplianceState(
      baseInput({
        microchipCode: "982000123456789",
        events: [{ eventType: "microchip_implanted", occurredAt: NOW, payload: {}, ...SELF }],
      }),
    );
    const card = state.cards.find((c) => c.key === "microchip");
    expect(card?.state).toBe("Declarado");
    expect(card?.tone).toBe("neutral");
    expect(card?.detail).toBe("982000123456789");
  });

  // PJ-H1: best-provenance selection, not earliest. Events arrive ascending, so
  // an early owner-declared event used to mask a later vet-VERIFIED one (`find`
  // returned the oldest), leaving the pet non-compliant despite a signed record.
  it("earlier owner-declared THEN later vet-verified sterilization → 'Verificada' (ok), counted", () => {
    const state = deriveComplianceState(
      baseInput({
        events: [
          {
            eventType: "sterilization_performed",
            occurredAt: "2026-01-01T00:00:00Z",
            payload: {},
            ...SELF,
          },
          {
            eventType: "sterilization_performed",
            occurredAt: "2026-06-01T00:00:00Z",
            payload: {},
            ...VET,
          },
        ],
      }),
    );
    const card = state.cards.find((c) => c.key === "sterilization");
    expect(card?.state).toBe("Verificada");
    expect(card?.tone).toBe("ok");
    expect(card?.legalFootnote).toBe("Evento verificado en la libreta");
    expect(state.summary.ok).toBeGreaterThanOrEqual(1);
  });

  it("earlier owner-declared THEN later vet-verified microchip implant → 'Verificado' (ok), counted", () => {
    const state = deriveComplianceState(
      baseInput({
        microchipCode: "982000123456789",
        events: [
          {
            eventType: "microchip_implanted",
            occurredAt: "2026-01-01T00:00:00Z",
            payload: {},
            ...SELF,
          },
          {
            eventType: "microchip_implanted",
            occurredAt: "2026-06-01T00:00:00Z",
            payload: {},
            ...VET,
          },
        ],
      }),
    );
    const card = state.cards.find((c) => c.key === "microchip");
    expect(card?.state).toBe("Verificado");
    expect(card?.tone).toBe("ok");
  });
});

describe("deriveComplianceState — PJ-M3 timezone boundary on rabies expiry", () => {
  // A date-only next_due_at ("2026-08-01") is midnight UTC = 2026-07-31 21:00 AR.
  // `now` is 2026-08-01T01:00:00Z = 2026-07-31 22:00 AR — the AR due day (Aug 1)
  // has NOT arrived yet. Pre-fix (`new Date(nextDue)`) reads midnight-UTC <= now
  // → Vencida a day early; anchoring at noon UTC keeps it Vigente.
  it("date-only next_due_at is not read Vencida before the AR due day", () => {
    const now = new Date("2026-08-01T01:00:00Z");
    const state = deriveComplianceState(
      baseInput({
        now,
        events: [vaccination("Antirrábica", "2026-08-01", VET)],
      }),
    );
    const card = state.cards.find((c) => c.key === "rabies");
    expect(card?.state).toBe("Vigente");
    expect(card?.tone).toBe("ok");
  });
});

describe("deriveComplianceState — sterilization, microchip, PPP", () => {
  it("sterilization: verified event → ok, none → neutral", () => {
    const without = deriveComplianceState(baseInput());
    expect(without.cards.find((c) => c.key === "sterilization")?.tone).toBe("neutral");

    const withEvent = deriveComplianceState(
      baseInput({
        events: [{ eventType: "sterilization_performed", occurredAt: NOW, payload: {}, ...VET }],
      }),
    );
    expect(withEvent.cards.find((c) => c.key === "sterilization")?.tone).toBe("ok");
  });

  it("microchip: verified implant → ok with the code detail", () => {
    const state = deriveComplianceState(
      baseInput({
        microchipCode: "982000123456789",
        events: [{ eventType: "microchip_implanted", occurredAt: NOW, payload: {}, ...VET }],
      }),
    );
    const chip = state.cards.find((c) => c.key === "microchip");
    expect(chip?.tone).toBe("ok");
    expect(chip?.detail).toBe("982000123456789");
  });

  it("microchip: code alone with no implant event → declared, not verified", () => {
    const state = deriveComplianceState(baseInput({ microchipCode: "982000123456789" }));
    const chip = state.cards.find((c) => c.key === "microchip");
    expect(chip?.tone).toBe("neutral");
    expect(chip?.state).toBe("Declarado");
  });

  it("microchip: no code and no event → 'Sin registro'", () => {
    const state = deriveComplianceState(baseInput());
    const chip = state.cards.find((c) => c.key === "microchip");
    expect(chip?.tone).toBe("neutral");
    expect(chip?.state).toBe("Sin registro");
  });

  it("PPP is 'Atestación requerida' (due) until a dangerous_breed_attested event exists", () => {
    const pending = deriveComplianceState(baseInput({ pppApplies: true }));
    const card = pending.cards.find((c) => c.key === "ppp");
    expect(card?.tone).toBe("due");
    expect(card?.state).toBe("Atestación requerida");
  });

  // T4-I1 / #753. The card used to stamp `ok` on the mere EXISTENCE of an
  // attestation, so a bare assertion nobody could check read exactly like an
  // inscription an authority could verify. The cases below are the whole rule;
  // lib/domain/ppp-attestation.ts argues why it is not the H1 gate.
  it("an attestation citing the registry number is 'Atestada' (ok)", () => {
    const state = deriveComplianceState(
      baseInput({
        pppApplies: true,
        events: [
          {
            eventType: "dangerous_breed_attested",
            occurredAt: NOW,
            payload: { registry: "caba_4078", registry_id: "RUPPPA-12345" },
            authorRole: "owner",
            authorVerified: false,
          },
        ],
      }),
    );
    const card = state.cards.find((c) => c.key === "ppp");
    expect(card?.state).toBe("Atestada");
    expect(card?.tone).toBe("ok");
  });

  it("an attestation with no number and no institution is 'Declarada', not 'ok'", () => {
    const state = deriveComplianceState(
      baseInput({
        pppApplies: true,
        events: [
          {
            eventType: "dangerous_breed_attested",
            occurredAt: NOW,
            payload: { registry: "caba_4078", registry_id: null },
            authorRole: "owner",
            authorVerified: false,
          },
        ],
      }),
    );
    const card = state.cards.find((c) => c.key === "ppp");
    expect(card?.state).toBe("Declarada");
    expect(card?.tone).toBe("neutral");
    // NOT re-offering the register door: "Atestación requerida" is what
    // ComplianceObligationsPanel matches on to draw it, and this owner already
    // attested. The hint names the number instead.
    expect(card?.hint).toContain("número de inscripción");
    expect(state.summary.ok).toBe(0);
  });

  it("a verified govt actor's attestation is 'Atestada' even with no number", () => {
    const state = deriveComplianceState(
      baseInput({
        pppApplies: true,
        events: [
          {
            eventType: "dangerous_breed_attested",
            occurredAt: NOW,
            payload: { registry: "caba_4078", registry_id: null },
            authorRole: "govt",
            authorVerified: true,
          },
        ],
      }),
    );
    const card = state.cards.find((c) => c.key === "ppp");
    expect(card?.state).toBe("Atestada");
    expect(card?.tone).toBe("ok");
  });

  it("best-evidence selection: a later numbered attestation clears an earlier bare one", () => {
    const state = deriveComplianceState(
      baseInput({
        pppApplies: true,
        events: [
          {
            eventType: "dangerous_breed_attested",
            occurredAt: new Date("2024-01-01T12:00:00Z"),
            payload: { registry: "caba_4078", registry_id: null },
            authorRole: "owner",
            authorVerified: false,
          },
          {
            eventType: "dangerous_breed_attested",
            occurredAt: NOW,
            payload: { registry: "caba_4078", registry_id: "RUPPPA-12345" },
            authorRole: "owner",
            authorVerified: false,
          },
        ],
      }),
    );
    expect(state.cards.find((c) => c.key === "ppp")?.tone).toBe("ok");
  });
});

// PPP indeterminado (2026-07-04): a DOG missing breed and/or weight surfaces the
// obligation instead of hiding it. Strong-but-optional — alta is never blocked.
describe("deriveComplianceState — PPP indeterminado (dog missing breed/weight)", () => {
  it("dog missing both breed and weight → 'Faltan datos' (due), with a nudge", () => {
    const state = deriveComplianceState(baseInput({ species: "dog" }));
    const ppp = state.cards.find((c) => c.key === "ppp");
    expect(ppp?.state).toBe("Faltan datos");
    expect(ppp?.tone).toBe("due");
    expect(ppp?.hint).toContain("raza y el peso");
    // It counts against "al día" — never silently satisfied.
    expect(state.summary.total).toBe(4);
    expect(state.summary.ok).toBe(0);
  });

  it("marks the card dataUnknown so no summary stamp says 'por vencer' over it", () => {
    // S2-F06 (2026-08-08): the tone is `due` on purpose — it ranks the card
    // first and keeps it out of the "al día" count — but the credential stamp
    // rendered `due`'s word and told the reader something was expiring on a pet
    // that has no dates at all. The tone ranks; dataUnknown says what KIND.
    const state = deriveComplianceState(baseInput({ species: "dog" }));
    expect(state.cards.find((c) => c.key === "ppp")?.dataUnknown).toBe(true);
    expect(state.worstTone).toBe("due");
    expect(state.worstIsUnknown).toBe(true);
  });

  it("stops being the unknown case as soon as something genuinely dated outranks it", () => {
    // Non-vacuity in the direction that matters: worstIsUnknown must not become
    // a permanent flag on every dog. An overdue rabies dose sorts ahead of the
    // PPP card, and the stamp has to go back to speaking about time.
    const state = deriveComplianceState(
      baseInput({
        species: "dog",
        events: [vaccination("Antirrábica", "2026-01-01T00:00:00Z", VET)],
      }),
    );
    expect(state.worstTone).toBe("over");
    expect(state.worstIsUnknown).toBe(false);
  });

  it("dog with a breed but no weight → hint names ONLY the weight, never the breed (C1)", () => {
    // Adversarial-citizen C1 (2026-07-06): a Boxer (breed visible in the header)
    // with no weight must NOT read "completá la raza" — that contradicts the
    // shown breed. The seal names exactly what's missing: the weight.
    const state = deriveComplianceState(baseInput({ species: "dog", breed: "Boxer" }));
    const ppp = state.cards.find((c) => c.key === "ppp");
    expect(ppp?.state).toBe("Faltan datos");
    expect(ppp?.hint).toContain("el peso");
    expect(ppp?.hint).not.toContain("la raza");
  });

  it("dog with a weight but no breed → hint names ONLY the breed, never the weight", () => {
    const state = deriveComplianceState(baseInput({ species: "dog", estimatedWeightKg: "12.5" }));
    const ppp = state.cards.find((c) => c.key === "ppp");
    expect(ppp?.state).toBe("Faltan datos");
    expect(ppp?.hint).toContain("la raza");
    expect(ppp?.hint).not.toContain("el peso");
  });

  it("blank breed and zero weight are treated as missing", () => {
    const state = deriveComplianceState(
      baseInput({ species: "dog", breed: "   ", estimatedWeightKg: 0 }),
    );
    expect(state.cards.find((c) => c.key === "ppp")?.tone).toBe("due");
  });

  it("dog with breed AND weight but not flagged PPP → no PPP card (genuinely non-PPP)", () => {
    const state = deriveComplianceState(
      baseInput({ species: "dog", breed: "Beagle", estimatedWeightKg: 12, pppApplies: false }),
    );
    expect(state.cards.some((c) => c.key === "ppp")).toBe(false);
    expect(state.summary.total).toBe(3);
  });

  it("dog with a PPP breed (flagged) → attestation card, even if weight is absent", () => {
    const state = deriveComplianceState(
      baseInput({ species: "dog", breed: "Dogo Argentino", pppApplies: true }),
    );
    const ppp = state.cards.find((c) => c.key === "ppp");
    expect(ppp?.label).toBe("Atestación PPP");
    expect(ppp?.state).toBe("Atestación requerida");
    expect(ppp?.tone).toBe("due");
  });

  it("cat is never PPP — no card regardless of missing breed/weight", () => {
    const state = deriveComplianceState(baseInput({ species: "cat" }));
    expect(state.cards.some((c) => c.key === "ppp")).toBe(false);
  });

  it("other species (rabbit) is never PPP — no card", () => {
    const state = deriveComplianceState(baseInput({ species: "rabbit" }));
    expect(state.cards.some((c) => c.key === "ppp")).toBe(false);
  });
});

describe("deriveComplianceState — ordering + summary", () => {
  it("orders cards worst-state first", () => {
    const state = deriveComplianceState(
      baseInput({
        rabiesReminder: { variant: "overdue", dueAt: new Date("2026-06-01T00:00:00Z") },
        microchipCode: "982000123456789",
        events: [{ eventType: "sterilization_performed", occurredAt: NOW, payload: {}, ...VET }],
      }),
    );
    // Rabies (over) must be first.
    expect(state.cards[0].key).toBe("rabies");
    expect(state.cards[0].tone).toBe("over");
  });

  it("summarizes how many obligations are al día (verified only)", () => {
    const state = deriveComplianceState(
      baseInput({
        rabiesReminder: { variant: "upcoming", dueAt: new Date("2026-08-01T00:00:00Z") },
        events: [
          vaccination("Antirrábica", "2026-08-01T00:00:00Z", VET), // backs Vigente → ok
          { eventType: "microchip_implanted", occurredAt: NOW, payload: {}, ...VET }, // ok
        ],
        microchipCode: "982000123456789",
        // sterilization missing → neutral
      }),
    );
    expect(state.summary).toEqual({ total: 3, ok: 2, label: "2 de 3 al día" });
    expect(state.worstTone).toBe("neutral");
  });
});

describe("microchipHeroTag — hero tag agrees with the compliance card (H1 display contradiction fix)", () => {
  it("verified implant → 'Microchip verificado', same tier that flips the card to ok", () => {
    const state = deriveComplianceState(
      baseInput({
        microchipCode: "982000123456789",
        events: [{ eventType: "microchip_implanted", occurredAt: NOW, payload: {}, ...VET }],
      }),
    );
    expect(state.cards.find((c) => c.key === "microchip")?.tone).toBe("ok");
    expect(microchipHeroTag(state)).toBe("Microchip verificado");
  });

  it("self-reported code/event → 'Microchip declarado', never 'verificado' (the exact bug: hero said verificado while the card said Declarado)", () => {
    const state = deriveComplianceState(baseInput({ microchipCode: "982000123456789" }));
    expect(state.cards.find((c) => c.key === "microchip")?.state).toBe("Declarado");
    expect(microchipHeroTag(state)).toBe("Microchip declarado");
  });

  it("no code and no event → no hero tag at all (matches the card's 'Sin registro')", () => {
    const state = deriveComplianceState(baseInput());
    expect(state.cards.find((c) => c.key === "microchip")?.state).toBe("Sin registro");
    expect(microchipHeroTag(state)).toBeNull();
  });
});

describe("lnPetStatusFromCompliance — the single chip mapper (QA round 2 #4)", () => {
  const notCompliant = deriveComplianceState(baseInput()); // 0 de 3 al día
  const fullyCompliant = deriveComplianceState(
    baseInput({
      rabiesReminder: { variant: "upcoming", dueAt: new Date("2026-08-01T00:00:00Z") },
      events: [
        vaccination("Antirrábica", "2026-08-01T00:00:00Z", VET),
        { eventType: "microchip_implanted", occurredAt: NOW, payload: {}, ...VET },
        { eventType: "sterilization_performed", occurredAt: NOW, payload: {}, ...VET },
      ],
    }),
  );

  it("a fresh 0/3 pet is registered, never ok (AL DÍA)", () => {
    expect(
      lnPetStatusFromCompliance({ status: "active", pregnancyStatus: null }, notCompliant),
    ).toBe("registered");
  });

  it("only full verified compliance earns ok", () => {
    expect(fullyCompliant.summary.ok).toBe(fullyCompliant.summary.total);
    expect(
      lnPetStatusFromCompliance({ status: "active", pregnancyStatus: null }, fullyCompliant),
    ).toBe("ok");
  });

  it("lost and pregnancy override compliance", () => {
    expect(
      lnPetStatusFromCompliance({ status: "lost", pregnancyStatus: null }, fullyCompliant),
    ).toBe("lost");
    expect(
      lnPetStatusFromCompliance(
        { status: "active", pregnancyStatus: "in_progress" },
        fullyCompliant,
      ),
    ).toBe("pregnant");
  });

  // PJ-M1: a deceased pet is a closed life record — it must map to the memorial
  // state, NOT "ok" (AL DÍA), even when every obligation is satisfied.
  it("a deceased fully-compliant pet maps to 'deceased', never 'ok'", () => {
    expect(
      lnPetStatusFromCompliance({ status: "deceased", pregnancyStatus: null }, fullyCompliant),
    ).toBe("deceased");
  });

  it("deceased takes precedence over pregnancy (matching PetCard.helpers: lost > deceased)", () => {
    expect(
      lnPetStatusFromCompliance(
        { status: "deceased", pregnancyStatus: "in_progress" },
        fullyCompliant,
      ),
    ).toBe("deceased");
  });
});

describe("deriveMicrochip — jurisdiction applicability gate (microchip_required rule)", () => {
  it("default (microchipApplies undefined) keeps the obligation card — non-breaking", () => {
    const { cards } = deriveComplianceState(baseInput());
    const chip = cards.find((c) => c.key === "microchip");
    expect(chip?.state).toBe("Sin registro");
  });

  it("microchipApplies:true + no chip → 'Sin registro' obligation card (in N de M)", () => {
    const state = deriveComplianceState(baseInput({ microchipApplies: true }));
    const chip = state.cards.find((c) => c.key === "microchip");
    expect(chip?.state).toBe("Sin registro");
    expect(state.summary.total).toBe(3);
  });

  it("microchipApplies:false + no chip → NO card, and the M in N de M shrinks", () => {
    const state = deriveComplianceState(baseInput({ microchipApplies: false }));
    expect(state.cards.some((c) => c.key === "microchip")).toBe(false);
    // rabies + sterilization only.
    expect(state.summary.total).toBe(2);
  });

  it("microchipApplies:false but a chip IS registered (declared) → card still shows as information", () => {
    const state = deriveComplianceState(
      baseInput({ microchipApplies: false, microchipCode: "982000123456789" }),
    );
    const chip = state.cards.find((c) => c.key === "microchip");
    expect(chip).toBeDefined();
    expect(chip?.state).toBe("Declarado");
    expect(chip?.detail).toBe("982000123456789");
  });

  it("microchipApplies:false but a VERIFIED implant exists → card shows as ok/informational", () => {
    const state = deriveComplianceState(
      baseInput({
        microchipApplies: false,
        microchipCode: "982000123456789",
        events: [{ eventType: "microchip_implanted", occurredAt: NOW, payload: {}, ...VET }],
      }),
    );
    const chip = state.cards.find((c) => c.key === "microchip");
    expect(chip?.state).toBe("Verificado");
    expect(chip?.tone).toBe("ok");
  });

  it("uses a neutral, non-CABA-specific legal footnote", () => {
    const state = deriveComplianceState(baseInput({ microchipApplies: true }));
    const chip = state.cards.find((c) => c.key === "microchip");
    expect(chip?.legalFootnote).not.toMatch(/CABA/);
  });
});

// ---------------------------------------------------------------------------
// Jurisdiction-tiered obligations (spec CS1-CS6, WU3)
// ---------------------------------------------------------------------------

const RULE_MANDATORY: ComplianceObligationRule = {
  requirementLevel: "mandatory",
  legalBasis: null,
  authority: null,
  sourceUrl: null,
};

function obligations(
  overrides: Partial<Record<keyof ComplianceObligations, Partial<ComplianceObligationRule>>> = {},
): ComplianceObligations {
  return {
    rabies: { ...RULE_MANDATORY, ...overrides.rabies },
    sterilization: { ...RULE_MANDATORY, ...overrides.sterilization },
    microchip: { ...RULE_MANDATORY, ...overrides.microchip },
  };
}

describe("deriveComplianceState — obligations tier table (CS2/CS3/CS4)", () => {
  // An OVERDUE verified rabies dose: under `mandatory` this must scream red;
  // under `recommended` the same facts must never wear overdue styling.
  const overdueRabies = baseInput({
    events: [vaccination("Antirrábica", "2026-06-01", VET)],
  });

  it("mandatory keeps the existing urgency — an expired dose stays tone 'over' and counted", () => {
    const state = deriveComplianceState({ ...overdueRabies, obligations: obligations() });
    const rabies = state.cards.find((c) => c.key === "rabies");
    expect(rabies?.tone).toBe("over");
    expect(rabies?.requirementTier).toBeUndefined();
    expect(state.summary.total).toBe(3); // rabies + sterilization + microchip
  });

  it("recommended never renders 'vencida'/overdue styling and leaves the N-de-M count", () => {
    const state = deriveComplianceState({
      ...overdueRabies,
      obligations: obligations({ rabies: { requirementLevel: "recommended" } }),
    });
    const rabies = state.cards.find((c) => c.key === "rabies");
    expect(rabies).toBeDefined();
    expect(rabies?.tone).not.toBe("over");
    expect(rabies?.tone).not.toBe("due");
    expect(rabies?.requirementTier).toBe("recommended");
    // Excluded from M: only sterilization + microchip count.
    expect(state.summary.total).toBe(2);
  });

  it("not_regulated with data on record renders informational, never in the percentage", () => {
    const state = deriveComplianceState(
      baseInput({
        microchipCode: "982000123456789",
        obligations: obligations({ microchip: { requirementLevel: "not_regulated" } }),
      }),
    );
    const chip = state.cards.find((c) => c.key === "microchip");
    expect(chip).toBeDefined(); // a registered chip is information
    expect(chip?.requirementTier).toBe("not_regulated");
    expect(chip?.tone).not.toBe("over");
    expect(chip?.tone).not.toBe("due");
    expect(chip?.hint).toBeFalsy(); // no "para que cuente" nudge — nothing counts
    expect(state.summary.total).toBe(2); // rabies + sterilization only
  });

  it("not_regulated with nothing on record omits the card entirely", () => {
    const state = deriveComplianceState(
      baseInput({
        obligations: obligations({
          sterilization: { requirementLevel: "not_regulated" },
          microchip: { requirementLevel: "not_regulated" },
        }),
      }),
    );
    expect(state.cards.some((c) => c.key === "sterilization")).toBe(false);
    expect(state.cards.some((c) => c.key === "microchip")).toBe(false);
    expect(state.summary.total).toBe(1); // rabies only
  });

  it("recommended with nothing on record keeps a softer 'Sin registro' card, uncounted", () => {
    const state = deriveComplianceState(
      baseInput({
        obligations: obligations({ sterilization: { requirementLevel: "recommended" } }),
      }),
    );
    const sterilization = state.cards.find((c) => c.key === "sterilization");
    expect(sterilization?.state).toBe("Sin registro");
    expect(sterilization?.requirementTier).toBe("recommended");
    expect(state.summary.total).toBe(2); // rabies + microchip
  });

  it("N-de-M counts mandatory obligations only, and ok tracks the same subset", () => {
    const state = deriveComplianceState(
      baseInput({
        events: [
          vaccination("Antirrábica", "2027-06-01", VET),
          { eventType: "microchip_implanted", occurredAt: NOW, payload: {}, ...VET },
        ],
        microchipCode: "982000123456789",
        obligations: obligations({ sterilization: { requirementLevel: "recommended" } }),
      }),
    );
    expect(state.summary.total).toBe(2); // rabies + microchip (sterilization recommended)
    expect(state.summary.ok).toBe(2); // vigente verified dose + verified chip
    expect(state.summary.label).toBe("2 de 2 al día");
  });

  it("the header chip reads the worst COUNTED obligation, not an informational card", () => {
    // Verified vigente rabies + verified chip (both ok, counted) + a declared
    // sterilization that is only recommended here (neutral, uncounted). The
    // "2 de 2 al día" badge must not turn neutral because of the uncounted card.
    const state = deriveComplianceState(
      baseInput({
        events: [
          vaccination("Antirrábica", "2027-06-01", VET),
          { eventType: "microchip_implanted", occurredAt: NOW, payload: {}, ...VET },
          { eventType: "sterilization_performed", occurredAt: NOW, payload: {}, ...SELF },
        ],
        microchipCode: "982000123456789",
        obligations: obligations({ sterilization: { requirementLevel: "recommended" } }),
      }),
    );
    expect(state.summary.ok).toBe(state.summary.total);
    expect(state.worstTone).toBe("ok");
  });

  it("is pure — identical resolved inputs produce identical outputs (CS1)", () => {
    const input = {
      ...baseInput({
        events: [vaccination("Antirrábica", "2026-06-01", VET)],
        microchipCode: "982000123456789",
        obligations: obligations({
          microchip: {
            requirementLevel: "mandatory",
            legalBasis: "Ley 22.953",
            authority: "GCBA",
          },
        }),
      }),
    };
    expect(deriveComplianceState(input)).toEqual(deriveComplianceState(input));
  });
});

describe("MN2 scenario fence — no obligation nudge where the tier is not_regulated (WU4a T4.4)", () => {
  // The metrics-spec scenario, pinned at the projection boundary the owner
  // dashboard renders from (fetchComplianceStatesForPets threads `obligations`
  // into THIS derivation — WU3 T3.2; the DB threading itself is pinned by
  // __tests__/owner-dashboard-obligations-batch.test.ts): a NON-PPP dog in a
  // jurisdiction where microchip is not mandatory must never see "sin
  // microchip" fire as an obligation nudge — no card, no hint, no count.
  const nonPppDog = baseInput({
    species: "dog",
    breed: "Caniche",
    estimatedWeightKg: 8,
    pppApplies: false,
  });

  it("non-PPP dog, microchip not_regulated, no chip on record → NO microchip nudge anywhere", () => {
    const state = deriveComplianceState({
      ...nonPppDog,
      obligations: obligations({ microchip: { requirementLevel: "not_regulated" } }),
    });
    expect(state.cards.some((c) => c.key === "microchip")).toBe(false);
    // Belt-and-braces: no OTHER card smuggles the microchip nudge in as copy.
    const serialized = JSON.stringify(state.cards).toLowerCase();
    expect(serialized).not.toContain("microchip");
    expect(state.summary.total).toBe(2); // rabies + sterilization only
  });

  it("the rabies and sterilization equivalents hold too — nothing not_regulated ever nudges", () => {
    const state = deriveComplianceState({
      ...nonPppDog,
      obligations: obligations({
        rabies: { requirementLevel: "not_regulated" },
        sterilization: { requirementLevel: "not_regulated" },
        microchip: { requirementLevel: "not_regulated" },
      }),
    });
    expect(state.cards.some((c) => c.key === "rabies")).toBe(false);
    expect(state.cards.some((c) => c.key === "sterilization")).toBe(false);
    expect(state.cards.some((c) => c.key === "microchip")).toBe(false);
    expect(state.summary.total).toBe(0);
  });

  // T6 review M5. This scenario used to render "0 de 0 al día" in GREEN on the
  // panel badge, the credential face and the mobile disc — a compliance seal
  // earned by an empty denominator. The LABEL is asserted, not just the count:
  // pinning `total: 0` alone is exactly what let the green copy ship.
  it("M = 0 renders honest NEUTRAL copy, never a green '0 de 0 al día'", () => {
    const state = deriveComplianceState({
      ...nonPppDog,
      obligations: obligations({
        rabies: { requirementLevel: "not_regulated" },
        sterilization: { requirementLevel: "recommended" },
        microchip: { requirementLevel: "not_regulated" },
      }),
    });
    expect(state.summary.total).toBe(0);
    expect(state.summary.label).toBe(NO_COUNTED_OBLIGATIONS_LABEL);
    expect(state.summary.label).not.toContain("al día");
    expect(state.worstTone).toBe("neutral");
    expect(state.worstIsUnknown).toBe(false);
  });

  it("an empty denominator is NOT 'al día' on the list chip either (lnPetStatusFromCompliance)", () => {
    const state = deriveComplianceState({
      ...nonPppDog,
      obligations: obligations({
        rabies: { requirementLevel: "not_regulated" },
        sterilization: { requirementLevel: "not_regulated" },
        microchip: { requirementLevel: "not_regulated" },
      }),
    });
    expect(state.summary.total).toBe(0);
    expect(lnPetStatusFromCompliance({ status: "active", pregnancyStatus: null }, state)).toBe(
      "registered",
    );
  });

  // T6 review MINOR 7: `optional` used to fold into the `recommended` bucket,
  // so a merely-permitted rule announced itself as a jurisdictional
  // recommendation. It is a real value of the DB CHECK and keeps its own tier.
  it("an `optional` tier keeps its OWN tier — it does not borrow 'recommended'", () => {
    const state = deriveComplianceState({
      ...nonPppDog,
      obligations: obligations({ sterilization: { requirementLevel: "optional" } }),
    });
    const sterilization = state.cards.find((c) => c.key === "sterilization");
    expect(sterilization?.requirementTier).toBe("optional");
    // Still excluded from M and still softened, exactly like `recommended`.
    expect(state.summary.total).toBe(2);
    expect(sterilization?.tone === "over" || sterilization?.tone === "due").toBe(false);
  });
});

describe("citation composition (CS5/CS6)", () => {
  it("composeLegalCitation joins legalBasis · authority, dropping blanks", () => {
    expect(composeLegalCitation({ legalBasis: "Ley 14.107", authority: "Municipalidad" })).toBe(
      "Ley 14.107 · Municipalidad",
    );
    expect(composeLegalCitation({ legalBasis: "Ley 14.107", authority: null })).toBe("Ley 14.107");
    expect(composeLegalCitation({ legalBasis: null, authority: null })).toBeNull();
    expect(composeLegalCitation(null)).toBeNull();
  });

  it("microchip footnote composes from the resolved row when a citation exists", () => {
    const state = deriveComplianceState(
      baseInput({
        obligations: obligations({
          microchip: { legalBasis: "Ordenanza 999/2026", authority: "Municipalidad de Ushuaia" },
        }),
      }),
    );
    const chip = state.cards.find((c) => c.key === "microchip");
    expect(chip?.legalFootnote).toBe(
      "Identificación · Ordenanza 999/2026 · Municipalidad de Ushuaia",
    );
  });

  it("keeps the generic stopgap when nothing resolves — never invents law", () => {
    const state = deriveComplianceState(baseInput({ obligations: obligations() }));
    const chip = state.cards.find((c) => c.key === "microchip");
    expect(chip?.legalFootnote).toBe("Identificación · según normativa jurisdiccional");
  });

  it("PPP footnote composes from the resolved ppp rule row", () => {
    const state = deriveComplianceState(
      baseInput({
        pppApplies: true,
        pppRule: { legalBasis: "Ley 14.107", authority: null, sourceUrl: null },
      }),
    );
    const ppp = state.cards.find((c) => c.key === "ppp");
    expect(ppp?.legalFootnote).toBe("Régimen perros potencialmente peligrosos · Ley 14.107");
  });

  it("PPP footnote keeps the generic stopgap without a resolved citation", () => {
    const state = deriveComplianceState(baseInput({ pppApplies: true }));
    const ppp = state.cards.find((c) => c.key === "ppp");
    expect(ppp?.legalFootnote).toBe(
      "Régimen perros potencialmente peligrosos · regla jurisdiccional",
    );
  });

  it("an Ushuaia pet never sees CABA legal text on ANY card — rabies included (CS6, RG1 ratified)", () => {
    // A CABA pet's resolved rules carry the CABA citation; an Ushuaia pet's
    // carry their own (or none). EVERY card must reflect ONLY what resolved —
    // since RG1's ratification (2026-08-16) the rabies footnote composes from
    // the resolved row too, so the old hardcoded CABA ordinance can reach no
    // pet whose own jurisdiction did not resolve it.
    const ushuaia = deriveComplianceState(
      baseInput({
        microchipCode: "982000123456789",
        pppApplies: true,
        obligations: obligations(), // nothing resolved beyond tiers
        pppRule: null,
      }),
    );
    const serialized = JSON.stringify(ushuaia.cards);
    expect(serialized).not.toContain("41.831");
    expect(serialized).not.toContain("22.953");
    expect(serialized).not.toContain("CABA");
  });

  it("rabies footnote composes from the resolved rule row (RG1 ratified 2026-08-16)", () => {
    // The CABA baseline row carries the composed national+local citation; a
    // pet resolving it sees BOTH laws — sourced from the row, not a constant.
    const state = deriveComplianceState(
      baseInput({
        obligations: obligations({
          rabies: { legalBasis: "Ley 22.953 · Ord. CABA 41.831", authority: null },
        }),
      }),
    );
    const rabies = state.cards.find((c) => c.key === "rabies");
    expect(rabies?.legalFootnote).toBe(
      "Obligación del propietario · Ley 22.953 · Ord. CABA 41.831",
    );
  });

  it("rabies footnote keeps the generic stopgap when nothing resolves — never invents law", () => {
    const state = deriveComplianceState(baseInput({ obligations: obligations() }));
    const rabies = state.cards.find((c) => c.key === "rabies");
    expect(rabies?.legalFootnote).toBe(
      "Obligación del propietario · según normativa jurisdiccional",
    );
  });
});

// ---------------------------------------------------------------------------
// T1-G1 — the jurisdiction's rule FIELDS are computed, not only displayed.
// Every test here holds the pet and its events fixed and moves ONLY the rule
// parameters, so the verdict it observes can only have come from the rule.
// ---------------------------------------------------------------------------

describe("T1-G1 — rule fields drive the compliance verdict", () => {
  type Params = NonNullable<ComplianceInput["ruleParams"]>;
  function params(
    over: {
      rabies?: Partial<Params["rabies"]>;
      sterilization?: Partial<Params["sterilization"]>;
    } = {},
  ): Params {
    return {
      rabies: { frequencyMonths: null, minAgeMonths: null, ...over.rabies },
      sterilization: { minAgeMonths: null, mandatoryFromMonths: null, ...over.sterilization },
    };
  }
  const card = (s: ReturnType<typeof deriveComplianceState>, key: string) =>
    s.cards.find((c) => c.key === key);

  // A vet-SIGNED rabies dose applied 15/09/2025 (AR) that carries NO next_due_at.
  const signedDoseNoDue: ComplianceEvent = {
    eventType: "vaccination_administered",
    occurredAt: "2025-09-15T15:00:00Z",
    payload: { vaccine_name: "Antirrábica", next_due_at: null },
    ...VET,
  };

  it("the SAME dose moves from a suggested booster to a lapsed suggestion by changing only frequency_months", () => {
    const events = [signedDoseNoDue];
    // 12 months → suggested 15/09/2026, after NOW (01/07/2026).
    const annual = card(
      deriveComplianceState(
        baseInput({ events, ruleParams: params({ rabies: { frequencyMonths: 12 } }) }),
      ),
      "rabies",
    );
    expect(annual?.dueSource).toBe("rule");
    expect(annual?.state).toBe("Refuerzo sugerido");
    expect(annual?.tone).toBe("neutral");
    expect(annual?.currencyKnown).toBe(false);
    expect(annual?.currencyUntil).toBeNull();
    expect(annual?.detail).toBe("Aplicada 15/09/2025 · refuerzo sugerido: 15/09");
    expect(annual?.legalFootnote).toBe(
      "Fecha calculada con la frecuencia de refuerzo que configuró tu jurisdicción (cada 12 meses); no la fijó un veterinario.",
    );

    // 6 months → suggested 15/03/2026, before NOW: a warning, never the red "Vencida".
    const semiannual = card(
      deriveComplianceState(
        baseInput({ events, ruleParams: params({ rabies: { frequencyMonths: 6 } }) }),
      ),
      "rabies",
    );
    expect(semiannual?.dueSource).toBe("rule");
    expect(semiannual?.state).toBe("Refuerzo sugerido vencido");
    expect(semiannual?.tone).toBe("due");
    expect(semiannual?.detail).toBe("Aplicada 15/09/2025 · refuerzo sugerido vencido el 15/03");
    expect(semiannual?.legalFootnote).toBe(
      "Fecha calculada con la frecuencia de refuerzo que configuró tu jurisdicción (cada 6 meses); no la fijó un veterinario.",
    );
  });

  it("the same dose WITH the vet's next_due_at keeps the strong states and the legal citation", () => {
    const cited = obligations({
      rabies: { legalBasis: "Ley 22.953", authority: "Ministerio de Salud" },
    });
    const withDue = (nextDueAt: string): ComplianceEvent => ({
      ...signedDoseNoDue,
      payload: { vaccine_name: "Antirrábica", next_due_at: nextDueAt },
    });
    const ruleParams = params({ rabies: { frequencyMonths: 12 } });

    const lapsed = card(
      deriveComplianceState(
        baseInput({ events: [withDue("2026-03-15")], ruleParams, obligations: cited }),
      ),
      "rabies",
    );
    expect(lapsed?.dueSource).toBe("dose");
    expect(lapsed?.state).toBe("Vencida");
    expect(lapsed?.tone).toBe("over");
    expect(lapsed?.detail).toBe("Venció 15/03");
    expect(lapsed?.legalFootnote).toBe(
      "Obligación del propietario · Ley 22.953 · Ministerio de Salud",
    );

    const current = card(
      deriveComplianceState(
        baseInput({ events: [withDue("2026-09-15")], ruleParams, obligations: cited }),
      ),
      "rabies",
    );
    expect(current?.dueSource).toBe("dose");
    expect(current?.state).toBe("Vigente");
    expect(current?.tone).toBe("ok");
    expect(current?.currencyKnown).toBe(true);

    // The SAME cited jurisdiction, the date derived instead: no citation next to it.
    const derived = card(
      deriveComplianceState(
        baseInput({ events: [signedDoseNoDue], ruleParams, obligations: cited }),
      ),
      "rabies",
    );
    expect(derived?.dueSource).toBe("rule");
    expect(derived?.legalFootnote).toBe(
      "Fecha calculada con la frecuencia de refuerzo que configuró tu jurisdicción (cada 12 meses); no la fijó un veterinario.",
    );
  });

  // D5 (PO 2026-09-18): a cadence whose OWN norm the rule row cites is a legal
  // deadline — the same dose, the same frequency, only the cadence citation
  // moves, and the card goes from suggestion to obligation.
  it("a SOURCED cadence (frequency_legal_basis) dates the dose as an obligation, cited and counted", () => {
    const cited = obligations({
      rabies: { legalBasis: "Ley Nacional Antirrábica", authority: "Autoridad Local" },
    });
    const sourced = (frequencyMonths: number) =>
      params({ rabies: { frequencyMonths, frequencyLegalBasis: "Resolución de Cadencia" } });

    // 12 months → 15/09/2026, after NOW (01/07/2026): Vigente, counted al día.
    const upcoming = deriveComplianceState(
      baseInput({ events: [signedDoseNoDue], ruleParams: sourced(12), obligations: cited }),
    );
    const annual = card(upcoming, "rabies");
    expect(annual?.dueSource).toBe("legal_cadence");
    expect(annual?.state).toBe("Vigente");
    expect(annual?.tone).toBe("ok");
    expect(annual?.currencyKnown).toBe(true);
    expect(annual?.currencyUntil).toBe("15/09");
    expect(annual?.detail).toBe("Próxima 15/09");
    expect(annual?.legalFootnote).toBe(
      "Obligación del propietario · Ley Nacional Antirrábica · Autoridad Local · refuerzo cada 12 meses según Resolución de Cadencia",
    );
    expect(upcoming.summary.ok).toBe(1);
    expect(upcoming.worstIsUnknown).toBe(false);

    // 6 months → 15/03/2026, before NOW: the red "Vencida", not a warning.
    const lapsedState = deriveComplianceState(
      baseInput({ events: [signedDoseNoDue], ruleParams: sourced(6), obligations: cited }),
    );
    const lapsed = card(lapsedState, "rabies");
    expect(lapsed?.dueSource).toBe("legal_cadence");
    expect(lapsed?.state).toBe("Vencida");
    expect(lapsed?.tone).toBe("over");
    expect(lapsed?.detail).toBe("Venció 15/03");
    expect(lapsedState.worstTone).toBe("over");
    expect(lapsedState.worstIsUnknown).toBe(false);
    expect(lapsedState.summary.ok).toBe(0);

    // Without a rule-row citation, the cadence clause still rides the stopgap.
    const uncitedRow = card(
      deriveComplianceState(baseInput({ events: [signedDoseNoDue], ruleParams: sourced(12) })),
      "rabies",
    );
    expect(uncitedRow?.legalFootnote).toBe(
      "Obligación del propietario · según normativa jurisdiccional · refuerzo cada 12 meses según Resolución de Cadencia",
    );

    // Control: the SAME inputs minus the cadence citation (blank counts as
    // none) stay the suggestion — no other jurisdiction changes behaviour.
    for (const frequencyLegalBasis of [null, "   "]) {
      const unsourced = card(
        deriveComplianceState(
          baseInput({
            events: [signedDoseNoDue],
            ruleParams: params({ rabies: { frequencyMonths: 12, frequencyLegalBasis } }),
            obligations: cited,
          }),
        ),
        "rabies",
      );
      expect(unsourced?.dueSource).toBe("rule");
      expect(unsourced?.state).toBe("Refuerzo sugerido");
    }
  });

  it("a DECLARED dose on a sourced cadence shows its currency in the dual block and does not count", () => {
    const declared: ComplianceEvent = { ...signedDoseNoDue, ...SELF };
    const state = deriveComplianceState(
      baseInput({
        events: [declared],
        ruleParams: params({ rabies: { frequencyMonths: 6, frequencyLegalBasis: "Resolución" } }),
      }),
    );
    const rabies = card(state, "rabies");
    expect(rabies?.dueSource).toBe("legal_cadence");
    expect(rabies?.state).toBe("Vencida");
    expect(rabies?.dual?.currencyLabel).toBe("Vencida");
    expect(state.summary.ok).toBe(0);
  });

  it("a rule-derived date never counts as al día, in either direction, and never stamps a temporal word", () => {
    const upcoming = deriveComplianceState(
      baseInput({
        events: [signedDoseNoDue],
        ruleParams: params({ rabies: { frequencyMonths: 12 } }),
      }),
    );
    expect(upcoming.summary.label).toBe("0 de 3 al día");

    const lapsed = deriveComplianceState(
      baseInput({
        events: [signedDoseNoDue],
        ruleParams: params({ rabies: { frequencyMonths: 6 } }),
      }),
    );
    expect(lapsed.summary.label).toBe("0 de 3 al día");
    // The lapsed suggestion ranks first (tone due) but the summary stamp must
    // read SIN DATO, not the "POR VENCER" of a real deadline.
    expect(lapsed.cards[0]?.key).toBe("rabies");
    expect(lapsed.worstTone).toBe("due");
    expect(lapsed.worstIsUnknown).toBe(true);

    // Control: the vet's own date in the future DOES count, and is not unknown.
    const dated = deriveComplianceState(
      baseInput({
        events: [
          {
            ...signedDoseNoDue,
            payload: { vaccine_name: "Antirrábica", next_due_at: "2026-09-15" },
          },
        ],
        ruleParams: params({ rabies: { frequencyMonths: 12 } }),
      }),
    );
    expect(dated.summary.label).toBe("1 de 3 al día");
  });

  it("a DECLARED dose with an upcoming rule date keeps its provenance pill", () => {
    const declared: ComplianceEvent = { ...signedDoseNoDue, ...SELF };
    const rabies = card(
      deriveComplianceState(
        baseInput({
          events: [declared],
          ruleParams: params({ rabies: { frequencyMonths: 12 } }),
        }),
      ),
      "rabies",
    );
    expect(rabies?.dueSource).toBe("rule");
    expect(rabies?.state).toBe("Declarada");
    expect(rabies?.tone).toBe("neutral");
    expect(rabies?.dual?.currencyLabel).toBeNull();
    expect(rabies?.legalFootnote).toBe(
      "Fecha calculada con la frecuencia de refuerzo que configuró tu jurisdicción (cada 12 meses); no la fijó un veterinario.",
    );
  });

  it("a reminder's date is tagged as such", () => {
    const rabies = card(
      deriveComplianceState(
        baseInput({
          events: [signedDoseNoDue],
          rabiesReminder: { variant: "overdue", dueAt: new Date("2026-06-01T12:00:00Z") },
          ruleParams: params({ rabies: { frequencyMonths: 12 } }),
        }),
      ),
      "rabies",
    );
    expect(rabies?.dueSource).toBe("reminder");
    expect(rabies?.state).toBe("Vencida");
  });

  it("with no frequency_months the dose stays 'Registrada' with unknown currency (pre-T1-G1 behavior)", () => {
    const rabies = card(
      deriveComplianceState(baseInput({ events: [signedDoseNoDue], ruleParams: params() })),
      "rabies",
    );
    expect(rabies?.state).toBe("Registrada");
    expect(rabies?.currencyKnown).toBe(false);
  });

  it("an explicit next_due_at stays the override — the rule does not re-date a dose the vet dated", () => {
    const dated = vaccination("Antirrábica", "2027-01-10", VET);
    const rabies = card(
      deriveComplianceState(
        baseInput({ events: [dated], ruleParams: params({ rabies: { frequencyMonths: 1 } }) }),
      ),
      "rabies",
    );
    // occurred 01/01/2026 + 1 month would be long overdue; the vet's date wins.
    expect(rabies?.state).toBe("Vigente");
    expect(rabies?.detail).toBe("Próxima 10/01/2027");
    expect(rabies?.dueSource).toBe("dose");
  });

  it("rabies min_age_months: a puppy under it has nothing missing yet, and is not counted", () => {
    // Born 01/04/2026 → 3 months old at NOW; no dose on record.
    const input = { dateOfBirth: "2026-04-01" };
    const young = deriveComplianceState(
      baseInput({ ...input, ruleParams: params({ rabies: { minAgeMonths: 4 } }) }),
    );
    expect(card(young, "rabies")).toMatchObject({
      state: "Aún no corresponde",
      tone: "neutral",
      detail: "Corresponde desde el 01/08 (a los 4 meses)",
      notYetRequired: true,
    });
    // Legacy card set (rabies, sterilization, microchip): rabies leaves M.
    expect(young.summary.total).toBe(2);

    const old = deriveComplianceState(
      baseInput({ ...input, ruleParams: params({ rabies: { minAgeMonths: 3 } }) }),
    );
    expect(card(old, "rabies")?.state).toBe("Sin registro");
    expect(old.summary.total).toBe(3);
  });

  it("sterilization mandatory_from_months: a pet under it is not 'Sin registro'", () => {
    // Born 01/01/2026 → 6 months old at NOW; nothing recorded.
    const input = { dateOfBirth: "2026-01-01" };
    const young = card(
      deriveComplianceState(
        baseInput({ ...input, ruleParams: params({ sterilization: { mandatoryFromMonths: 12 } }) }),
      ),
      "sterilization",
    );
    expect(young?.state).toBe("Aún no corresponde");
    expect(young?.detail).toBe("Corresponde desde el 01/01/2027 (a los 12 meses)");

    const due = card(
      deriveComplianceState(
        baseInput({ ...input, ruleParams: params({ sterilization: { mandatoryFromMonths: 5 } }) }),
      ),
      "sterilization",
    );
    expect(due?.state).toBe("Sin registro");
  });

  it("sterilization min_age_months: nobody is obliged before the procedure is allowed", () => {
    const input = { dateOfBirth: "2026-01-01" };
    const young = card(
      deriveComplianceState(
        baseInput({ ...input, ruleParams: params({ sterilization: { minAgeMonths: 8 } }) }),
      ),
      "sterilization",
    );
    expect(young?.state).toBe("Aún no corresponde");
    expect(young?.detail).toBe("Corresponde desde el 01/09 (a los 8 meses)");

    const due = card(
      deriveComplianceState(
        baseInput({ ...input, ruleParams: params({ sterilization: { minAgeMonths: 4 } }) }),
      ),
      "sterilization",
    );
    expect(due?.state).toBe("Sin registro");

    // Both set: the LATER age governs.
    const both = card(
      deriveComplianceState(
        baseInput({
          ...input,
          ruleParams: params({ sterilization: { minAgeMonths: 4, mandatoryFromMonths: 9 } }),
        }),
      ),
      "sterilization",
    );
    expect(both?.detail).toBe("Corresponde desde el 01/10 (a los 9 meses)");
  });

  it("an unknown date of birth never exempts a pet on a guess", () => {
    const state = deriveComplianceState(
      baseInput({
        dateOfBirth: null,
        ruleParams: params({
          rabies: { minAgeMonths: 60 },
          sterilization: { mandatoryFromMonths: 120 },
        }),
      }),
    );
    expect(card(state, "rabies")?.state).toBe("Sin registro");
    expect(card(state, "sterilization")?.state).toBe("Sin registro");
  });

  it("a record that exists is shown for what it is, however young the pet", () => {
    const state = deriveComplianceState(
      baseInput({
        dateOfBirth: "2026-04-01",
        events: [
          vaccination("Antirrábica", "2027-04-01", VET),
          { eventType: "sterilization_performed", occurredAt: "2026-06-01", payload: {}, ...VET },
        ],
        ruleParams: params({
          rabies: { minAgeMonths: 12 },
          sterilization: { mandatoryFromMonths: 12 },
        }),
      }),
    );
    expect(card(state, "rabies")?.state).toBe("Vigente");
    expect(card(state, "sterilization")?.state).toBe("Verificada");
  });

  it("a not_regulated tier drops a not-yet card exactly like an empty one", () => {
    const rule: ComplianceObligationRule = {
      requirementLevel: "not_regulated",
      legalBasis: null,
      authority: null,
      sourceUrl: null,
    };
    const state = deriveComplianceState(
      baseInput({
        dateOfBirth: "2026-04-01",
        obligations: { rabies: rule, sterilization: rule, microchip: rule },
        ruleParams: params({ rabies: { minAgeMonths: 12 } }),
      }),
    );
    expect(card(state, "rabies")).toBeUndefined();
  });
});

describe("regression fence — ZERO jurisdiction literals in the compliance module (RG1 ratified)", () => {
  // Scope (WU2 note): data/legal-baseline/ar-v1.ts legitimately carries these
  // literals as dataset CONTENT, so the fence scans ONLY the compliance module
  // (lib/projections + components/pet-profile), excluding test files. Since
  // RG1's ratification (2026-08-16) the old FOOTNOTE.rabies exemption is GONE:
  // every citation composes from the resolved rule row, so ANY occurrence of
  // the CABA literals in module source is a hardcode sneaking back in.
  it("finds NO CABA literal anywhere in the compliance module source", () => {
    const root = process.cwd();
    const dirs = [join(root, "lib", "projections"), join(root, "components", "pet-profile")];
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const file of readdirSync(dir)) {
        if (!/\.(ts|tsx)$/.test(file) || /\.test\./.test(file)) continue;
        const lines = readFileSync(join(dir, file), "utf8").split("\n");
        lines.forEach((line, i) => {
          if (line.includes("41.831") || line.includes("22.953")) {
            offenders.push(`${file}:${i + 1}:${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
