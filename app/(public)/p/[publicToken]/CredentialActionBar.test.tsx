// @vitest-environment jsdom
//
// CredentialActionBar — sticky mobile primary CTA on the public credential
// (cursor citizen review P3). Locks the per-state verb contract:
//   lost    → finder/sighting hard-nav anchor (+ "Llamar" ONLY when a
//             pre-gated tel: href arrives — the bar itself never decides
//             disclosure; page.tsx does, including the D2 dispute gate).
//   medical → "Ver resumen médico" scrolls to the tier-2 section.
//   dispute → neutral "Tengo información sobre esta mascota" opens + scrolls
//             to the dispute-tip <details> (PO 2026-07-24) — never a relay.
// Active tier-0 pets render NO bar at all (PO 2026-07-24 de-emphasis) — that
// gating, plus PII/deceased → no bar, is covered by
// __tests__/public-token-pii-contract.test.tsx.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CredentialActionBar, DISPUTE_SECTION_ID, MEDICAL_SECTION_ID } from "./CredentialActionBar";

// jsdom implements no scrolling — stub the one method the bar calls.
const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  cleanup();
  document.getElementById(MEDICAL_SECTION_ID)?.remove();
  document.getElementById(DISPUTE_SECTION_ID)?.remove();
});

describe("CredentialActionBar — lost mode", () => {
  it("renders the pre-resolved primary as a plain hard-nav anchor and the call CTA from the pre-gated tel: href", () => {
    render(
      <CredentialActionBar
        mode="lost"
        primaryHref="/p/dim-pamp-0001/encontre"
        primaryLabel="La tengo conmigo"
        phoneHref="tel:+5491122334455"
      />,
    );

    expect(screen.getByRole("link", { name: "La tengo conmigo" })).toHaveAttribute(
      "href",
      "/p/dim-pamp-0001/encontre",
    );
    expect(screen.getByRole("link", { name: "Llamar" })).toHaveAttribute(
      "href",
      "tel:+5491122334455",
    );
  });

  it("renders NO call CTA when phoneHref is null (undisclosed phone or open custody dispute — resolved server-side)", () => {
    render(
      <CredentialActionBar
        mode="lost"
        primaryHref="/p/dim-pamp-0001/sighting"
        primaryLabel="La vi cerca de acá"
        phoneHref={null}
      />,
    );

    expect(screen.getByRole("link", { name: "La vi cerca de acá" })).toHaveAttribute(
      "href",
      "/p/dim-pamp-0001/sighting",
    );
    expect(screen.queryByRole("link", { name: "Llamar" })).toBeNull();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  });
});

describe("CredentialActionBar — medical mode (active + tier 2)", () => {
  it("scrolls to the tier-2 medical section", () => {
    const target = document.createElement("div");
    target.id = MEDICAL_SECTION_ID;
    document.body.appendChild(target);

    render(<CredentialActionBar mode="medical" />);
    fireEvent.click(screen.getByRole("button", { name: "Ver resumen médico" }));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

describe("CredentialActionBar — dispute mode (custody-disputed pet, PO 2026-07-24)", () => {
  it("opens the dispute-tip <details> and scrolls to it — the ONLY verb is the neutral tip", () => {
    const details = document.createElement("details");
    details.id = DISPUTE_SECTION_ID;
    document.body.appendChild(details);
    expect(details.open).toBe(false);

    render(<CredentialActionBar mode="dispute" />);
    fireEvent.click(screen.getByRole("button", { name: "Tengo información sobre esta mascota" }));

    expect(details.open).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("renders NO relay affordance of any kind (D2: no links, no tel:)", () => {
    render(<CredentialActionBar mode="dispute" />);

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it("is a no-op (no crash) when the target section is absent", () => {
    render(<CredentialActionBar mode="dispute" />);
    fireEvent.click(screen.getByRole("button", { name: "Tengo información sobre esta mascota" }));

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("CredentialActionBar — chrome contract", () => {
  it("is a labelled nav landmark, fixed to the bottom, hidden at >=sm (desktop keeps inline actions)", () => {
    render(<CredentialActionBar mode="medical" />);

    const nav = screen.getByRole("navigation", { name: "Acción principal" });
    expect(nav.className).toContain("fixed");
    expect(nav.className).toContain("bottom-0");
    expect(nav.className).toContain("sm:hidden");
    // Safe-area aware (iOS home indicator).
    expect(nav.style.paddingBottom).toContain("env(safe-area-inset-bottom)");
  });
});
