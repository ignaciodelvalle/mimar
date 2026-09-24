// Structure test — MarkLostWizard affirmative disclosure step (privacy
// hardening 2026-07-04, Ley 25.326 consent gap).
//
// Rendering strategy mirrors the repo's other component structure tests:
// react-dom/server → static HTML string, no jsdom.
//
// Contract:
//   - The wizard ALWAYS submits explicit disclosure values via hidden inputs
//     (so setPetLostAction never falls back to the permissive DB defaults).
//   - Owner-PII toggles (first name, phone, email, last location) default to
//     "false" — affirmative opt-in, not opt-out.
//   - The finder form (no owner PII) defaults to "true".
//   - The disclosure step is part of the step labels.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// LocationFields relies on hooks and dynamic imports; stub it for SSR render.
vi.mock("@/components/LocationFields", () => ({
  LocationFields: () => React.createElement("div", { "data-testid": "location-fields" }),
}));

import {
  MarkLostWizard,
  lostShareText,
} from "@/app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostWizard";

const BASE_PROPS = {
  action: vi.fn(async () => ({ error: null })),
  petName: "Luna",
  petPublicToken: "DIM-TEST-0001",
  petHasMicrochip: true,
  petHasTattoo: false,
  petColor: null,
  petDistinguishingFeatures: null,
  petJurisdictionProvince: null,
  petJurisdictionLocality: null,
};

function hiddenInputValue(html: string, name: string): string | null {
  const match = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`));
  return match ? match[1] : null;
}

describe("MarkLostWizard — affirmative disclosure consent", () => {
  it("always submits explicit disclosure values with PII toggles OFF by default", () => {
    const html = renderToStaticMarkup(<MarkLostWizard {...BASE_PROPS} />);

    // Owner PII: affirmative opt-in — defaults are "false".
    expect(hiddenInputValue(html, "disclose_first_name_when_lost")).toBe("false");
    expect(hiddenInputValue(html, "disclose_phone_when_lost")).toBe("false");
    expect(hiddenInputValue(html, "disclose_email_when_lost")).toBe("false");
    expect(hiddenInputValue(html, "disclose_last_location_when_lost")).toBe("false");
    // Finder form exposes no owner data — stays available by default.
    expect(hiddenInputValue(html, "allow_finder_form_when_lost")).toBe("true");
  });

  it("includes the disclosure step in the flow (chip/tattoo pets: 2 steps)", () => {
    const html = renderToStaticMarkup(<MarkLostWizard {...BASE_PROPS} />);
    expect(html).toContain("Paso 1 de 2");
  });

  it("includes the disclosure step after the details step (no chip/tattoo: 3 steps)", () => {
    const html = renderToStaticMarkup(
      <MarkLostWizard {...BASE_PROPS} petHasMicrochip={false} petHasTattoo={false} />,
    );
    expect(html).toContain("Paso 1 de 3");
  });

  it("renders the affirmative consent copy and the five disclosure toggles", () => {
    const html = renderToStaticMarkup(<MarkLostWizard {...BASE_PROPS} />);
    expect(html).toContain("No se comparte nada que no actives ac");
    expect(html).toContain("Tu nombre");
    expect(html).toContain("Tu tel");
    expect(html).toContain("Tu email");
    expect(html).toContain("ltima ubicaci");
    expect(html).toContain("Formulario para avisarte");
  });

  // pet-state-header R5.1 — the step-1 copy used to CONTRADICT the consent
  // model: "La ubicación se vuelve parte de la credencial pública" while
  // disclose_last_location_when_lost defaults OFF. The new copy states the
  // truth: the location is NOT shown publicly unless the owner enables the
  // disclosure preference.
  it("step-1 copy no longer promises the location goes public (R5.1)", () => {
    const html = renderToStaticMarkup(<MarkLostWizard {...BASE_PROPS} />);
    expect(html).not.toContain("se vuelve parte de la credencial p");
    expect(html).toContain("no se muestra en la credencial p");
  });

  // pet-state-header R5.2 — the "Última ubicación" disclosure toggle is ALSO
  // visible in the location step (one state, two views): the label renders in
  // BOTH the step-location section and the final disclosure step…
  it("renders the location disclosure toggle in step 1 AND in the final step (R5.2)", () => {
    const html = renderToStaticMarkup(<MarkLostWizard {...BASE_PROPS} />);
    const stepLocation = html.slice(
      html.indexOf('data-section="step-location"'),
      html.indexOf('data-section="step-disclosure"'),
    );
    const stepDisclosure = html.slice(html.indexOf('data-section="step-disclosure"'));
    expect(stepLocation).toContain("ltima ubicaci");
    expect(stepDisclosure).toContain("ltima ubicaci");
  });

  // …while the hidden explicit-submission mirror stays SINGLE per field — two
  // views of one state, never two divergent inputs.
  it("keeps exactly ONE hidden mirror per disclosure field (single state, R5.2)", () => {
    const html = renderToStaticMarkup(<MarkLostWizard {...BASE_PROPS} />);
    for (const name of [
      "disclose_first_name_when_lost",
      "disclose_phone_when_lost",
      "disclose_email_when_lost",
      "disclose_last_location_when_lost",
      "allow_finder_form_when_lost",
    ]) {
      const hiddenCount = (
        html.match(new RegExp(`<input[^>]*type="hidden"[^>]*name="${name}"`, "g")) ?? []
      ).length;
      expect(hiddenCount, name).toBe(1);
    }
  });
});

// T1-L14 — the WhatsApp share text said "está perdida — ayudanos a encontrarla"
// to every animal. The expected sentences are written out whole: a helper that
// regressed could not agree with itself here.
describe("MarkLostWizard — WhatsApp share text agrees with the pet's sex", () => {
  it("is masculine for a male pet", () => {
    expect(lostShareText("Toby", "male")).toBe(
      "Toby está perdido — ayudanos a que vuelva a casa. Su perfil público:",
    );
  });

  it("is feminine for a female pet", () => {
    expect(lostShareText("Luna", "female")).toBe(
      "Luna está perdida — ayudanos a que vuelva a casa. Su perfil público:",
    );
  });

  it("assumes no gender when the sex is unknown", () => {
    expect(lostShareText("Pelusa", "unknown")).toBe(
      "Pelusa se perdió — ayudanos a que vuelva a casa. Su perfil público:",
    );
    expect(lostShareText("Pelusa", null)).toBe(
      "Pelusa se perdió — ayudanos a que vuelva a casa. Su perfil público:",
    );
  });
});
