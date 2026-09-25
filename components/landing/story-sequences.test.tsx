// @vitest-environment jsdom
//
// The story's animated chapters — vet (PS6), lost (PS7), shelter (PS8), the
// Estado map wave (PS9) — and the rail's progress (PS10). Guards the §3 motion
// rules of the 2026-09-25 handoff, in the fail-open shape LibretaFeed.test.tsx
// already guards for the libreta:
//   - SSR renders each chapter's FINAL step, with no animation class;
//   - reduced motion renders the final step, no animation class, no observer;
//   - motion allowed → the chapter rewinds to step 0 and plays once, when its
//     observer reports ~40% in view; a never-firing observer fails open;
//   - at most one sequence plays at a time;
//   - the step list is real buttons: a click jumps, aria-current follows.
// Facts are checked against the seed module in
// __tests__/flagship-pampa-consistency.test.tsx.

import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "@testing-library/jest-dom/vitest";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StorySection } from "./StorySection";
import { CHAPTERS } from "./landing-content";
import { EstadoConsole } from "./story-screens";
import { LOST_SEQUENCE, SHELTER_SEQUENCE, SequenceChapter, VET_SEQUENCE } from "./story-sequences";
import { resetChapterSequencesForTests } from "./use-chapter-sequence";

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

const SEQUENCES = [
  { key: "vet", spec: VET_SEQUENCE },
  { key: "anon", spec: LOST_SEQUENCE },
  { key: "refugio", spec: SHELTER_SEQUENCE },
] as const;

function chapter(key: string) {
  const index = CHAPTERS.findIndex((c) => c.key === key);
  const c = CHAPTERS[index];
  if (!c) throw new Error(`no chapter ${key}`);
  return { chapter: c, index };
}

function stepOf(key: string): number {
  return Number(document.getElementById(`cap-${key}`)?.getAttribute("data-step"));
}

const ANIMATION_CLASSES = /lp-seq-in|lp-seq-pending|lp-map-grid--(in|pending)/;

beforeEach(() => {
  setMatchMedia(false);
  resetChapterSequencesForTests();
  FakeIntersectionObserver.instances = [];
  window.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("story sequences — SSR renders the final state", () => {
  it.each(SEQUENCES)("$key: final step, no animation class, last item current", ({ key, spec }) => {
    const { chapter: c, index } = chapter(key);
    const html = renderToStaticMarkup(<SequenceChapter chapter={c} index={index} />);
    expect(html).toContain(`data-step="${spec.total - 1}"`);
    expect(html).not.toMatch(ANIMATION_CLASSES);
    const current = html.match(/aria-current="step"/g) ?? [];
    expect(current).toHaveLength(1);
    // The final device step is the one on the page.
    expect(html).toContain(renderToStaticMarkup(spec.device(spec.total - 1, false)));
  });

  it("the whole story SSR carries no animation class anywhere", () => {
    const html = renderToStaticMarkup(<StorySection />);
    expect(html).not.toMatch(ANIMATION_CLASSES);
    // Every animated chapter rests on its last step.
    for (const { key, spec } of SEQUENCES) {
      expect(html).toMatch(
        new RegExp(`id="cap-${key}" data-sequence="${key}" data-step="${spec.total - 1}"`),
      );
    }
  });
});

describe("story sequences — reduced motion", () => {
  it.each(SEQUENCES)("$key: stays on the final step, no class, no observer", ({ key, spec }) => {
    setMatchMedia(true);
    const { chapter: c, index } = chapter(key);
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    expect(stepOf(key)).toBe(spec.total - 1);
    expect(container.innerHTML).not.toMatch(ANIMATION_CLASSES);
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });

  it("the step list still navigates (navigation is not animation)", () => {
    setMatchMedia(true);
    const { chapter: c, index } = chapter("anon");
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    const buttons = container.querySelectorAll<HTMLButtonElement>(".lp-seq-step");
    expect(buttons).toHaveLength(LOST_SEQUENCE.items.length);
    fireEvent.click(buttons[0] as HTMLButtonElement);
    expect(stepOf("anon")).toBe(0);
    expect(buttons[0]).toHaveAttribute("aria-current", "step");
    expect(buttons[4]).not.toHaveAttribute("aria-current");
    expect(container.innerHTML).not.toMatch(ANIMATION_CLASSES);
  });
});

describe("story sequences — motion allowed", () => {
  it("rewinds to step 0 and plays once, stepMs apart, when ~40% in view", () => {
    vi.useFakeTimers();
    const { chapter: c, index } = chapter("anon");
    render(<SequenceChapter chapter={c} index={index} />);
    expect(stepOf("anon")).toBe(0);
    const io = FakeIntersectionObserver.instances[0];
    expect(io).toBeDefined();
    act(() => io?.callback([{ isIntersecting: true }]));
    for (let i = 1; i < LOST_SEQUENCE.total; i++) {
      act(() => {
        vi.advanceTimersByTime(LOST_SEQUENCE.stepMs);
      });
      expect(stepOf("anon")).toBe(i);
    }
    act(() => {
      vi.advanceTimersByTime(LOST_SEQUENCE.stepMs * 5);
    });
    expect(stepOf("anon")).toBe(LOST_SEQUENCE.total - 1);
  });

  it("the vet form fills field by field, then stamps", () => {
    vi.useFakeTimers();
    const { chapter: c, index } = chapter("vet");
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    expect(container.querySelectorAll(".lp-vf .lp-seq-in")).toHaveLength(1);
    act(() => FakeIntersectionObserver.instances[0]?.callback([{ isIntersecting: true }]));
    act(() => {
      vi.advanceTimersByTime(VET_SEQUENCE.stepMs * 4);
    });
    expect(container.querySelectorAll(".lp-vf .lp-seq-in")).toHaveLength(5);
    expect(container.querySelector(".lp-lib-stamp--in")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(VET_SEQUENCE.stepMs * 3);
    });
    expect(container.querySelector(".lp-lib-stamp--in")).not.toBeNull();
    expect(container.querySelectorAll(".lp-seq-pending")).toHaveLength(0);
  });

  it("fails open to the final step when the observer never calls back", () => {
    vi.useFakeTimers();
    const { chapter: c, index } = chapter("refugio");
    render(<SequenceChapter chapter={c} index={index} />);
    expect(stepOf("refugio")).toBe(0);
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(stepOf("refugio")).toBe(SHELTER_SEQUENCE.total - 1);
  });

  it("plays one sequence at a time: a second waits for the first to finish", () => {
    vi.useFakeTimers();
    const vet = chapter("vet");
    const anon = chapter("anon");
    render(
      <>
        <SequenceChapter chapter={vet.chapter} index={vet.index} />
        <SequenceChapter chapter={anon.chapter} index={anon.index} />
      </>,
    );
    const [ioVet, ioAnon] = FakeIntersectionObserver.instances;
    act(() => ioVet?.callback([{ isIntersecting: true }]));
    act(() => ioAnon?.callback([{ isIntersecting: true }]));
    act(() => {
      vi.advanceTimersByTime(VET_SEQUENCE.stepMs);
    });
    expect(stepOf("vet")).toBe(1);
    expect(stepOf("anon")).toBe(0);
    act(() => {
      vi.advanceTimersByTime(VET_SEQUENCE.stepMs * (VET_SEQUENCE.total - 2));
    });
    expect(stepOf("vet")).toBe(VET_SEQUENCE.total - 1);
    act(() => {
      vi.advanceTimersByTime(LOST_SEQUENCE.stepMs);
    });
    expect(stepOf("anon")).toBe(1);
  });

  it("a click on a step stops the autoplay and shows that step", () => {
    vi.useFakeTimers();
    const { chapter: c, index } = chapter("refugio");
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    act(() => FakeIntersectionObserver.instances[0]?.callback([{ isIntersecting: true }]));
    const buttons = container.querySelectorAll<HTMLButtonElement>(".lp-seq-step");
    fireEvent.click(buttons[2] as HTMLButtonElement);
    expect(stepOf("refugio")).toBe(2);
    act(() => {
      vi.advanceTimersByTime(SHELTER_SEQUENCE.stepMs * 10);
    });
    expect(stepOf("refugio")).toBe(2);
    expect(buttons[2]).toHaveAttribute("aria-current", "step");
  });

  it("names whose phone it is, per step", () => {
    const { chapter: c, index } = chapter("anon");
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    const buttons = container.querySelectorAll<HTMLButtonElement>(".lp-seq-step");
    fireEvent.click(buttons[3] as HTMLButtonElement);
    expect(container.querySelector(".lp-seq-who")?.textContent).toBe(
      "Celular del vecino · sin app",
    );
    fireEvent.click(buttons[4] as HTMLButtonElement);
    expect(container.querySelector(".lp-seq-who")?.textContent).toMatch(/^App de /);
  });
});

describe("Estado — the map fills in once (PS9)", () => {
  it("SSR and reduced motion: the tinted map, no wave class", () => {
    expect(renderToStaticMarkup(<EstadoConsole />)).not.toMatch(ANIMATION_CLASSES);
    setMatchMedia(true);
    const { container } = render(<EstadoConsole />);
    expect(container.innerHTML).not.toMatch(ANIMATION_CLASSES);
  });

  it("motion allowed: dimmed until in view, then the wave, each tile keyed to its row", () => {
    vi.useFakeTimers();
    const { container } = render(
      <div id="cap-estado">
        <EstadoConsole />
      </div>,
    );
    const grid = container.querySelector('[data-section="estado-map"]');
    expect(grid).toHaveClass("lp-map-grid--pending");
    // CountUp tiles observe themselves too; the wave observes the chapter.
    const io = FakeIntersectionObserver.instances.find(
      (o) => (o.observe.mock.calls[0]?.[0] as HTMLElement | undefined)?.id === "cap-estado",
    );
    expect(io).toBeDefined();
    act(() => io?.callback([{ isIntersecting: true }]));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(grid).toHaveClass("lp-map-grid--in");
    const tile = container.querySelector<HTMLElement>(".lp-mtile");
    expect(tile?.style.getPropertyValue("--row")).not.toBe("");
  });
});

describe("rail — progress (PS10)", () => {
  it("SSR: a track and a mobile bar, the first chapter current and PERDIDA only on 3 and 4", () => {
    const html = renderToStaticMarkup(<StorySection />);
    expect(html).toContain("lp-rail-track");
    expect(html).toContain("lp-rail-progress");
    expect(html).toContain("scaleY(0)");
    const rail = html.slice(html.indexOf('data-section="story-rail"'));
    expect(rail.indexOf('aria-current="step"')).toBeLessThan(rail.indexOf("Veterinaria"));
    expect(CHAPTERS.filter((c) => c.state === "lost").map((c) => c.key)).toEqual([
      "anon",
      "refugio",
    ]);
  });
});
