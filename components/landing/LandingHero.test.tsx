// @vitest-environment jsdom
//
// LandingHero — curiosity-hook microcopy (landing microcopy train, PO-locked
// wording): "Escanealo para ver más sobre Pampa" sits between the hero
// credential and its state dots.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LandingHero } from "./LandingHero";
import { HERO_TILT_MAX_DEG, smoothTilt, tiltTowardPointer } from "./hero-card-tilt";

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

  it("caps the lean at 10° (the brief allows at most 10–12°)", () => {
    expect(HERO_TILT_MAX_DEG).toBe(10);
  });

  it("is flat with the pointer at the centre", () => {
    expect(tiltTowardPointer(200, 125, W, H)).toEqual({ rx: 0, ry: 0 });
  });

  it("turns the face toward a pointer on the right edge: the right edge recedes", () => {
    expect(tiltTowardPointer(400, 125, W, H)).toEqual({ rx: 0, ry: 10 });
  });

  it("turns the face toward a pointer on the bottom edge: the bottom edge recedes", () => {
    expect(tiltTowardPointer(200, 250, W, H)).toEqual({ rx: -10, ry: 0 });
  });

  it("leans a corner exactly as far as an edge, never 10·√2 ≈ 14.1°", () => {
    const { rx, ry } = tiltTowardPointer(0, 0, W, H);
    expect(Math.hypot(rx, ry)).toBeCloseTo(10, 9);
    // Top-left: the top edge and the left edge recede, equally.
    expect(rx).toBeCloseTo(7.0711, 4);
    expect(ry).toBeCloseTo(-7.0711, 4);
  });

  it("never exceeds the cap, even for a pointer far outside the box", () => {
    for (const [x, y] of [
      [-5000, 125],
      [5000, 9000],
      [200, -300],
      [Number.NaN, 0],
    ] as const) {
      const { rx, ry } = tiltTowardPointer(x, y, W, H);
      expect(Math.hypot(rx, ry)).toBeLessThanOrEqual(10 + 1e-9);
    }
  });

  it("is linear inside the box: half-way to the edge is half the lean (no snap)", () => {
    expect(tiltTowardPointer(300, 125, W, H)).toEqual({ rx: 0, ry: 5 });
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
    // The card rides in the same slab, so the edge turns WITH it.
    expect(slab).toContainElement(card());
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
    expect(Math.hypot(rx, ry)).toBeLessThanOrEqual(10.01);
    // Settled: the loop stopped asking for frames.
    expect(queue).toHaveLength(0);

    wrap().dispatchEvent(new MouseEvent("pointerleave"));
    flush(200);
    expect(tiltLayer().style.transform).toBe("");
    expect(queue).toHaveLength(0);
  });
});
