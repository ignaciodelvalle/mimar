// Structure test — MarkLostWizard prefill from a prior pet_marked_lost
// episode (medianos-sesión-2 finding #3).
//
// A second "Marcar como perdida" used to start the enriched-description step
// (accesorios / comportamiento / contexto del último avistaje) BLANK even
// when the owner had already typed those details on a prior episode — events
// are the source of truth (invariant #2), so the wizard now accepts the
// latest prior episode's lost_description as default values. The owner can
// still edit; these are DEFAULTS, not locked-in values.
//
// Rendering strategy mirrors mark-lost-wizard-disclosure.test.tsx:
// react-dom/server → static HTML string, no jsdom.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/LocationFields", () => ({
  LocationFields: () => React.createElement("div", { "data-testid": "location-fields" }),
}));

import { MarkLostWizard } from "@/app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostWizard";

// No chip/tattoo → the enriched-details step (step 2) renders.
const BASE_PROPS = {
  action: vi.fn(async () => ({ error: null })),
  petName: "Luna",
  petPublicToken: "DIM-TEST-0001",
  petHasMicrochip: false,
  petHasTattoo: false,
  petColor: "marrón",
  petDistinguishingFeatures: "mancha blanca en el pecho",
  petJurisdictionProvince: null,
  petJurisdictionLocality: null,
};

function defaultValueFor(html: string, name: string): string | null {
  // Covers both <input defaultValue=...> (renders as value="...") and
  // <textarea defaultValue=...> (renders as inner text content).
  const inputMatch = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`));
  if (inputMatch) return inputMatch[1];
  const textareaMatch = html.match(
    new RegExp(`<textarea[^>]*name="${name}"[^>]*>([^<]*)</textarea>`),
  );
  return textareaMatch ? textareaMatch[1] : null;
}

describe("MarkLostWizard — prefill from a prior lost episode (finding #3)", () => {
  it("a first-ever episode (no prior description) renders the fields empty", () => {
    const html = renderToStaticMarkup(<MarkLostWizard {...BASE_PROPS} />);
    expect(defaultValueFor(html, "enriched_accessories_when_lost")).toBe("");
    expect(defaultValueFor(html, "enriched_behavior_notes")).toBe("");
    expect(defaultValueFor(html, "enriched_last_seen_context")).toBe("");
  });

  it("a second episode prefills accessories/behavior/last-seen-context from the prior episode", () => {
    const html = renderToStaticMarkup(
      <MarkLostWizard
        {...BASE_PROPS}
        priorAccessoriesWhenLost="collar rojo con placa"
        priorBehaviorNotes="se asusta de los autos"
        priorLastSeenContext="salió por la puerta cuando abrimos el portón"
      />,
    );
    expect(defaultValueFor(html, "enriched_accessories_when_lost")).toBe("collar rojo con placa");
    expect(defaultValueFor(html, "enriched_behavior_notes")).toBe("se asusta de los autos");
    expect(defaultValueFor(html, "enriched_last_seen_context")).toBe(
      "salió por la puerta cuando abrimos el portón",
    );
  });

  it("prefill is a DEFAULT, not a lock — the fields stay plain editable inputs", () => {
    const html = renderToStaticMarkup(
      <MarkLostWizard {...BASE_PROPS} priorAccessoriesWhenLost="collar rojo con placa" />,
    );
    const accessoriesInputTag = html.match(
      /<input[^>]*name="enriched_accessories_when_lost"[^>]*>/,
    )?.[0];
    expect(accessoriesInputTag).toBeTruthy();
    expect(accessoriesInputTag).not.toContain("readonly");
    expect(accessoriesInputTag).not.toContain("disabled");
  });
});
