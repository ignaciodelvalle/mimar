// @vitest-environment jsdom
//
// LibretaFeed — chapter 5 "the libreta fills up" animation (WU3, PO-approved
// landing plan). Guards the fail-open contract (mirrors RevealManager.tsx /
// MilestoneNav.test.tsx's style):
//   - SSR / no-JS renders every entry visible, no hiding class;
//   - prefers-reduced-motion renders every entry visible, no animation class;
//   - motion allowed → the five oldest entries are already on the page (PO
//     2026-10-02) and the newer ones start pending (collapsed), then are
//     added one by one, staggered ~700ms apart, once the chapter is reported
//     ~40% in view — each newer row enters above the earlier ones (PO,
//     2026-09-25);
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
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LibretaFeed } from "./LibretaFeed";
import { LIBRETA_EVENTS } from "./landing-content";

/** A fixed "today" for the relative dates, so no assertion depends on the clock. */
const NOW = new Date("2026-09-30T12:00:00-03:00");

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
  it("server markup shows every entry, visible, with no hiding class", () => {
    const html = renderToStaticMarkup(<LibretaFeed events={LIBRETA_EVENTS} now={NOW} />);
    for (const e of LIBRETA_EVENTS) {
      expect(html).toContain(e.title);
    }
    const rows = html.match(/class="lp-nat-entry lp-lib-row"/g) ?? [];
    expect(rows.length).toBe(LIBRETA_EVENTS.length);
    expect(html).not.toContain("lp-lib-row--pending");
    expect(html).not.toContain("lp-lib-row--in");
  });
});

describe("<LibretaFeed> — prefers-reduced-motion", () => {
  it("renders every entry with no animation class, statically", () => {
    setMatchMedia(true);
    render(<LibretaFeed events={LIBRETA_EVENTS} now={NOW} />);

    // Read titles straight off the title elements rather than via
    // screen.getByText: an asiento's eyebrow can equal its own title
    // ("Mascota registrada" is both), so text queries are ambiguous here.
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
  // PO 2026-10-02: the libreta opens with its five oldest entries already
  // written; only the four after them are added. Stated as numbers here, not
  // derived from ALREADY_WRITTEN, so a change to the constant has to change
  // this test too.
  const WRITTEN = 5;
  const ADDED = 4;
  const pending = () => document.querySelectorAll(".lp-lib-row--pending").length;
  const entered = () => document.querySelectorAll(".lp-lib-row--in").length;
  /** Rows that carry neither reveal class: on the page, never animated. */
  const plain = () =>
    Array.from(document.querySelectorAll(".lp-lib-row")).filter(
      (row) =>
        !row.classList.contains("lp-lib-row--pending") && !row.classList.contains("lp-lib-row--in"),
    );

  it("Pampa's libreta has the nine entries this choreography is built around", () => {
    expect(LIBRETA_EVENTS).toHaveLength(WRITTEN + ADDED);
  });

  it("opens with the five oldest entries written, hides the rest until the chapter intersects, then adds one every ~700ms", () => {
    vi.useFakeTimers();
    render(<LibretaFeed events={LIBRETA_EVENTS} now={NOW} />);

    // Motion is allowed: the five oldest are on the page as SSR drew them,
    // the four newer ones wait collapsed, nothing has entered yet.
    expect(plain()).toHaveLength(WRITTEN);
    expect(pending()).toBe(ADDED);
    expect(entered()).toBe(0);

    const io = FakeIntersectionObserver.instances[0];
    act(() => {
      io.callback([{ isIntersecting: true }]);
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    // The opened libreta reads first: nothing is added at the threshold itself.
    expect(entered()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(entered()).toBe(1);
    expect(pending()).toBe(ADDED - 1);

    act(() => {
      vi.advanceTimersByTime(700 * (ADDED - 1));
    });
    expect(entered()).toBe(ADDED);
    expect(pending()).toBe(0);
    // The five that were already written never animated.
    expect(plain()).toHaveLength(WRITTEN);
  });

  it("fails open ~1.4s after mount if the observer NEVER calls back at all", () => {
    vi.useFakeTimers();
    render(<LibretaFeed events={LIBRETA_EVENTS} now={NOW} />);
    expect(pending()).toBe(ADDED);

    // No callback is ever delivered on this observer instance — a broken or
    // unsupported observer, not merely an off-screen chapter (see the next
    // test for that distinction).
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(pending()).toBe(0);
    expect(entered()).toBe(ADDED);
    expect(document.querySelectorAll(".lp-lib-row")).toHaveLength(LIBRETA_EVENTS.length);
  });

  it("does NOT fail open once the observer has reported back, even as not-intersecting", () => {
    // Regression guard: the fallback used to fire unconditionally at ~1.4s
    // regardless of whether the observer was alive, so any visitor slower
    // than 1.4s to scroll down saw the whole list at once and the staggered
    // play-in never happened. IntersectionObserver always delivers an
    // initial callback right after observe() — even when NOT intersecting —
    // and that alone must disarm the fallback.
    vi.useFakeTimers();
    render(<LibretaFeed events={LIBRETA_EVENTS} now={NOW} />);

    const io = FakeIntersectionObserver.instances[0];
    act(() => {
      io.callback([{ isIntersecting: false }]); // the observer's initial callback
    });

    // Five seconds pass — well past the ~1.4s fallback window — with the
    // chapter still out of view. Nothing more may reveal.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(pending()).toBe(ADDED);
    expect(entered()).toBe(0);

    // The chapter finally scrolls into view — the stagger starts now, from
    // scratch, however late.
    act(() => {
      io.callback([{ isIntersecting: true }]);
    });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(entered()).toBe(1);
    expect(pending()).toBe(ADDED - 1);
  });

  it("fills chronologically: the oldest five sit at the bottom, each newer entry enters above them", () => {
    // Production passes the list newest-first (story-screens.tsx), so the
    // LAST five rows are the oldest entries.
    const newestFirst = [...LIBRETA_EVENTS].reverse();
    vi.useFakeTimers();
    render(<LibretaFeed events={newestFirst} now={NOW} />);

    const titleOf = (row: Element) => row.querySelector(".lp-lib-t")?.textContent ?? "";
    const writtenTitles = plain().map(titleOf);
    // The registration opens the libreta and the loss closes what is already
    // written — the refugio, the return, the consult and the 2026 vaccine are
    // what the chapter adds.
    expect(writtenTitles.at(-1)?.startsWith("Mascota registrada")).toBe(true);
    expect(writtenTitles[0]?.startsWith("Marcada como perdida")).toBe(true);
    const rows = () => Array.from(document.querySelectorAll(".lp-lib-row"));
    expect(
      rows()
        .slice(-WRITTEN)
        .every((row) => plain().includes(row)),
    ).toBe(true);

    const io = FakeIntersectionObserver.instances[0];
    act(() => {
      io.callback([{ isIntersecting: true }]);
    });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    // The first one added is the row directly above the written five.
    const firstAdded = rows()[rows().length - WRITTEN - 1];
    expect(firstAdded.classList.contains("lp-lib-row--in")).toBe(true);
    expect(titleOf(firstAdded).startsWith("Ingreso al refugio")).toBe(true);
    expect(
      rows()
        .slice(0, ADDED - 1)
        .every((row) => row.classList.contains("lp-lib-row--pending")),
    ).toBe(true);

    // Settled: the same newest-on-top order SSR renders, nothing pending.
    act(() => {
      vi.advanceTimersByTime(700 * ADDED);
    });
    expect(pending()).toBe(0);
    const settledTitles = rows().map(titleOf);
    newestFirst.forEach((e, i) => {
      expect(settledTitles[i]?.startsWith(e.title)).toBe(true);
    });
  });

  it("reserves the settled list's height before collapsing rows, and releases it once settled", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(612);
    vi.useFakeTimers();
    const { container } = render(<LibretaFeed events={LIBRETA_EVENTS} now={NOW} />);
    const feed = container.querySelector<HTMLElement>(".lp-lib-feed");

    // Rows are collapsed, and the feed still holds the full list's height.
    expect(pending()).toBe(ADDED);
    expect(feed?.style.minHeight).toBe("612px");

    const io = FakeIntersectionObserver.instances[0];
    act(() => {
      io.callback([{ isIntersecting: true }]);
    });
    act(() => {
      vi.advanceTimersByTime(700 * ADDED);
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
    const { container } = render(<LibretaFeed events={LIBRETA_EVENTS} now={NOW} />);
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(pending()).toBe(0);
    expect(container.querySelector<HTMLElement>(".lp-lib-feed")?.style.minHeight).toBe("");
  });

  it("a list no longer than the written part never animates at all", () => {
    vi.useFakeTimers();
    render(<LibretaFeed events={LIBRETA_EVENTS.slice(0, WRITTEN)} now={NOW} />);
    expect(pending()).toBe(0);
    expect(entered()).toBe(0);
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });

  // The native asiento has no stamp (apps/mobile/src/pets/LibretaScreen.tsx:
  // 350-378): who signed is its provenance line, and the date is
  // "{relativo} · {fecha}" measured from the moment the screen depicts.
  it("draws each asiento the native way: eyebrow, title, dates, provenance — no FIRMADO stamp", () => {
    const html = renderToStaticMarkup(<LibretaFeed events={LIBRETA_EVENTS} now={NOW} />);
    expect(html).not.toContain("FIRMADO");
    expect(html).toContain("Vacuna · obligatoria");
    expect(html).toContain("Verificado por vet");
    expect(html).toContain("Cargado por vos");
    // 2022-03-14 seen from 2026-09-30: four years.
    expect(html).toContain("hace 4 años · 14 de mar de 2022");
  });
});
