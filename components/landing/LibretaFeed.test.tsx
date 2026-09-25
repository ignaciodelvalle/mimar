// @vitest-environment jsdom
//
// LibretaFeed — chapter 6 "the libreta fills up" animation (WU3, PO-approved
// landing plan). Guards the fail-open contract (mirrors RevealManager.tsx /
// MilestoneNav.test.tsx's style):
//   - SSR / no-JS renders every entry visible, no hiding class;
//   - prefers-reduced-motion renders every entry visible, no animation class;
//   - motion allowed → entries start pending (collapsed) and reveal one by
//     one, staggered ~700ms apart, once the chapter is reported ~40% in view —
//     OLDEST FIRST: the bottom row of the newest-on-top list plays first and
//     each newer row enters above it (PO, 2026-09-25);
//   - the feed reserves the settled list's height while rows are collapsed,
//     so nothing outside it moves (no CLS), and releases it once settled;
//   - the ~1.4s fallback RevealManager uses only reveals everything when the
//     observer never calls back AT ALL (broken/unsupported) — a callback that
//     reports NOT intersecting still counts as "alive" and disarms it, so a
//     chapter that is merely off-screen for longer than 1.4s still waits for
//     the real intersecting callback instead of skipping the stagger.

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

  it("fails open ~1.4s after mount if the observer NEVER calls back at all", () => {
    vi.useFakeTimers();
    render(<LibretaFeed events={LIBRETA_EVENTS} />);
    expect(document.querySelectorAll(".lp-lib-row--pending").length).toBe(LIBRETA_EVENTS.length);

    // No callback is ever delivered on this observer instance — a broken or
    // unsupported observer, not merely an off-screen chapter (see the next
    // test for that distinction).
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(document.querySelectorAll(".lp-lib-row--in").length).toBe(LIBRETA_EVENTS.length);
    expect(document.querySelectorAll(".lp-lib-row--pending").length).toBe(0);
  });

  it("does NOT fail open once the observer has reported back, even as not-intersecting", () => {
    // Regression guard: the fallback used to fire unconditionally at ~1.4s
    // regardless of whether the observer was alive, so any visitor slower
    // than 1.4s to scroll down saw the whole list at once and the staggered
    // play-in never happened. IntersectionObserver always delivers an
    // initial callback right after observe() — even when NOT intersecting —
    // and that alone must disarm the fallback.
    vi.useFakeTimers();
    render(<LibretaFeed events={LIBRETA_EVENTS} />);

    const io = FakeIntersectionObserver.instances[0];
    act(() => {
      io.callback([{ isIntersecting: false }]); // the observer's initial callback
    });

    // Five seconds pass — well past the ~1.4s fallback window — with the
    // chapter still out of view. Nothing may reveal.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(document.querySelectorAll(".lp-lib-row--pending").length).toBe(LIBRETA_EVENTS.length);
    expect(document.querySelectorAll(".lp-lib-row--in").length).toBe(0);

    // The chapter finally scrolls into view — the stagger starts now, from
    // scratch, however late.
    act(() => {
      io.callback([{ isIntersecting: true }]);
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(document.querySelectorAll(".lp-lib-row--in").length).toBe(1);
    expect(document.querySelectorAll(".lp-lib-row--pending").length).toBe(
      LIBRETA_EVENTS.length - 1,
    );
  });

  it("reveals chronologically: the oldest (bottom) row first, each newer one above it", () => {
    // Production passes the list newest-first (story-screens.tsx), so the
    // LAST row is the oldest entry. It must be the first to appear, and each
    // later reveal must be the row directly above the previous one.
    const newestFirst = [...LIBRETA_EVENTS].reverse();
    vi.useFakeTimers();
    render(<LibretaFeed events={newestFirst} />);

    const io = FakeIntersectionObserver.instances[0];
    act(() => {
      io.callback([{ isIntersecting: true }]);
    });
    const rowStates = () =>
      Array.from(document.querySelectorAll(".lp-lib-row")).map((row) =>
        row.classList.contains("lp-lib-row--in"),
      );

    act(() => {
      vi.advanceTimersByTime(0);
    });
    const afterFirst = rowStates();
    expect(afterFirst.at(-1)).toBe(true);
    expect(afterFirst.slice(0, -1).every((played) => !played)).toBe(true);
    const firstTitle = document.querySelector(".lp-lib-row--in .lp-lib-t")?.textContent ?? "";
    expect(firstTitle.startsWith(LIBRETA_EVENTS[0].title)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(700);
    });
    const afterSecond = rowStates();
    expect(afterSecond.slice(-2)).toEqual([true, true]);
    expect(afterSecond.slice(0, -2).every((played) => !played)).toBe(true);

    // Settled: the same newest-on-top order SSR renders, every row played.
    act(() => {
      vi.advanceTimersByTime(700 * newestFirst.length);
    });
    expect(rowStates().every(Boolean)).toBe(true);
    const settledTitles = Array.from(document.querySelectorAll(".lp-lib-t")).map(
      (el) => el.textContent ?? "",
    );
    newestFirst.forEach((e, i) => {
      expect(settledTitles[i]?.startsWith(e.title)).toBe(true);
    });
  });

  it("reserves the settled list's height before collapsing rows, and releases it once settled", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(612);
    vi.useFakeTimers();
    const { container } = render(<LibretaFeed events={LIBRETA_EVENTS} />);
    const feed = container.querySelector<HTMLElement>(".lp-lib-feed");

    // Rows are collapsed, and the feed still holds the full list's height.
    expect(document.querySelectorAll(".lp-lib-row--pending").length).toBe(LIBRETA_EVENTS.length);
    expect(feed?.style.minHeight).toBe("612px");

    const io = FakeIntersectionObserver.instances[0];
    act(() => {
      io.callback([{ isIntersecting: true }]);
    });
    act(() => {
      vi.advanceTimersByTime(700 * (LIBRETA_EVENTS.length - 1));
    });
    // The last row has only just started entering: still reserved.
    expect(feed?.style.minHeight).toBe("612px");

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(feed?.style.minHeight).toBe("");
  });

  it("the fail-open path releases the reserved height along with the full list", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(612);
    vi.useFakeTimers();
    const { container } = render(<LibretaFeed events={LIBRETA_EVENTS} />);
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(document.querySelectorAll(".lp-lib-row--in").length).toBe(LIBRETA_EVENTS.length);
    expect(container.querySelector<HTMLElement>(".lp-lib-feed")?.style.minHeight).toBe("");
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
