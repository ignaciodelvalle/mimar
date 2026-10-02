// @vitest-environment jsdom
//
// LandingHero — curiosity-hook microcopy (landing microcopy train, PO-locked
// wording): "Escanealo para ver más sobre Pampa" sits between the hero
// credential and its state dots.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("<LandingHero> — libreta back face", () => {
  // "…y toda su historia, asiento por asiento." was removed (PO 2026-09-30):
  // the three vet-signed rows already make the point without a closing line.
  it("does not carry the removed 'toda su historia' closing line", () => {
    const { container } = render(
      <LandingHero qrSvg={SAMPLE_SVG} publicHref="/p/DIM-PAMP-0001" publicToken="DIM-PAMP-0001" />,
    );
    expect(container.textContent).not.toContain("toda su historia");
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

  it("renders the four owner-state dots as named, pressable controls, in order", () => {
    render(
      <LandingHero qrSvg={SAMPLE_SVG} publicHref="/p/DIM-PAMP-0001" publicToken="DIM-PAMP-0001" />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "Estados de la credencial" });
    const dots = within(toolbar).getAllByRole("button");
    // Owner states only (PO 2026-09-29, critique M4): no PPP jurisdiction
    // paperwork. "DE VUELTA EN CASA" was removed the same day: it resolved
    // back to the same AL DÍA wording, so it was a redundant state.
    // "EN OBSERVACIÓN ANTIRRÁBICA" was added later the same day (separate PO
    // request): a bite/rabies observation IS the owner's own situation,
    // unlike the removed PPP registration paperwork.
    expect(dots.map((d) => d.getAttribute("aria-label"))).toEqual([
      "AL DÍA",
      "PERDIDA",
      "EN OBSERVACIÓN ANTIRRÁBICA",
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
// Design critique 2026-09-29 — C3 (copy first), M4 (state word, distinct dot
// names, live region for people only); C2's primary CTA row was replaced by
// the crisis doors (PO 2026-10-02).
// ---------------------------------------------------------------------------

function renderDemoHero() {
  return render(
    <LandingHero qrSvg={SAMPLE_SVG} publicHref="/p/DIM-PAMP-0001" publicToken="DIM-PAMP-0001" />,
  );
}

describe("<LandingHero> — the three crisis doors replace the CTA row (PO 2026-10-02)", () => {
  it("offers the three doors as real links, to the same places the old band did", () => {
    renderDemoHero();
    const doors = screen.getByRole("navigation", { name: "Emergencias — sin cuenta" });
    const links = within(doors).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/mis-mascotas",
      "/perdidas",
      "/denuncias/nueva",
    ]);
    expect(within(doors).getByRole("link", { name: /^Perdí una mascota/ })).toBeInTheDocument();
    expect(within(doors).getByRole("link", { name: /^Encontré una mascota/ })).toBeInTheDocument();
    expect(
      within(doors).getByRole("link", { name: /^Vi un caso de maltrato/ }),
    ).toBeInTheDocument();
  });

  it("no longer carries the sign-up button or 'Cómo funciona' — the nav owns sign-up", () => {
    const { container } = renderDemoHero();
    expect(screen.queryByRole("link", { name: "Crear la libreta de mi mascota" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Cómo funciona" })).toBeNull();
    expect(container.querySelector(".lp-hero-cta")).toBeNull();
    expect(container.querySelector('a[href="/registro"]')).toBeNull();
  });

  it("keeps the Play badge and the kill line around the doors", () => {
    const { container } = renderDemoHero();
    const badge = container.querySelector(".lp-hero-badge");
    const doors = container.querySelector('[data-section="crisis-doors"]');
    const kill = container.querySelector(".lp-hero-kill");
    expect(badge).not.toBeNull();
    expect(kill).toHaveTextContent("Gratis para siempre.");
    // Source order: badge → doors → kill line.
    expect((badge as Node).compareDocumentPosition(doors as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect((doors as Node).compareDocumentPosition(kill as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
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

  it("reuses the product's own 'observacion-antirrabica' label and tints celeste/vigilancia (M4 follow-up)", () => {
    renderDemoHero();
    const toolbar = screen.getByRole("toolbar", { name: "Estados de la credencial" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "EN OBSERVACIÓN ANTIRRÁBICA" }));
    // Same wording lib/ui/pet-situation.ts uses for the real credential's
    // "observacion-antirrabica" situation — the landing must not invent its own.
    // Row shortened to "Mordedura" (PO 2026-09-30): the fuller
    // "Mordedura · control de 10 días" pushed the notice past one line at
    // 390px — see the one-line-notice fitness test below.
    expect(stateLine()).toHaveTextContent("En observación antirrábica · Mordedura");
    const card = document.querySelector('[data-section="hero-credential"]');
    expect(card).toHaveAttribute("data-tone", "vigilancia");
  });

  it("names every state dot differently", () => {
    renderDemoHero();
    const toolbar = screen.getByRole("toolbar", { name: "Estados de la credencial" });
    const names = within(toolbar)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
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
