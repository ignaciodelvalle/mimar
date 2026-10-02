// @vitest-environment jsdom
//
// LandingHero — curiosity-hook microcopy (landing microcopy train, PO-locked
// wording): "Escanealo para ver más sobre Pampa" sits between the hero
// credential and its state dots.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LandingHero } from "./LandingHero";
import {
  HERO_PARALLAX_PATTERN_PX,
  HERO_PARALLAX_PHOTO_PX,
  HERO_TILT_MAX_DEG,
  heroParallax,
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

describe("<LandingHero> — the quiet issuer line (PO 2026-10-02, v2)", () => {
  function head(face: "front" | "back"): HTMLElement {
    return document.querySelector(`.lp-hcard-${face} .lp-hcard-head`) as HTMLElement;
  }

  it("reads issuer · document type · turn control, on both faces", () => {
    renderDemoHero();
    const front = head("front");
    expect(within(front).getByText("miMAR")).toHaveClass("lp-hcard-issuer-name");
    expect(within(front).getByText("Credencial digital")).toHaveClass("lp-hcard-doctype");
    expect(within(front).getByRole("button", { name: "Girar credencial" })).toBeInTheDocument();

    const back = head("back");
    expect(within(back).getByText("miMAR")).toHaveClass("lp-hcard-issuer-name");
    expect(within(back).getByText("Libreta sanitaria")).toHaveClass("lp-hcard-doctype");
    expect(back.querySelector(".lp-hcard-flip")).toHaveAccessibleName("Volver a la credencial");
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
      "/perdidas",
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
});

describe("heroParallax — the layers slide at different depths, within bounds", () => {
  it("keeps the photo's slide within the brief's 2–4px and the hatch's under it", () => {
    expect(HERO_PARALLAX_PHOTO_PX).toBe(3);
    expect(HERO_PARALLAX_PATTERN_PX).toBe(1.5);
  });

  it("is still when the card is flat", () => {
    expect(heroParallax({ rx: 0, ry: 0 })).toEqual({
      photo: { x: 0, y: 0 },
      pattern: { x: 0, y: 0 },
    });
  });

  it("slides the photo TOWARD the pointer and the hatch AWAY from it", () => {
    // Full lean toward a pointer on the right edge (tiltTowardPointer's ry: 1.5).
    expect(heroParallax({ rx: 0, ry: 1.5 })).toEqual({
      photo: { x: 3, y: 0 },
      pattern: { x: -1.5, y: 0 },
    });
    // Full lean toward a pointer on the bottom edge (rx: -1.5).
    expect(heroParallax({ rx: -1.5, ry: 0 })).toEqual({
      photo: { x: 0, y: 3 },
      pattern: { x: 0, y: -1.5 },
    });
  });

  it("follows the lean linearly: half the lean is half the slide", () => {
    expect(heroParallax({ rx: 0, ry: 0.75 }).photo).toEqual({ x: 1.5, y: 0 });
  });

  it("agrees with the pointer it came from: a corner slides the photo into that corner", () => {
    const { photo, pattern } = heroParallax(tiltTowardPointer(0, 0, 400, 250));
    expect(photo.x).toBeCloseTo(-2.1213, 4);
    expect(photo.y).toBeCloseTo(-2.1213, 4);
    expect(Math.hypot(photo.x, photo.y)).toBeCloseTo(3, 9);
    expect(pattern.x).toBeGreaterThan(0);
    expect(pattern.y).toBeGreaterThan(0);
  });

  it("never slides past its constant, whatever tilt it is handed", () => {
    for (const tilt of [
      { rx: 40, ry: -40 },
      { rx: 0, ry: 900 },
      { rx: Number.NaN, ry: 1.5 },
      { rx: Number.POSITIVE_INFINITY, ry: 0 },
    ]) {
      const { photo, pattern } = heroParallax(tilt);
      expect(Math.hypot(photo.x, photo.y)).toBeLessThanOrEqual(3 + 1e-9);
      expect(Math.hypot(pattern.x, pattern.y)).toBeLessThanOrEqual(1.5 + 1e-9);
    }
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
    // The hover shadow rides in the slab too, decorative.
    expect(slab.querySelector(":scope > .lp-hcard-lift")).toHaveAttribute("aria-hidden", "true");
    // The card rides in the same slab, so the edge turns WITH it.
    expect(slab).toContainElement(card());
  });

  it("prints the security hatch under both faces, as decoration only", () => {
    renderDemoHero();
    for (const face of [".lp-hcard-front", ".lp-hcard-back"]) {
      const hatch = card().querySelector(`${face} > .lp-hcard-sec`);
      expect(hatch, face).toHaveAttribute("aria-hidden", "true");
      expect(hatch, face).toBeEmptyDOMElement();
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
    const match = /rotateX\((-?[\d.]+)deg\) rotateY\((-?[\d.]+)deg\)/.exec(
      tiltLayer().style.transform,
    );
    expect(match).not.toBeNull();
    const rx = Number(match?.[1]);
    const ry = Number(match?.[2]);
    expect(rx).toBeGreaterThan(0); // the top edge recedes
    expect(ry).toBeLessThan(0); // the left edge recedes
    expect(Math.hypot(rx, ry)).toBeLessThanOrEqual(1.51);
    // The parallax rides the same frame: the photo slides toward the pointer
    // (up-left), the hatch away from it, each within its own bound.
    const px = (name: string) => Number.parseFloat(tiltLayer().style.getPropertyValue(name));
    expect(px("--lp-photo-x")).toBeLessThan(0);
    expect(px("--lp-photo-y")).toBeLessThan(0);
    expect(Math.hypot(px("--lp-photo-x"), px("--lp-photo-y"))).toBeLessThanOrEqual(3.01);
    expect(px("--lp-sec-x")).toBeGreaterThan(0);
    expect(px("--lp-sec-y")).toBeGreaterThan(0);
    expect(Math.hypot(px("--lp-sec-x"), px("--lp-sec-y"))).toBeLessThanOrEqual(1.51);
    // Settled: the loop stopped asking for frames.
    expect(queue).toHaveLength(0);

    wrap().dispatchEvent(new MouseEvent("pointerleave"));
    flush(200);
    expect(tiltLayer().style.transform).toBe("");
    for (const name of ["--lp-photo-x", "--lp-photo-y", "--lp-sec-x", "--lp-sec-y"]) {
      expect(tiltLayer().style.getPropertyValue(name), name).toBe("");
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
});
