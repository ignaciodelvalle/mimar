// @vitest-environment jsdom
//
// LandingHero — curiosity-hook microcopy (landing microcopy train, PO-locked
// wording): "Escanealo para ver más sobre Pampa" sits between the hero
// credential and its state dots.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CRISIS_DOORS, CrisisBand } from "./CrisisBand";
import { LandingHero } from "./LandingHero";

const SAMPLE_SVG = '<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>';

afterEach(() => {
  cleanup();
});

describe("<LandingHero> — curiosity-hook microcopy", () => {
  it("renders the PO-locked microcopy naming Pampa, near the QR/credential", () => {
    render(
      <LandingHero qrSvg={SAMPLE_SVG} publicHref="/p/DIM-PAMP-0001" publicToken="DIM-PAMP-0001" />,
    );

    expect(screen.getByText("Escanealo para ver más sobre Pampa")).toBeInTheDocument();
  });

  it("still renders the real, scannable QR link alongside the microcopy", () => {
    render(
      <LandingHero qrSvg={SAMPLE_SVG} publicHref="/p/DIM-PAMP-0001" publicToken="DIM-PAMP-0001" />,
    );

    const qrLink = screen.getByRole("link", { name: "Ver la credencial pública de demostración" });
    expect(qrLink).toHaveAttribute("href", "/p/DIM-PAMP-0001");
  });
});

describe("<LandingHero> — credential controls keep their accessible contract", () => {
  // Guards the FlipButton extraction (2026-08-02, citizen button-ratchet
  // offset) and the A1/A2 hit-area work: the CSS pads the targets, but only
  // if these exact classes and names stay on the markup.
  it("renders BOTH flip triggers (front + back) with their distinct names", () => {
    render(
      <LandingHero qrSvg={SAMPLE_SVG} publicHref="/p/DIM-PAMP-0001" publicToken="DIM-PAMP-0001" />,
    );

    const front = screen.getByRole("button", { name: "Girar credencial" });
    const back = screen.getByRole("button", { name: "Volver a la credencial" });
    expect(front).toHaveClass("lp-hcard-flip");
    expect(back).toHaveClass("lp-hcard-flip");
  });

  it("renders the four owner-state dots as named, pressable controls in a toolbar", () => {
    render(
      <LandingHero qrSvg={SAMPLE_SVG} publicHref="/p/DIM-PAMP-0001" publicToken="DIM-PAMP-0001" />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "Estados de la credencial" });
    const dots = within(toolbar).getAllByRole("button");
    // Owner states only (PO 2026-09-29, critique M4): no PPP, no observación.
    expect(dots.map((d) => d.getAttribute("aria-label"))).toEqual([
      "AL DÍA",
      "PERDIDA",
      "DE VUELTA EN CASA",
      "EN TRATAMIENTO",
    ]);
    for (const dot of dots) {
      expect(dot).toHaveClass("lp-hdot"); // the class the 24×24 hit-area CSS targets
      expect(dot).toHaveAccessibleName();
    }
  });
});

describe("<LandingHero> — no demo pet to resolve (RA-6 finding 1)", () => {
  it("drops the QR link entirely rather than pointing at a 404", () => {
    render(<LandingHero qrSvg={null} publicHref={null} publicToken={null} />);

    expect(
      screen.queryByRole("link", { name: "Ver la credencial pública de demostración" }),
    ).not.toBeInTheDocument();
  });

  it("swaps the scan invitation for copy that describes the product", () => {
    render(<LandingHero qrSvg={null} publicHref={null} publicToken={null} />);

    expect(screen.queryByText(/^Escanealo para ver más/)).not.toBeInTheDocument();
    expect(
      screen.getByText("Cada mascota registrada tiene su credencial pública con QR"),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Design critique 2026-09-29 — C2 (primary CTA), C3 (copy first), C4 (urgency
// line), M4 (state word, distinct dot names, live region for people only).
// ---------------------------------------------------------------------------

function renderDemoHero() {
  return render(
    <LandingHero qrSvg={SAMPLE_SVG} publicHref="/p/DIM-PAMP-0001" publicToken="DIM-PAMP-0001" />,
  );
}

describe("<LandingHero> — one primary action for the owner (C2)", () => {
  it("has exactly one primary-styled button, and it leads to /registro", () => {
    const { container } = renderDemoHero();
    const primaries = container.querySelectorAll(".lp-hero-cta .lp-btn--primary");
    expect(primaries).toHaveLength(1);
    const cta = screen.getByRole("link", { name: "Crear la libreta de mi mascota" });
    expect(cta).toBe(primaries[0]);
    expect(cta).toHaveAttribute("href", "/registro");
  });

  it("keeps 'Cómo funciona' as the secondary, next to it", () => {
    const { container } = renderDemoHero();
    const how = screen.getByRole("link", { name: "Cómo funciona" });
    expect(how).toHaveAttribute("href", "#idea");
    expect(how).toHaveClass("lp-btn--ghost");
    expect(container.querySelector(".lp-hero-cta")).toContainElement(how);
  });

  it("reads copy before the credential, in source order (C3)", () => {
    renderDemoHero();
    const h1 = screen.getByRole("heading", { level: 1 });
    const card = document.querySelector('[data-section="hero-credential"]');
    expect(card).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING: the card comes after the headline.
    expect(h1.compareDocumentPosition(card as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

describe("<LandingHero> — the urgency line (C4)", () => {
  it("links to the SAME destinations as the crisis band", () => {
    renderDemoHero();
    const line = document.querySelector('[data-section="hero-urgent"]') as HTMLElement;
    expect(line).not.toBeNull();
    const lost = within(line).getByRole("link", { name: CRISIS_DOORS.lost.label });
    const found = within(line).getByRole("link", { name: CRISIS_DOORS.found.label });
    expect(lost).toHaveAttribute("href", CRISIS_DOORS.lost.href);
    expect(found).toHaveAttribute("href", CRISIS_DOORS.found.href);

    // …and the band itself really uses those constants.
    cleanup();
    render(<CrisisBand />);
    expect(screen.getByRole("link", { name: /Perdí una mascota/ })).toHaveAttribute(
      "href",
      CRISIS_DOORS.lost.href,
    );
    expect(screen.getByRole("link", { name: /Encontré una mascota/ })).toHaveAttribute(
      "href",
      CRISIS_DOORS.found.href,
    );
  });

  it("sits above the headline", () => {
    renderDemoHero();
    const line = document.querySelector('[data-section="hero-urgent"]') as Node;
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(line.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

describe("<LandingHero> — the state reads in words, not only colour (M4)", () => {
  function stateLine(): HTMLElement {
    return document.querySelector('[data-section="hero-state-line"]') as HTMLElement;
  }
  function liveRegion(): HTMLElement {
    return document.querySelector('[aria-live="polite"]') as HTMLElement;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rests on a visible 'Al día'", () => {
    renderDemoHero();
    expect(stateLine()).toHaveTextContent("Al día · Vacunas firmadas");
  });

  it("says 'Está perdida' on the card body when the lost state is shown", () => {
    renderDemoHero();
    const toolbar = screen.getByRole("toolbar", { name: "Estados de la credencial" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "PERDIDA" }));
    expect(stateLine()).toHaveTextContent("Está perdida · Llamar al dueño");
  });

  it("names every state dot differently — the found state is not a second 'AL DÍA'", () => {
    renderDemoHero();
    const toolbar = screen.getByRole("toolbar", { name: "Estados de la credencial" });
    const names = within(toolbar)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("DE VUELTA EN CASA");
  });

  it("does not announce the automatic cycle", () => {
    vi.useFakeTimers();
    renderDemoHero();
    expect(liveRegion()).toBeEmptyDOMElement();
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    // The card moved on…
    expect(stateLine()).toHaveTextContent("Está perdida");
    // …and nobody was interrupted.
    expect(liveRegion()).toBeEmptyDOMElement();
  });

  it("announces a state the person picks", () => {
    renderDemoHero();
    const toolbar = screen.getByRole("toolbar", { name: "Estados de la credencial" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "EN TRATAMIENTO" }));
    expect(liveRegion()).toHaveTextContent(
      "Estado de la credencial: En tratamiento. Plan en el historial.",
    );
  });
});
