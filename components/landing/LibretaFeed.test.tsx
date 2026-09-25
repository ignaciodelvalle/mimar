// @vitest-environment jsdom
//
// LibretaFeed — chapter 6 "the libreta fills up" animation (WU3, PO-approved
// landing plan). Guards the fail-open contract (mirrors RevealManager.tsx /
// MilestoneNav.test.tsx's style):
//   - SSR / no-JS renders every entry visible, no hiding class;
//   - prefers-reduced-motion renders every entry visible, no animation class;
//   - motion allowed → entries start pending and reveal one by one, staggered
//     ~700ms apart, once the chapter is reported ~40% in view;
//   - if the observer never fires, the same ~1.4s fallback RevealManager uses
//     reveals everything anyway.

import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LibretaFeed } from "./LibretaFeed";
import { LIBRETA_EVENTS } from "./landing-content";

function setMatchMedia(reducedMotion: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

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

beforeEach(() => {
  setMatchMedia(false);
  FakeIntersectionObserver.instances = [];
  window.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("<LibretaFeed> — SSR / no-JS", () => {
  it("server markup shows all 10 entries, visible, with no hiding class", () => {
    const html = renderToStaticMarkup(<LibretaFeed events={LIBRETA_EVENTS} />);
    for (const e of LIBRETA_EVENTS) {
      expect(html).toContain(e.title);
    }
    const rows = html.match(/class="lp-lib-row"/g) ?? [];
    expect(rows.length).toBe(LIBRETA_EVENTS.length);
    expect(html).not.toContain("lp-lib-row--pending");
    expect(html).not.toContain("lp-lib-row--in");
  });
});

describe("<LibretaFeed> — prefers-reduced-motion", () => {
  it("renders all 10 entries with no animation class, statically", () => {
    setMatchMedia(true);
    render(<LibretaFeed events={LIBRETA_EVENTS} />);

    // Read titles straight off the title elements rather than via
    // screen.getByText: a title element can carry a trailing flag/stamp
    // child (e.g. "Vacunación: antirrábica" + a FIRMADO stamp), and
    // eventTypeLabel() can coincidentally equal a title on its own
    // ("Microchip implantado" is both), so text queries are ambiguous here.
    const titleTexts = Array.from(document.querySelectorAll(".lp-lib-t")).map(
      (el) => el.textContent ?? "",
    );
    for (const e of LIBRETA_EVENTS) {
      expect(titleTexts.some((t) => t.startsWith(e.title))).toBe(true);
    }
    expect(document.querySelectorAll(".lp-lib-row").length).toBe(LIBRETA_EVENTS.length);
    expect(document.querySelectorAll(".lp-lib-row--pending").length).toBe(0);
    expect(document.querySelectorAll(".lp-lib-row--in").length).toBe(0);
  });
});

describe("<LibretaFeed> — staged reveal (motion allowed)", () => {
  it("hides unplayed entries until the chapter intersects, then plays one every ~700ms", () => {
    vi.useFakeTimers();
    render(<LibretaFeed events={LIBRETA_EVENTS} />);

    // Motion is allowed: every entry starts pending, none has played yet.
    expect(document.querySelectorAll(".lp-lib-row--pending").length).toBe(LIBRETA_EVENTS.length);
    expect(document.querySelectorAll(".lp-lib-row--in").length).toBe(0);

    const io = FakeIntersectionObserver.instances[0];
    act(() => {
      io.callback([{ isIntersecting: true }]);
    });
    act(() => {
      vi.advanceTimersByTime(0); // flush the first (0ms) entry
    });
    expect(document.querySelectorAll(".lp-lib-row--in").length).toBe(1);

    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(document.querySelectorAll(".lp-lib-row--in").length).toBe(2);

    act(() => {
      vi.advanceTimersByTime(700 * (LIBRETA_EVENTS.length - 1));
    });
    expect(document.querySelectorAll(".lp-lib-row--in").length).toBe(LIBRETA_EVENTS.length);
    expect(document.querySelectorAll(".lp-lib-row--pending").length).toBe(0);
  });

  it("fails open ~1.4s after mount if the chapter never reports intersecting", () => {
    vi.useFakeTimers();
    render(<LibretaFeed events={LIBRETA_EVENTS} />);
    expect(document.querySelectorAll(".lp-lib-row--pending").length).toBe(LIBRETA_EVENTS.length);

    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(document.querySelectorAll(".lp-lib-row--in").length).toBe(LIBRETA_EVENTS.length);
    expect(document.querySelectorAll(".lp-lib-row--pending").length).toBe(0);
  });

  it("stamps vaccination entries FIRMADO with the overshoot class once played", () => {
    vi.useFakeTimers();
    render(<LibretaFeed events={LIBRETA_EVENTS} />);

    const io = FakeIntersectionObserver.instances[0];
    act(() => {
      io.callback([{ isIntersecting: true }]);
    });
    act(() => {
      vi.advanceTimersByTime(1400 + LIBRETA_EVENTS.length * 700);
    });

    const firmado = screen.getAllByText("FIRMADO");
    expect(firmado.length).toBeGreaterThan(0);
    for (const el of firmado) {
      expect(el.closest(".lp-lib-stamp--in")).not.toBeNull();
    }
  });
});
