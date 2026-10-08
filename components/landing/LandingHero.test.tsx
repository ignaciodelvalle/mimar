// @vitest-environment jsdom
//
// LandingHero — curiosity-hook microcopy (landing microcopy train, PO-locked
// wording): "Escanealo para ver más sobre Pampa" sits between the hero
// credential and its state dots.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LandingHero } from "./LandingHero";
import {
  HERO_NEAR_SCALE_TRAVEL,
  HERO_PARALLAX_PATTERN_PX,
  HERO_PARALLAX_QR_PX,
  HERO_PIVOT_TRAVEL_PCT,
  HERO_PRESS_SINK_PX,
  HERO_PRESS_SQUASH,
  HERO_TILT_MAX_DEG,
  heroNearScale,
  heroParallax,
  heroPivot,
  heroPress,
  smoothTilt,
  tiltTowardPointer,
} from "./hero-card-tilt";

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
    expect(qrLink).not.toHaveAttribute("data-qr-hook");
    expect(document.querySelector(".lp-hcardwrap")).not.toHaveAttribute("data-tilt");
    expect(document.querySelector(".lp-hcardwrap")).not.toHaveAttribute("data-light");
    expect(document.querySelector(".lp-hcardwrap")).not.toHaveAttribute("data-mark");
    expect(document.querySelector(".lp-hcardwrap")).not.toHaveAttribute("data-join");
    expect(document.querySelector(".lp-hcardwrap")).not.toHaveAttribute("data-flip");
    expect(document.querySelector(".lp-hcardwrap")).not.toHaveAttribute("data-glass");
    expect(document.querySelector(".lp-hcardwrap")).not.toHaveAttribute("data-optic");
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
    expect(front).toHaveAttribute("title", "Girar credencial");
    expect(back).toHaveAttribute("title", "Volver a la credencial");
    expect(document.querySelector(".lp-hcard")).toHaveAttribute(
      "aria-label",
      "Credencial de Pampa — estado: Al día",
    );
  });

  it("renders the four owner-state dots as named, pressable controls, in order", () => {
    render(
      <LandingHero qrSvg={SAMPLE_SVG} publicHref="/p/DIM-PAMP-0001" publicToken="DIM-PAMP-0001" />,
    );

    const toolbar = screen.getByRole("group", { name: "Estados de la credencial" });
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

describe("<LandingHero> — band head (window · doctype · turn)", () => {
  function head(face: "front" | "back"): HTMLElement {
    return document.querySelector(`.lp-hcard-${face} .lp-hcard-head`) as HTMLElement;
  }

  it("reads document type and turn control, on both faces — no printed issuer", () => {
    const { container } = renderDemoHero();
    const front = head("front");
    expect(front.querySelector(".lp-hcard-head-balance")).toBeTruthy();
    expect(within(front).getByText("Credencial digital")).toHaveClass("lp-hcard-doctype");
    expect(within(front).getByRole("button", { name: "Girar credencial" })).toHaveTextContent("↻");
    expect(container.querySelector(".lp-hcard-issuer-name")).toBeNull();
    expect(container.querySelector(".lp-hcard-latent-mark")).toBeTruthy();
    expect(container.querySelector(".lp-hcard-window")).toBeNull();
    expect(container.querySelector(".lp-hcard-ovd")).toBeTruthy();

    const back = head("back");
    expect(within(back).getByText("Libreta sanitaria")).toHaveClass("lp-hcard-doctype");
    expect(back.querySelector(".lp-hcard-flip")).toHaveAccessibleName("Volver a la credencial");
    expect(back.querySelector(".lp-hcard-flip")).toHaveTextContent("↺");
  });

  it("drops the old title and subtitle", () => {
    const { container } = renderDemoHero();
    expect(container.textContent).not.toContain("Credencial miMAR");
    expect(container.textContent).not.toContain("Libreta sanitaria · frente");
  });

  it("keeps the name over the token, exactly as the token is rendered", () => {
    renderDemoHero();
    const id = document.querySelector(".lp-hcard-id") as HTMLElement;
    expect(id.querySelector(".lp-hcard-name")).toHaveTextContent("Pampa");
    expect(id.querySelector(".lp-hcard-token")).toHaveTextContent("DIM-PAMP-0001");
  });

  it("keeps the masked token masked when there is no demo pet", () => {
    render(<LandingHero qrSvg={null} publicHref={null} publicToken={null} />);
    expect(document.querySelector(".lp-hcard-id .lp-hcard-token")).toHaveTextContent(
      "DIM-••••-••••",
    );
    expect(document.querySelector(".lp-hcard-libtoken")).toHaveTextContent("DIM-••••-••••");
  });

  it("draws the mark as decoration: the name beside it is the text", () => {
    renderDemoHero();
    for (const mark of document.querySelectorAll(".lp-hcard-mark")) {
      expect(mark).toHaveAttribute("aria-hidden", "true");
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

describe("<LandingHero> — four quick doors replace the CTA row (PO 2026-10-02)", () => {
  it("offers the four doors as real links, in reading order", () => {
    renderDemoHero();
    const doors = screen.getByRole("navigation", { name: "Accesos rápidos — sin cuenta" });
    const links = within(doors).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/encontre-un-animal",
      "/adoptar",
      "/refugios",
      "/denuncias/nueva",
    ]);
    expect(within(doors).queryByRole("link", { name: /^Perdí una mascota/ })).toBeNull();
    expect(within(doors).getByRole("link", { name: /^Encontré una mascota/ })).toBeInTheDocument();
    expect(within(doors).getByRole("link", { name: /^Adoptar/ })).toBeInTheDocument();
    expect(within(doors).getByRole("link", { name: /^Refugios y vets cerca/ })).toBeInTheDocument();
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

  it("puts the Play badge under the doors and keeps the kill line after it", () => {
    const { container } = renderDemoHero();
    const badge = container.querySelector(".lp-hero-badge");
    const doors = container.querySelector('[data-section="crisis-doors"]');
    const kill = container.querySelector(".lp-hero-kill");
    expect(badge).not.toBeNull();
    expect(kill).toHaveTextContent("Gratis para siempre.");
    // Source order: doors → badge → kill line (PO 2026-10-02).
    expect((doors as Node).compareDocumentPosition(badge as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect((badge as Node).compareDocumentPosition(kill as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("a flip ends the first-sight hint so its rotation never adds to the turn", () => {
    const { container } = renderDemoHero();
    const wrap = container.querySelector(".lp-hcardwrap") as HTMLElement;
    expect(wrap.dataset.hintDone).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Girar credencial" }));
    expect(wrap.dataset.hintDone).toBe("true");
  });

  it("keeps the Play badge a plain image while there is no listing URL", () => {
    const { container } = renderDemoHero();
    const badge = container.querySelector(".lp-hero-badge");
    expect(badge?.querySelector("img")).not.toBeNull();
    expect(badge?.querySelector("a")).toBeNull();
  });

  it("opens with the H1 — no eyebrow above it", () => {
    const { container } = renderDemoHero();
    const copy = container.querySelector(".lp-hero-copy");
    expect(copy?.firstElementChild?.tagName).toBe("H1");
    expect(container.textContent).not.toContain("Credencial digital · QR público verificable");
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
    const toolbar = screen.getByRole("group", { name: "Estados de la credencial" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "PERDIDA" }));
    expect(stateLine()).toHaveTextContent("Está perdida · Llamar al dueño");
  });

  it("reuses the product's own 'observacion-antirrabica' label and tints celeste/vigilancia (M4 follow-up)", () => {
    renderDemoHero();
    const toolbar = screen.getByRole("group", { name: "Estados de la credencial" });
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
    const toolbar = screen.getByRole("group", { name: "Estados de la credencial" });
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
    const toolbar = screen.getByRole("group", { name: "Estados de la credencial" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "EN TRATAMIENTO" }));
    expect(liveRegion()).toHaveTextContent(
      "Estado de la credencial: En tratamiento. Plan en el historial.",
    );
  });
});

// ---------------------------------------------------------------------------
// A held card (PO 2026-10-02): first-sight hint + float, pointer tilt,
// thickness. The motion itself is CSS and is checked in a real browser; what
// a unit test CAN pin is when it starts, how often, for whom, and how far the
// card is ever allowed to lean.
// ---------------------------------------------------------------------------

describe("tiltTowardPointer — the hard cap on the lean", () => {
  // A 400×250 box, the card's desktop size. Expected values are stated, not
  // re-derived from the helper's own formula.
  const W = 400;
  const H = 250;

  it("caps the lean at 1.5° (v2: the card barely moves, its layers carry the depth)", () => {
    // PO 2026-10-02, v2: "~1–2°". v1's 10° read as the whole card swinging.
    expect(HERO_TILT_MAX_DEG).toBe(1.5);
  });

  it("is flat with the pointer at the centre", () => {
    expect(tiltTowardPointer(200, 125, W, H)).toEqual({ rx: 0, ry: 0 });
  });

  it("turns the face toward a pointer on the right edge: the right edge recedes", () => {
    expect(tiltTowardPointer(400, 125, W, H)).toEqual({ rx: 0, ry: 1.5 });
  });

  it("turns the face toward a pointer on the bottom edge: the bottom edge recedes", () => {
    expect(tiltTowardPointer(200, 250, W, H)).toEqual({ rx: -1.5, ry: 0 });
  });

  it("leans a corner exactly as far as an edge, never 1.5·√2 ≈ 2.12°", () => {
    const { rx, ry } = tiltTowardPointer(0, 0, W, H);
    expect(Math.hypot(rx, ry)).toBeCloseTo(1.5, 9);
    // Top-left: the top edge and the left edge recede, equally (1.5/√2).
    expect(rx).toBeCloseTo(1.0607, 4);
    expect(ry).toBeCloseTo(-1.0607, 4);
  });

  it("never exceeds the cap, even for a pointer far outside the box", () => {
    for (const [x, y] of [
      [-5000, 125],
      [5000, 9000],
      [200, -300],
      [Number.NaN, 0],
    ] as const) {
      const { rx, ry } = tiltTowardPointer(x, y, W, H);
      expect(Math.hypot(rx, ry)).toBeLessThanOrEqual(1.5 + 1e-9);
    }
  });

  it("is linear inside the box: half-way to the edge is half the lean (no snap)", () => {
    expect(tiltTowardPointer(300, 125, W, H)).toEqual({ rx: 0, ry: 0.75 });
  });

  it("stays flat for a box with no size (not laid out yet)", () => {
    expect(tiltTowardPointer(10, 10, 0, 0)).toEqual({ rx: 0, ry: 0 });
  });
});

describe("smoothTilt — frame-rate independent easing", () => {
  it("moves as far in two 8ms frames as in one 16ms frame", () => {
    const from = { rx: 0, ry: 0 };
    const to = { rx: 0, ry: 10 };
    const twoSteps = smoothTilt(smoothTilt(from, to, 8), to, 8);
    const oneStep = smoothTilt(from, to, 16);
    expect(twoSteps.ry).toBeCloseTo(oneStep.ry, 9);
  });

  it("closes ~63% of the gap in one time constant and never overshoots", () => {
    const step = smoothTilt({ rx: 0, ry: 0 }, { rx: 0, ry: 10 }, 90, 90);
    expect(step.ry).toBeCloseTo(6.3212, 4);
    const late = smoothTilt({ rx: 0, ry: 0 }, { rx: 0, ry: 10 }, 100_000, 90);
    expect(late.ry).toBeLessThanOrEqual(10);
  });

  it("lets rotateY (the band) answer before rotateX (the foot)", () => {
    const step = smoothTilt({ rx: 0, ry: 0 }, { rx: 10, ry: 10 }, 16);
    expect(Math.abs(step.ry)).toBeGreaterThan(Math.abs(step.rx));
  });
});

describe("heroParallax — the layers slide at different depths, within bounds", () => {
  it("keeps the QR slide tiny and the band mark's slide at 18px", () => {
    expect(HERO_PARALLAX_QR_PX).toBe(3);
    expect(HERO_PARALLAX_PATTERN_PX).toBe(18);
  });

  it("is still when the card is flat", () => {
    expect(heroParallax({ rx: 0, ry: 0 })).toEqual({
      qr: { x: 0, y: 0 },
      pattern: { x: 0, y: 0 },
    });
  });

  it("slides the hatch AWAY from the pointer and the QR toward it", () => {
    expect(heroParallax({ rx: 0, ry: 1.5 })).toEqual({
      qr: { x: 3, y: 0 },
      pattern: { x: -18, y: 0 },
    });
    expect(heroParallax({ rx: -1.5, ry: 0 })).toEqual({
      qr: { x: 0, y: 3 },
      pattern: { x: 0, y: -18 },
    });
  });

  it("follows the lean linearly on the hatch: half the lean is half the slide", () => {
    expect(heroParallax({ rx: 0, ry: 0.75 }).pattern).toEqual({ x: -9, y: 0 });
    expect(heroParallax({ rx: 0, ry: 0.75 }).qr).toEqual({ x: 1.5, y: 0 });
  });

  it("agrees with the pointer it came from: a corner slides the hatch the other way", () => {
    const { qr, pattern } = heroParallax(tiltTowardPointer(0, 0, 400, 250));
    expect(qr.x).toBeLessThan(0);
    expect(qr.y).toBeLessThan(0);
    expect(pattern.x).toBeGreaterThan(0);
    expect(pattern.y).toBeGreaterThan(0);
    expect(Math.hypot(pattern.x, pattern.y)).toBeCloseTo(18, 9);
  });

  it("never slides past its constant, whatever tilt it is handed", () => {
    for (const tilt of [
      { rx: 40, ry: -40 },
      { rx: 0, ry: 900 },
      { rx: Number.NaN, ry: 1.5 },
      { rx: Number.POSITIVE_INFINITY, ry: 0 },
    ]) {
      const { qr, pattern } = heroParallax(tilt);
      expect(Math.hypot(qr.x, qr.y)).toBeLessThanOrEqual(3 + 1e-9);
      expect(Math.hypot(pattern.x, pattern.y)).toBeLessThanOrEqual(18 + 1e-9);
    }
  });
});

describe("heroPivot / heroNearScale — the opposite of the press comes closer", () => {
  it("stays centred and unscaled when the card is flat", () => {
    expect(heroPivot({ rx: 0, ry: 0 })).toEqual({ x: 50, y: 50 });
    expect(heroNearScale({ rx: 0, ry: 0 })).toBe(1);
  });

  it("pivots on the receding edge so the far side of the press can grow", () => {
    expect(HERO_PIVOT_TRAVEL_PCT).toBe(16);
    expect(HERO_NEAR_SCALE_TRAVEL).toBe(0.022);
    // Pointer at the bottom: the bottom recedes, the top comes closer.
    expect(heroPivot({ rx: -1.5, ry: 0 })).toEqual({ x: 50, y: 66 });
    expect(heroNearScale({ rx: -1.5, ry: 0 })).toBeCloseTo(1.022, 9);
    // Pointer on the right: the right recedes, the left grows.
    expect(heroPivot({ rx: 0, ry: 1.5 })).toEqual({ x: 66, y: 50 });
    expect(heroNearScale({ rx: 0, ry: 1.5 })).toBeCloseTo(1.022, 9);
  });

  it("follows the same lean the pointer produced, including at 8° and 28°", () => {
    const bottomLight = tiltTowardPointer(200, 250, 400, 250, 8);
    expect(heroPivot(bottomLight, 8).y).toBeCloseTo(66, 9);
    expect(heroPivot(bottomLight, 8).x).toBeCloseTo(50, 9);
    const bottomIntense = tiltTowardPointer(200, 250, 400, 250, 28);
    expect(heroPivot(bottomIntense, 28).y).toBeCloseTo(66, 9);
    expect(heroNearScale(bottomIntense, 28)).toBeCloseTo(1.022, 9);
  });
});

describe("heroPress — finger-give on a carnet, not a poster", () => {
  it("sinks 1.2px and nets ~1% scale at full lean", () => {
    expect(HERO_PRESS_SINK_PX).toBe(1.2);
    expect(HERO_PRESS_SQUASH).toBe(0.012);
    const press = heroPress({ rx: -1.5, ry: 0 });
    expect(press.mag).toBeCloseTo(1, 9);
    expect(press.sinkPx).toBeCloseTo(1.2, 9);
    expect(press.scale).toBeCloseTo(1.01, 9);
  });
});

type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: IOCallback;
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  constructor(callback: IOCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
}

function setMedia({ reduced, fine }: { reduced: boolean; fine: boolean }) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    let matches = false;
    if (query.includes("prefers-reduced-motion")) matches = reduced;
    else if (query.includes("pointer: fine")) matches = fine;
    return {
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
}

describe("<LandingHero> — a held card: hint, float, tilt, thickness", () => {
  const originalMatchMedia = window.matchMedia;
  const originalIO = window.IntersectionObserver;

  function wrap(): HTMLElement {
    return document.querySelector(".lp-hcardwrap") as HTMLElement;
  }
  function tiltLayer(): HTMLElement {
    return document.querySelector(".lp-hcard-tilt") as HTMLElement;
  }
  function card(): HTMLElement {
    return document.querySelector('[data-section="hero-credential"]') as HTMLElement;
  }
  function installObserver() {
    FakeIntersectionObserver.instances = [];
    window.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  }

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    window.IntersectionObserver = originalIO;
    FakeIntersectionObserver.instances = [];
    vi.restoreAllMocks();
  });

  it("draws the card's thickness as decorative layers inside the turning slab", () => {
    renderDemoHero();
    const slab = document.querySelector(".lp-hcard-slab") as HTMLElement;
    const edges = slab.querySelectorAll(":scope > .lp-hcard-edge");
    expect(edges).toHaveLength(5);
    for (const edge of edges) expect(edge).toHaveAttribute("aria-hidden", "true");
    // The ground shadow is the sole cast shadow; no second slab shadow.
    expect(slab.querySelector(":scope > .lp-hcard-lift")).not.toBeInTheDocument();
    // The card rides in the same slab, so the edge turns WITH it.
    expect(slab).toContainElement(card());
  });

  it("prints four restrained holographic marks in both blue bands", () => {
    renderDemoHero();
    const hosts = [".lp-hcard-band", ".lp-hcard-libhead"];
    for (const host of hosts) {
      const layer = card().querySelector(`${host} > .lp-hcard-sec`);
      expect(layer, host).toHaveAttribute("aria-hidden", "true");
      expect(layer?.querySelector(".lp-hcard-circuit")).not.toBeInTheDocument();
      expect(layer?.querySelectorAll(".lp-hcard-sec-mark")).toHaveLength(4);
    }
  });

  it("is still before it has been seen: no data-alive", () => {
    installObserver();
    setMedia({ reduced: false, fine: true });
    renderDemoHero();
    expect(wrap()).not.toHaveAttribute("data-alive");
  });

  it("plays the first-sight hint once per page view, then stops watching", () => {
    installObserver();
    setMedia({ reduced: false, fine: false });
    renderDemoHero();
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    const io = FakeIntersectionObserver.instances[0] as FakeIntersectionObserver;
    expect(io.observe).toHaveBeenCalledWith(wrap());

    // The initial callback, still below the fold: nothing yet.
    act(() => io.callback([{ isIntersecting: false }]));
    expect(wrap()).not.toHaveAttribute("data-alive");

    act(() => io.callback([{ isIntersecting: true }]));
    expect(wrap()).toHaveAttribute("data-alive", "true");
    expect(io.disconnect).toHaveBeenCalled();

    // Scrolling away and back does not replay it: the attribute never toggles
    // (removing and re-adding it would restart the CSS animation).
    act(() => io.callback([{ isIntersecting: false }]));
    act(() => io.callback([{ isIntersecting: true }]));
    expect(wrap()).toHaveAttribute("data-alive", "true");
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
  });

  it("under reduced motion: no hint, no tilt, and the flip still works by button, instantly", () => {
    installObserver();
    setMedia({ reduced: true, fine: true });
    const raf = vi.spyOn(window, "requestAnimationFrame");
    renderDemoHero();

    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    expect(wrap()).not.toHaveAttribute("data-alive");

    wrap().dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }));
    expect(raf).not.toHaveBeenCalled();
    expect(tiltLayer().style.transform).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Girar credencial" }));
    expect(card()).toHaveAttribute("data-face", "back");
    fireEvent.click(screen.getByRole("button", { name: "Volver a la credencial" }));
    expect(card()).toHaveAttribute("data-face", "front");
  });

  it("never tilts for a touch-only device", () => {
    setMedia({ reduced: false, fine: false });
    const raf = vi.spyOn(window, "requestAnimationFrame");
    renderDemoHero();
    wrap().dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }));
    expect(raf).not.toHaveBeenCalled();
    expect(tiltLayer().style.transform).toBe("");
  });

  it("leans toward a fine pointer within the cap, and settles flat when it leaves", () => {
    setMedia({ reduced: false, fine: true });
    // A manual frame queue: the loop runs exactly as many frames as we flush.
    let queue: FrameRequestCallback[] = [];
    let now = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      queue.push(cb);
      return queue.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const flush = (frames: number) => {
      for (let i = 0; i < frames && queue.length > 0; i++) {
        const batch = queue;
        queue = [];
        now += 16;
        for (const cb of batch) cb(now);
      }
    };

    renderDemoHero();
    vi.spyOn(wrap(), "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      width: 400,
      height: 250,
      right: 500,
      bottom: 300,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    } as DOMRect);

    // Pointer on the box's top-left corner.
    wrap().dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 50 }));
    flush(200);
    const match =
      /translateZ\((-?[\d.]+)px\) rotateX\((-?[\d.]+)deg\) rotateY\((-?[\d.]+)deg\) scale\(([\d.]+)\)/.exec(
        tiltLayer().style.transform,
      );
    expect(match).not.toBeNull();
    const sink = Number(match?.[1]);
    const rx = Number(match?.[2]);
    const ry = Number(match?.[3]);
    const scale = Number(match?.[4]);
    expect(rx).toBeGreaterThan(0); // the top edge recedes
    expect(ry).toBeLessThan(0); // the left edge recedes
    expect(Math.hypot(rx, ry)).toBeGreaterThan(7.9);
    expect(Math.hypot(rx, ry)).toBeLessThanOrEqual(8.01);
    expect(sink).toBeLessThan(0);
    expect(scale).toBeCloseTo(1.01, 4);
    // Pivot sits on the receding corner (top-left), so the opposite corner
    // is the one that grows toward the camera.
    const origin = tiltLayer().style.transformOrigin;
    const originMatch = /([\d.]+)% ([\d.]+)%/.exec(origin);
    expect(originMatch).not.toBeNull();
    expect(Number(originMatch?.[1])).toBeLessThan(50);
    expect(Number(originMatch?.[2])).toBeLessThan(50);
    // The hatch still rides the tilt (away from the pointer). The photo stays
    // printed on the card.
    const px = (name: string) => Number.parseFloat(wrap().style.getPropertyValue(name));
    expect(px("--lp-sec-x")).toBeGreaterThan(0);
    expect(px("--lp-sec-y")).toBeGreaterThan(0);
    expect(Math.hypot(px("--lp-sec-x"), px("--lp-sec-y"))).toBeLessThanOrEqual(18.01);
    expect(px("--lp-press")).toBeGreaterThan(0);
    expect(wrap().style.getPropertyValue("--lp-emb-x")).not.toBe("");
    expect(wrap().style.getPropertyValue("--lp-emb-y")).not.toBe("");
    // Settled: the loop stopped asking for frames.
    expect(queue).toHaveLength(0);

    wrap().dispatchEvent(new MouseEvent("pointerleave"));
    flush(200);
    expect(tiltLayer().style.transform).toBe("");
    expect(tiltLayer().style.transformOrigin).toBe("");
    for (const name of [
      "--lp-qr-x",
      "--lp-qr-y",
      "--lp-sec-x",
      "--lp-sec-y",
      "--lp-press",
      "--lp-emb-x",
      "--lp-emb-y",
    ]) {
      expect(wrap().style.getPropertyValue(name), name).toBe("");
    }
    expect(queue).toHaveLength(0);
  });

  it("turns over in two physical halves: out to the edge, swap, in with the overshoot", () => {
    vi.useFakeTimers();
    try {
      setMedia({ reduced: false, fine: false });
      renderDemoHero();
      const slab = document.querySelector(".lp-hcard-slab") as HTMLElement;

      fireEvent.click(screen.getByRole("button", { name: "Girar credencial" }));
      // First half: accelerating into the edge, still on the front.
      expect(slab).toHaveAttribute("data-turn", "out");
      expect(slab).toHaveAttribute("data-dir", "fwd");
      expect(card()).toHaveAttribute("data-face", "front");
      expect(document.querySelector(".lp-hcardwrap")).toHaveAttribute("data-turning", "true");
      expect(wrap().style.getPropertyValue("--lp-edge")).toBe("0.000");

      // Past the first half (270ms): the face swapped at the invisible edge
      // and the landing half runs.
      act(() => {
        vi.advanceTimersByTime(290);
      });
      expect(card()).toHaveAttribute("data-face", "back");
      expect(slab).toHaveAttribute("data-turn", "in");

      // A second click mid-turn is ignored: one turn at a time.
      fireEvent.click(screen.getByRole("button", { name: "Volver a la credencial" }));
      expect(slab).toHaveAttribute("data-turn", "in");

      // Past the landing half (450ms): the slab is released.
      act(() => {
        vi.advanceTimersByTime(480);
      });
      expect(slab).not.toHaveAttribute("data-turn");
      expect(document.querySelector(".lp-hcardwrap")).not.toHaveAttribute("data-turning");
      expect(wrap().style.getPropertyValue("--lp-edge")).toBe("");

      // Turning back goes the other way, like a hand turning a card back over.
      fireEvent.click(screen.getByRole("button", { name: "Volver a la credencial" }));
      expect(slab).toHaveAttribute("data-dir", "rev");
      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(card()).toHaveAttribute("data-face", "front");
      expect(slab).not.toHaveAttribute("data-turn");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a tap on the card face turns it; a cancelled press does not", () => {
    vi.useFakeTimers();
    try {
      setMedia({ reduced: false, fine: false });
      renderDemoHero();
      const faceEl = document.querySelector(".lp-hcard-front") as HTMLElement;
      const slab = document.querySelector(".lp-hcard-slab") as HTMLElement;

      fireEvent.pointerDown(faceEl, { pointerId: 8, button: 0, clientX: 40, clientY: 40 });
      fireEvent.pointerCancel(faceEl, { pointerId: 8, button: 0, clientX: 41, clientY: 41 });
      expect(card()).toHaveAttribute("data-face", "front");
      expect(slab).not.toHaveAttribute("data-turn");

      fireEvent.pointerDown(faceEl, { pointerId: 9, button: 0, clientX: 40, clientY: 40 });
      fireEvent.pointerUp(faceEl, { pointerId: 9, button: 0, clientX: 42, clientY: 41 });
      expect(slab).toHaveAttribute("data-turn", "out");
      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(card()).toHaveAttribute("data-face", "back");
      expect(screen.getByText("Girala para volver a la credencial")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("<LandingHero> — carnet flick is the named hook plan, not the document turn", () => {
  it("timers come from CARNET_HOOK_* in @dim/contract/credential", () => {
    const src = readFileSync(
      join(process.cwd(), "components", "landing", "LandingHero.tsx"),
      "utf8",
    );
    expect(src).toContain("CARNET_HOOK_TURN_OUT_MS");
    expect(src).toContain("CARNET_HOOK_TURN_IN_MS");
    expect(src).not.toMatch(/const TURN_OUT_MS = 270/);
    expect(src).not.toMatch(/const TURN_IN_MS = 450/);
    expect(src).not.toContain("settles flat while the card turns");
    expect(src).toContain("frozenLeanRef");
    expect(src).toContain("LandingHeroCopy");
    expect(src).toContain("TAP_FLIP_PX");
    expect(src).toContain("--lp-emb-x");
    expect(src).not.toContain("landingOpticFromEnv");
  });
});

describe("landing carnet — laminate light and paper shadow (not gyro)", () => {
  it("the CSS reads the wrap's light vector on both bands and peeks the edge on hover", () => {
    const css = readFileSync(join(process.cwd(), "app", "landing.css"), "utf8");
    expect(css).toContain("--lp-band-light");
    expect(css).toContain("translate: 0 0 2px");
    expect(css).not.toContain('[data-tilt="intense"]');
    expect(css).not.toContain('[data-light="spill"]');
    expect(css).not.toContain('[data-light="rich"]');
    expect(css).not.toContain("--lp-spill-x");
    expect(css).toContain("logo-mimar-mark-small.svg");
    expect(css).toContain("lp-hcard-sec-mark");
    expect(css).not.toContain("lp-hcard-circuit");
    expect(css).toContain("lp-hcard-librow::after");
    expect(css).toContain("rotateX(var(--mrx");
    expect(css).not.toContain('[data-mark="backslash"]');
    expect(css).not.toContain('[data-join="fileteado"]');
    expect(css).not.toContain("lp-hcard-join-filete");
    expect(css).toContain('[data-turning="true"]');
    expect(css).toContain("lp-hcard-shimmer");
    expect(css).toContain("--lp-qr-x");
    expect(css).toContain("calc(0.22 + var(--lp-press, 0) * 0.32)");
    expect(css).not.toContain("lp-hcard-lost-ring");
    expect(css).not.toContain("lp-hcard-lift");
    expect(css).not.toContain("lp-hcard-qr-quiet");
    expect(css).not.toContain("lp-hcard-qr-bold");
    expect(css).toContain("lp-hcard-ctx-marker");
    expect(css).not.toMatch(/\.lp \.lp-hcard \{[^}]*box-shadow/s);
    expect(css).toContain("--lp-press");
    expect(css).toContain("user-select: none");
    expect(css).toContain("inset 0 1px 2px");
    expect(css).toContain("--lp-turn-out: 270ms");
    expect(css).toContain("--lp-turn-in: 450ms");
    expect(css).toContain("lp-hcard-latent");
    expect(css).toContain("lp-hcard-latent-mark");
    expect(css).not.toContain("lp-hcard-window");
    expect(css).toContain("lp-hcard-ovd");
    expect(css).toContain("--lp-emb-x");
    expect(css).toContain("multiply");
    expect(css).not.toContain('[data-glass="deep"]');
    expect(css).toContain("width: 88%");
    expect(css).toContain("right: -7%");
    expect(css).toContain("calc(var(--lp-press, 0) * var(--lp-press, 0) * 0.62)");
    expect(css).not.toContain("calc(var(--lp-press, 0) * var(--lp-press, 0) * 0.55)");
    // The seal's fade floor is a named landing value (design-token fence C8:
    // no raw duration in a declaration); the 420ms it carries is the pin.
    expect(css).toContain("--lp-seal-fade: 420ms");
    expect(css).toContain("transition: opacity var(--lp-seal-fade) ease-out");
    expect(css).not.toContain("(var(--lp-press, 0) - 0.62) / 0.38");
    expect(css).not.toContain("lp-hcard-micro");
    expect(css).not.toContain("lp-hcard-kine");
    expect(css).not.toContain('[data-optic="full"]');
    expect(css).not.toContain("feTurbulence");
    expect(css).not.toContain("--lp-rim-x");
    expect(css).not.toContain("calc(0.07 + var(--lp-press, 0) * 0.5)");
    expect(css).toContain("--lp-ground-ink");
    expect(css).toContain("var(--color-ln-warn-700)");
    expect(css).toContain("padding-bottom: 22px");
    expect(css).toContain("bottom: 2px");
    expect(css).toContain("height: 36px");
    expect(css).toContain("--lp-edge");
    expect(css).toContain("(1 - var(--lp-edge, 0) * 0.9)");
    expect(css).not.toContain("color-mix(in srgb, var(--color-ln-ink) 14%, transparent)");
    expect(css).toContain("calc(var(--motion-ambient) * 8)");
    expect(css).toMatch(/lp-hcard-float[\s\S]{0,180}infinite/);
    expect(css).not.toContain("lp-hcard-float calc(var(--motion-ambient) * 4) ease-in-out 2");
  });
});
