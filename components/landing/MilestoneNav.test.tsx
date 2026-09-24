// @vitest-environment jsdom
//
// MilestoneNav — the landing's progressive-reveal "Continuar ↓" CTA
// (PO-approved design 2026-08-02). Guards the locked behaviors:
//   - active milestone tracks scroll (45%-of-viewport rule, StorySection's
//     scroll-spy vocabulary) and the CTA names the NEXT milestone;
//   - the CTA disappears once the LAST milestone is reached (FAQ + footer are
//     outside the sequence);
//   - the jump uses the scrollToChapter pattern: smooth ONLY when motion is
//     allowed AND the document has focus — reduced motion still NAVIGATES,
//     just instantly (motion preference is not a navigation preference);
//   - nothing renders before hydration (no-JS visitors never see a dead
//     affordance) — exercised implicitly: rendering IS hydration in jsdom;
//   - the CLICK LATCH (PO-5, 2026-08-05): after a click navigates to milestone
//     M the CTA offers M+1 no matter what the scroll-spy says, until the
//     visitor scrolls away from where the click parked them.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MILESTONES, MilestoneNav, scrollToMilestone } from "./MilestoneNav";

const VIEWPORT_H = 800; // window.innerHeight for every test
const MID = VIEWPORT_H * 0.45; // the activation line

/** Create (or move) the six milestone anchor elements at the given tops. */
function placeSections(tops: Partial<Record<string, number>>) {
  for (const m of MILESTONES) {
    let el = document.getElementById(m.id);
    if (!el) {
      el = document.createElement("div");
      el.id = m.id;
      document.body.appendChild(el);
    }
    const top = tops[m.id] ?? MID + 1000; // default: far below the line
    el.getBoundingClientRect = () =>
      ({ top, bottom: top + 500, left: 0, right: 0, width: 0, height: 500 }) as DOMRect;
  }
}

/**
 * Move the page to `y` and re-place the sections at the tops they would then
 * have, then fire the scroll event the browser would fire. `window.scrollTo` is
 * a spy in these tests (jsdom does not lay anything out), so the scroll a click
 * asks for has to be simulated by hand — which is exactly what lets a test
 * assert what happens MID-FLIGHT as well as after the page settles.
 */
function scrollTo(y: number, tops: Partial<Record<string, number>>) {
  Object.defineProperty(window, "scrollY", { value: y, writable: true });
  placeSections(tops);
  fireEvent.scroll(window);
}

function setMatchMedia(reducedMotion: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  Object.defineProperty(window, "innerHeight", { value: VIEWPORT_H, writable: true });
  Object.defineProperty(window, "scrollY", { value: 0, writable: true });
  window.scrollTo = vi.fn();
  document.hasFocus = vi.fn(() => true);
  setMatchMedia(false);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("<MilestoneNav> — active tracking + CTA label", () => {
  it("at the top of the page, offers the SECOND milestone as next", () => {
    placeSections({ top: 40 }); // hero in view, everything else below the line
    render(<MilestoneNav />);

    expect(
      screen.getByRole("button", {
        name: "Continuar a la próxima sección: Emergencias, sin cuenta",
      }),
    ).toBeInTheDocument();
  });

  it("relabels per milestone as sections cross 45% of the viewport", () => {
    placeSections({ top: 40 });
    render(<MilestoneNav />);

    // Scroll state: hero + crisis + bond have crossed the line → active is
    // "vinculo", next is the story section.
    placeSections({ top: -2000, crisis: -1200, vinculo: 100 });
    fireEvent.scroll(window);

    expect(
      screen.getByRole("button", {
        name: "Continuar a la próxima sección: Una mascota, muchas manos",
      }),
    ).toBeInTheDocument();
  });

  it("hides once the LAST milestone (empezar) is reached — FAQ/footer are outside the sequence", () => {
    placeSections({ top: 40 });
    render(<MilestoneNav />);
    expect(screen.getByRole("button")).toBeInTheDocument();

    placeSections({
      top: -6000,
      crisis: -5000,
      vinculo: -4000,
      idea: -3000,
      features: -1000,
      empezar: 100,
    });
    fireEvent.scroll(window);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps offering Empezar while the visitor is between features and empezar (the FAQ zone)", () => {
    placeSections({ top: -6000, crisis: -5000, vinculo: -4000, idea: -3000, features: -500 });
    render(<MilestoneNav />);

    expect(
      screen.getByRole("button", { name: "Continuar a la próxima sección: Empezar" }),
    ).toBeInTheDocument();
  });
});

describe("<MilestoneNav> — the jump (scrollToChapter pattern)", () => {
  it("scrolls smoothly to the next milestone when motion is allowed and the document has focus", () => {
    placeSections({ top: 40, crisis: 900 });
    render(<MilestoneNav />);

    fireEvent.click(screen.getByRole("button"));

    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 900 - 84, // section top compensated by the sticky-nav offset
      behavior: "smooth",
    });
  });

  it("jumps INSTANTLY (behavior auto) under prefers-reduced-motion — but still jumps", () => {
    setMatchMedia(true);
    placeSections({ top: 40, crisis: 900 });
    render(<MilestoneNav />);

    const cta = screen.getByRole("button");
    // Visible under reduced motion too: motion preference ≠ navigation preference.
    expect(cta).toBeInTheDocument();

    fireEvent.click(cta);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 900 - 84, behavior: "auto" });
  });

  it("falls back to an instant jump when the document does not have focus", () => {
    document.hasFocus = vi.fn(() => false);
    placeSections({ top: 40, crisis: 900 });
    render(<MilestoneNav />);

    fireEvent.click(screen.getByRole("button"));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 900 - 84, behavior: "auto" });
  });

  it("clamps the target to 0 so an early section never produces a negative scroll", () => {
    // Exercised on the helper directly: a section whose top sits above the
    // sticky-nav offset (e.g. jumping back to #top) must not ask the browser
    // for a negative scroll position.
    placeSections({ top: 50 });
    scrollToMilestone("top");
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });
});

/**
 * The click latch (PO-5, 2026-08-05), exercised against the exact geometry that
 * exposed the skip in CI (1440×800, measured in commit 2d952dc6):
 *
 *   #crisis top 823 → the click asks for scrollY 823 − 84 = 739
 *   #vinculo top 986 (the crisis band is only 163px tall)
 *
 * Settled at 739, #vinculo's top is 247 — already above the 45% line (360) — so
 * the scroll-spy calls `vinculo` active and, before the latch, the CTA offered
 * `idea`: one milestone skipped on every click. The latch's whole job is that
 * the settled CTA reads "El vínculo".
 */
const CRISIS_TOP = 823;
const VINCULO_TOP = 986;
const IDEA_TOP = 1600;
const CLICK_TARGET_Y = CRISIS_TOP - 84;

/** Section tops as they read from the viewport once the page sits at `y`. */
function geometryAt(y: number) {
  return {
    top: 0 - y,
    crisis: CRISIS_TOP - y,
    vinculo: VINCULO_TOP - y,
    idea: IDEA_TOP - y,
  };
}

function ctaName(): string {
  return screen.getByRole("button").getAttribute("aria-label") ?? "";
}

describe("<MilestoneNav> — the click latch (the CTA advances from what it NAVIGATED to)", () => {
  beforeEach(() => {
    placeSections(geometryAt(0));
  });

  it("offers the milestone AFTER the one it just navigated to, even though the spy has moved on", () => {
    render(<MilestoneNav />);
    expect(ctaName()).toBe("Continuar a la próxima sección: Emergencias, sin cuenta");

    fireEvent.click(screen.getByRole("button"));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: CLICK_TARGET_Y, behavior: "smooth" });

    // The page settles where the click aimed. The spy now says `vinculo` (its
    // top, 247, crossed the 360 line) — the latch says the visitor was sent to
    // `crisis`, and the latch wins.
    scrollTo(CLICK_TARGET_Y, geometryAt(CLICK_TARGET_Y));
    expect(ctaName()).toBe("Continuar a la próxima sección: El vínculo");
  });

  it("does not wobble mid-flight: the label is the destination from the click onward", () => {
    render(<MilestoneNav />);
    fireEvent.click(screen.getByRole("button"));

    // A frame of the smooth scroll where the spy would already read `vinculo`.
    scrollTo(710, geometryAt(710));
    expect(ctaName()).toBe("Continuar a la próxima sección: El vínculo");

    scrollTo(CLICK_TARGET_Y, geometryAt(CLICK_TARGET_Y));
    expect(ctaName()).toBe("Continuar a la próxima sección: El vínculo");
  });

  it("hands governance back to the scroll-spy once the visitor scrolls away themselves", () => {
    render(<MilestoneNav />);
    fireEvent.click(screen.getByRole("button"));
    scrollTo(CLICK_TARGET_Y, geometryAt(CLICK_TARGET_Y));
    expect(ctaName()).toBe("Continuar a la próxima sección: El vínculo");

    // Manual scroll well past the parked position: `idea` crosses the line, so
    // the CTA follows the spy again and offers the milestone after it.
    scrollTo(1700, geometryAt(1700));
    expect(ctaName()).toBe("Continuar a la próxima sección: Cuando no es un buen día");
  });

  it("releases the latch when a scroll RECEDES from the target mid-flight (a hand on the page)", () => {
    render(<MilestoneNav />);
    fireEvent.click(screen.getByRole("button"));

    scrollTo(710, geometryAt(710)); // still closing on 739
    expect(ctaName()).toBe("Continuar a la próxima sección: El vínculo");

    // A smooth scroll only ever closes its gap; widening it means a human took
    // over. Back at the top, the spy offers the second milestone again.
    scrollTo(300, geometryAt(300));
    expect(ctaName()).toBe("Continuar a la próxima sección: Emergencias, sin cuenta");
  });

  it("behaves identically under prefers-reduced-motion (the jump is instant, the latch is not)", () => {
    setMatchMedia(true);
    render(<MilestoneNav />);

    fireEvent.click(screen.getByRole("button"));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: CLICK_TARGET_Y, behavior: "auto" });

    // An instant jump reports its destination on the very first scroll event.
    scrollTo(CLICK_TARGET_Y, geometryAt(CLICK_TARGET_Y));
    expect(ctaName()).toBe("Continuar a la próxima sección: El vínculo");
  });

  it("steps exactly one milestone per consecutive click", () => {
    render(<MilestoneNav />);
    fireEvent.click(screen.getByRole("button"));
    scrollTo(CLICK_TARGET_Y, geometryAt(CLICK_TARGET_Y));

    fireEvent.click(screen.getByRole("button"));
    expect(window.scrollTo).toHaveBeenLastCalledWith({
      top: VINCULO_TOP - 84,
      behavior: "smooth",
    });
    expect(ctaName()).toBe("Continuar a la próxima sección: Una mascota, muchas manos");
  });
});

describe("<MilestoneNav> — accessible name contract", () => {
  it("visible text is contained in the accessible name (WCAG 2.5.3 label-in-name)", () => {
    placeSections({ top: 40 });
    render(<MilestoneNav />);

    const cta = screen.getByRole("button");
    expect(cta).toHaveTextContent("Continuar");
    expect(cta.getAttribute("aria-label")).toMatch(/^Continuar a la próxima sección: /);
  });
});
