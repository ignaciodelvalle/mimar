// Tests for <CredentialFace> — pet profile two-face redesign (Face 1, 2026-07-01).
//
// Covers the H1 negative case from the spec ("Self-reported event does not
// clear obligation"): a self-reported satisfying event must render "Declarada"
// (tone: neutral), never an "ok"/"Al día" stamp or the "Verificada" seal, via
// the re-hosted ComplianceObligationsPanel. Render via react-dom/server
// → HTML string (same pattern as PetAlertStrip.test.tsx).
//
// The pill WORDS changed in the unified-vocabulary pass (PO 2026-08-06) —
// "Registrada" → "Verificada", "Declarada · sin verificar" → "Declarada" — but
// what these tests defend did not: a declared event must never wear the
// verified seal, and the two states must stay lexically distinguishable.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  type ComplianceEvent,
  type ComplianceInput,
  deriveComplianceState,
} from "@/lib/projections/pet-compliance";
import { CredentialFace, type CredentialFaceProps } from "./CredentialFace";

const NOW = new Date("2026-07-01T12:00:00Z");
const SELF = { authorRole: "owner", authorVerified: false, authorOrganizationId: null };
const VET = { authorRole: "vet", authorVerified: true, authorOrganizationId: null };

function complianceInput(overrides: Partial<ComplianceInput> = {}): ComplianceInput {
  return {
    now: NOW,
    events: [],
    rabiesReminder: null,
    reservedRabiesTurno: null,
    microchipCode: null,
    pppApplies: false,
    ...overrides,
  };
}

function sterilization(prov: Partial<ComplianceEvent>): ComplianceEvent {
  return {
    eventType: "sterilization_performed",
    occurredAt: "2026-01-01T00:00:00Z",
    payload: {},
    ...prov,
  };
}

const baseProps: Omit<CredentialFaceProps, "complianceState"> = {
  heroProps: { name: "Firulais", breed: "Mestizo" },
  credentialUrl: "https://www.mimar.com.ar/p/abc",
  publicHref: "/p/abc",
  petPublicToken: "abc",
};

function render(complianceState: ReturnType<typeof deriveComplianceState>): string {
  return renderToStaticMarkup(<CredentialFace {...baseProps} complianceState={complianceState} />);
}

/** The QR symbol's `d` — the only part of the markup that encodes the URL. */
function qrPath(html: string): string {
  const match = html.match(/<path fill="currentColor" d="([^"]+)"/);
  expect(match, "the credential QR must render a filled path").not.toBeNull();
  return match?.[1] ?? "";
}

describe("CredentialFace — H1 provenance gate (negative case)", () => {
  it("self-reported sterilization never renders an ok stamp — shows Declarada", () => {
    const state = deriveComplianceState(complianceInput({ events: [sterilization(SELF)] }));
    const card = state.cards.find((c) => c.key === "sterilization");
    // Derivation itself must downgrade to neutral (H1) — asserted independent
    // of rendering so a future component regression can't hide a logic bug.
    expect(card?.tone).toBe("neutral");
    expect(card?.state).toBe("Declarada");

    const html = render(state);
    // The component must actually surface the derived state, not just compute it.
    expect(html).toContain("Declarada");
    // "Verificada" is the ok-only sterilization seal — must never appear here.
    expect(html).not.toContain("Verificada");
    // Nor the summary's own affirmative stamp: 0 of N obligations are met.
    expect(html).not.toContain("AL DÍA");
  });

  it("professional-verified sterilization renders Verificada / ok, counts toward the summary", () => {
    const state = deriveComplianceState(complianceInput({ events: [sterilization(VET)] }));
    const card = state.cards.find((c) => c.key === "sterilization");
    expect(card?.tone).toBe("ok");
    expect(card?.state).toBe("Verificada");

    const html = render(state);
    expect(html).toContain("Verificada");
    // The declared wording must not leak onto a signed card.
    expect(html).not.toContain("Declarada");
  });
});

// Cumplimiento dedup (PO 2026-07-18): the summary line used to append
// "· falta X" / "· X sin verificar" naming the specific pending obligation —
// immediately duplicated by that SAME obligation's card rendered right below
// (e.g. "0 de 4 al día · falta régimen ppp" atop a PPP card that itself says
// "Faltan datos"). The summary now carries ONLY the count; the medianos-
// sesión-2 finding #4 distinction (a declared-and-vigente dose must never
// read like a genuinely absent one) still has to hold, but it now lives
// exclusively in the CARD the summary sits above — the dual "declared /
// registry still needs a firma" block for a declared dose, vs. the flat
// "Sin registro" badge for a truly absent one.
describe("CredentialFace — compliance summary vs. obligation cards (dedup, PO 2026-07-18)", () => {
  function vaccination(
    vaccineName: string,
    nextDueAt: string | null,
    prov: Partial<ComplianceEvent>,
  ): ComplianceEvent {
    return {
      eventType: "vaccination_administered",
      occurredAt: "2026-01-01T00:00:00Z",
      payload: { vaccine_name: vaccineName, next_due_at: nextDueAt },
      ...prov,
    };
  }

  // Identities are now STATED, not implied by role. The old fixture said only
  // `authorRole: "owner"` and the input named no reader, so "cargada por vos"
  // passed no matter who was looking — the front-face twin of the transferred
  // asiento defect (2026-08-01).
  const GRACIELA = "user-graciela";
  const NOELI = "user-noeli";
  const SELF = {
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    recordedByUserId: GRACIELA,
  };

  it("a declared-and-vigente rabies dose: the summary shows only the count, and the card alone carries the 'not yet verified' honesty", () => {
    const state = deriveComplianceState(
      complianceInput({
        events: [vaccination("Antirrábica", "2027-01-01T00:00:00Z", SELF)],
        viewerUserId: GRACIELA,
      }),
    );
    const card = state.cards.find((c) => c.key === "rabies");
    // The projection-level distinction (medianos-sesión-2 #4) is unchanged —
    // only where it surfaces in this component changes.
    expect(card?.state).toBe("Declarada");
    expect(card?.tone).toBe("neutral");

    const html = render(state);
    // The summary tail is gone — neither wording it used to carry appears.
    expect(html).not.toContain("vacuna antirrábica sin verificar");
    expect(html).not.toContain("falta vacuna antirrábica");
    // The summary itself is exactly the "N de M al día" count.
    expect(html).toContain(state.summary.label);
    // The honest "declared, registry still needs a matriculated firma"
    // distinction survives — but now ONLY in the card's own dual block.
    expect(html).toContain("Antirrábica cargada por vos");
    expect(html).toContain("un veterinario matriculado tiene que firmarla");
  });

  it("after a transfer the credential does not tell the new titular she loaded the dose", () => {
    // graciela declared the dose; noeli now holds the pet. The front face used
    // to greet her with "Antirrábica cargada por vos" — the same reassigned
    // authorship the libreta's asientos had.
    const state = deriveComplianceState(
      complianceInput({
        events: [vaccination("Antirrábica", "2027-01-01T00:00:00Z", SELF)],
        viewerUserId: NOELI,
      }),
    );
    const html = render(state);
    expect(html).not.toContain("Antirrábica cargada por vos");
    expect(html).toContain("Antirrábica cargada por el titular");
    // The dose is still ON RECORD and still declared — only the authorship
    // claim changed. The registry nudge must survive.
    expect(html).toContain("un veterinario matriculado tiene que firmarla");
  });

  it("with no reader in context the copy stays third-person rather than guessing", () => {
    // Fail-safe direction: a caller that forgets viewerUserId loses warmth,
    // never accuracy.
    const state = deriveComplianceState(
      complianceInput({ events: [vaccination("Antirrábica", "2027-01-01T00:00:00Z", SELF)] }),
    );
    expect(render(state)).not.toContain("cargada por vos");
  });

  it("a pet with no rabies record at all: the summary shows only the count, and the card alone reads 'Sin registro'", () => {
    const state = deriveComplianceState(complianceInput());
    const card = state.cards.find((c) => c.key === "rabies");
    expect(card?.state).toBe("Sin registro");

    const html = render(state);
    expect(html).not.toContain("falta vacuna antirrábica");
    expect(html).toContain(state.summary.label);
    expect(html).toContain("Sin registro");
  });
});

// Unified affirmative pill vocabulary (UI review, PO 2026-08-06). The three
// compliance rows used to show three adjacent greens speaking three different
// grammars — "VIGENTE" (a currency), "REGISTRADA" (a filing), "SÍ" (an
// answer) — and the summary stamp above them added a fourth reading of the
// same colour. The rule now: the pill carries the DATUM, and "Sí/No" is never
// a pill.
describe("CredentialFace — unified pill vocabulary (PO 2026-08-06)", () => {
  function rabies(nextDueAt: string | null, prov: Partial<ComplianceEvent>): ComplianceEvent {
    return {
      eventType: "vaccination_administered",
      occurredAt: "2026-01-01T00:00:00Z",
      payload: { vaccine_name: "Antirrábica", next_due_at: nextDueAt },
      ...prov,
    };
  }

  it("a vigente vaccine pill names the date it runs until, and stops repeating it below", () => {
    const state = deriveComplianceState(complianceInput({ events: [rabies("2027-01-14", VET)] }));
    const card = state.cards.find((c) => c.key === "rabies");
    expect(card?.state).toBe("Vigente");
    expect(card?.currencyUntil).toBe("14/01/2027");

    const html = render(state);
    expect(html).toContain("VIGENTE · hasta 14/01/2027");
    // The muted "Próxima …" line was the ONLY carrier of this date before; now
    // that the pill says it, printing it twice one line apart is the exact
    // duplication the Cumplimiento dedup pass removed elsewhere.
    expect(html).not.toContain("Próxima 14/01/2027");
  });

  it("a vaccine with no next-due date keeps the bare stamp — never a fabricated date", () => {
    const state = deriveComplianceState(complianceInput({ events: [rabies(null, VET)] }));
    const html = render(state);
    // currencyKnown === false → SIN DATO, the honest stamp; no "hasta" anywhere.
    expect(html).toContain("SIN DATO");
    expect(html).not.toContain("hasta");
  });

  it("a verified microchip shows the chip NUMBER as its pill instead of 'Sí'", () => {
    const state = deriveComplianceState(
      complianceInput({
        microchipCode: "982000123456789",
        events: [
          {
            eventType: "microchip_implanted",
            occurredAt: "2026-01-01T00:00:00Z",
            payload: {},
            ...VET,
          },
        ],
      }),
    );
    const html = render(state);
    expect(html).toContain("982000123456789");
    // The yes/no adjective is gone from the card entirely. (The face renders
    // the panel twice — desktop inline + the mobile disclosure — so counting
    // occurrences of the code would assert the breakpoint layout, not the
    // dedup; the "printed once per card" guarantee is the detail-line
    // suppression covered by detailIsInThePill.)
    expect(html).not.toContain(">Sí<");
  });

  it("the compliance summary stamp reads AL DÍA, not the vaccine lens's VIGENTE", () => {
    const state = deriveComplianceState(
      complianceInput({
        events: [
          rabies("2027-01-14", VET),
          sterilization(VET),
          {
            eventType: "microchip_implanted",
            occurredAt: "2026-01-01T00:00:00Z",
            payload: {},
            ...VET,
          },
        ],
        microchipCode: "982000123456789",
      }),
    );
    expect(state.worstTone).toBe("ok");
    expect(state.summary.label).toBe("3 de 3 al día");

    const html = render(state);
    expect(html).toContain("AL DÍA");
  });

  it("stamps SIN DATO, not POR VENCER, when the worst obligation is a missing fact", () => {
    // S2-F06 (2026-08-08): a dog with no breed and no weight surfaces the PPP
    // "Faltan datos" card, whose tone is deliberately `due` so it ranks first
    // and never counts as "al día". The stamp then rendered `due`'s default
    // word and the credential announced POR VENCER over a pet with no dates at
    // all. Nothing is expiring — the fact is simply not known.
    const state = deriveComplianceState(complianceInput({ species: "dog" }));
    expect(state.worstIsUnknown).toBe(true);

    const html = render(state);
    expect(html).toContain("SIN DATO");
    expect(html).not.toContain("POR VENCER");
  });

  it("still stamps POR VENCER when a dose genuinely is due", () => {
    // Non-vacuity: a stamp that NEVER says POR VENCER would pass the test above
    // while silencing every real deadline. The `due` tone comes from the rabies
    // reminder variant, not from a date this module re-derives — and the dog
    // carries breed and weight so the PPP card never appears to outrank it.
    const state = deriveComplianceState(
      complianceInput({
        species: "dog",
        breed: "Boxer",
        estimatedWeightKg: 30,
        rabiesReminder: { variant: "due_soon", dueAt: new Date("2026-07-15T00:00:00Z") },
      }),
    );
    expect(state.worstTone).toBe("due");
    expect(state.worstIsUnknown).toBe(false);
    expect(render(state)).toContain("POR VENCER");
  });
});

describe("CredentialFace — In-Memoriam skin (ADR-15)", () => {
  // wave-3 D12: the ribbon now renders through the shared LnMemorialChip
  // (components/ui/StatusFlag.tsx) instead of hand-rolling its own box —
  // its canonical label is "En memoria" (Spanish, matching the rest of the
  // app's es-AR-only copy), replacing the former ad-hoc "In Memoriam" text.
  it("renders no memorial ribbon when memorial is absent (default/active pet)", () => {
    const state = deriveComplianceState(complianceInput());
    const html = render(state);
    expect(html).not.toContain("En memoria");
    expect(html).not.toContain('data-section="memorial-ribbon"');
  });

  it("renders the En memoria ribbon with the birth-death year line when memorial is set", () => {
    const state = deriveComplianceState(complianceInput());
    const html = renderToStaticMarkup(
      <CredentialFace
        {...baseProps}
        complianceState={state}
        memorial={{ birthYear: 2015, deathYear: 2026 }}
      />,
    );
    expect(html).toContain("En memoria");
    expect(html).toContain("2015");
    expect(html).toContain("2026");
    expect(html).toContain('data-section="memorial-ribbon"');
  });

  it("falls back to a bare 'En memoria' line when birth/death years are unknown", () => {
    const state = deriveComplianceState(complianceInput());
    const html = renderToStaticMarkup(
      <CredentialFace
        {...baseProps}
        complianceState={state}
        memorial={{ birthYear: null, deathYear: null }}
      />,
    );
    expect(html).toContain("En memoria");
    expect(html).not.toContain("–"); // no year range when years are unknown
  });
});

// QA histórico 2026-07-08 item 2 (round 2): "Rocco Inscripta" — the
// registration badge disagreed with a male pet's sex. It must now render
// "Registrado" for male, "Registrada" for female, and the neutral
// "Registrado/a" when sex is unrecorded — and the same word must agree in BOTH
// render paths (the prominent badge next to the name, and the quiet marker used
// when a situation skin is active).
// The word itself moved from "Inscripto/a" to "Registrado/a" (PO 2026-07-30).
describe("CredentialFace — Registrado/a gender agreement", () => {
  it("renders Registrado for a male pet", () => {
    const state = deriveComplianceState(complianceInput());
    const html = renderToStaticMarkup(
      <CredentialFace {...baseProps} complianceState={state} petSex="male" />,
    );
    expect(html).toContain("Registrado");
    expect(html).not.toContain("Registrada");
  });

  it("renders Registrada for a female pet", () => {
    const state = deriveComplianceState(complianceInput());
    const html = renderToStaticMarkup(
      <CredentialFace {...baseProps} complianceState={state} petSex="female" />,
    );
    expect(html).toContain("Registrada");
  });

  it("renders the neutral Registrado/a when sex is unrecorded", () => {
    const state = deriveComplianceState(complianceInput());
    const html = renderToStaticMarkup(
      <CredentialFace {...baseProps} complianceState={state} petSex={null} />,
    );
    expect(html).toContain("Registrado/a");
  });

  it("genders the quiet marker too, when a situation skin demotes the badge", () => {
    const state = deriveComplianceState(complianceInput());
    const html = renderToStaticMarkup(
      <CredentialFace
        {...baseProps}
        complianceState={state}
        petSex="male"
        situation={{
          key: "perdida",
          tone: "alerta",
          label: "Perdida",
          icon: "perdida",
          isDefault: false,
        }}
      />,
    );
    expect(html).toContain("Registrado");
    expect(html).not.toContain("Registrada");
    // Pet-state standardization (PO 2026-07-16): the situation LABEL must NOT
    // render here — the masthead band chip (DocumentChrome) is the single
    // textual carrier of the state. The face keeps only its data-situation
    // tint hook and the demoted registration marker asserted above.
    expect(html).not.toContain("Perdido");
    expect(html).not.toContain("Perdida");
    expect(html).toContain('data-situation="perdida"');
  });
});

describe("CredentialFace — credential QR (client-side, native-readiness Track 2)", () => {
  it("renders a real <svg role=img> QR named after the pet — no injected markup", () => {
    const html = render(deriveComplianceState(complianceInput()));

    // The QR is now DRAWN, not injected: a real svg element with an accessible
    // name, inside the existing .ln-qr-frame link.
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Código QR de la credencial pública de Firulais"');
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*>\s*<path fill="currentColor"/);
  });

  it("encodes the absolute credentialUrl it was handed (invariant #1: scannable QR)", () => {
    // Same URL, same symbol: the path a second render produces for the same
    // credentialUrl is byte-identical, and it differs from another pet's.
    const state = deriveComplianceState(complianceInput());
    const a = render(state);
    const b = render(state);
    expect(qrPath(a)).toBe(qrPath(b));

    const other = renderToStaticMarkup(
      <CredentialFace
        {...baseProps}
        credentialUrl="https://www.mimar.com.ar/p/zzz"
        complianceState={state}
      />,
    );
    expect(qrPath(other)).not.toBe(qrPath(a));
  });
});
