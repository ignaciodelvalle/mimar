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
//   - back/forward controls (PO 2026-09-30, no step list): named in
//     Spanish, disabled at the ends, one step per click, autoplay stops;
//   - an actor change slides the outgoing device out; each person's device
//     carries its own case colour.
// Facts are checked against the seed module in
// __tests__/flagship-pampa-consistency.test.tsx.

import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "@testing-library/jest-dom/vitest";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StorySection } from "./StorySection";
import { CHAPTERS } from "./landing-content";
import { EstadoConsole } from "./story-screens";
import {
  ACTORS,
  LOST_INBOX_STEP,
  LOST_POSTER_STEP,
  LOST_PUBLIC_STEP,
  LOST_REPORT_STEP,
  LOST_SEQUENCE,
  LOST_SIGHTING_STEP,
  OWNER_FROM,
  SHELTER_SEQUENCE,
  SIGHTING_CONTACT,
  SIGHTING_MESSAGE,
  SequenceChapter,
  VET_NOTE,
  VET_SEQUENCE,
} from "./story-sequences";
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

const ANIMATION_CLASSES =
  /lp-seq-in|lp-seq-pending|lp-seq-slide|lp-seq-type|lp-seq-late|lp-seq-swap|lp-seq-dev-(in|out)|lp-map-grid--(in|pending)/;

function arrows(container: HTMLElement) {
  const prev = container.querySelector<HTMLButtonElement>('button[aria-label="Paso anterior"]');
  const next = container.querySelector<HTMLButtonElement>('button[aria-label="Paso siguiente"]');
  if (!prev || !next) throw new Error("missing ‹ › controls");
  return { prev, next };
}

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
  it.each(SEQUENCES)("$key: final step, no animation class, forward disabled", ({ key, spec }) => {
    const { chapter: c, index } = chapter(key);
    const html = renderToStaticMarkup(<SequenceChapter chapter={c} index={index} />);
    expect(html).toContain(`data-step="${spec.total - 1}"`);
    expect(html).not.toMatch(ANIMATION_CLASSES);
    // No step list any more (PO 2026-09-30): no visible lead, no labels.
    expect(html).not.toContain("lp-seq-step");
    expect(html).not.toContain("lp-ch-lead");
    // Resting on the last step: forward is disabled, back is not.
    expect(html).toMatch(/<button[^>]*aria-label="Paso siguiente"[^>]*disabled=""/);
    expect(html).not.toMatch(/<button[^>]*aria-label="Paso anterior"[^>]*disabled=""/);
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

  it("‹ › still navigate, statically (navigation is not animation)", () => {
    setMatchMedia(true);
    const { chapter: c, index } = chapter("refugio");
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    const { prev, next } = arrows(container);
    // Back across the tablet → phone hand-over: no exiting device, no class.
    for (let i = SHELTER_SEQUENCE.total - 2; i >= 0; i--) {
      fireEvent.click(prev);
      expect(stepOf("refugio")).toBe(i);
      expect(container.innerHTML).not.toMatch(ANIMATION_CLASSES);
      expect(container.querySelectorAll(".lp-seq-case")).toHaveLength(1);
    }
    expect(prev).toBeDisabled();
    fireEvent.click(next);
    expect(stepOf("refugio")).toBe(1);
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

  it("the vet types her note word by word, then the portal signs it", () => {
    vi.useFakeTimers();
    const { chapter: c, index } = chapter("vet");
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    act(() => FakeIntersectionObserver.instances[0]?.callback([{ isIntersecting: true }]));
    act(() => {
      vi.advanceTimersByTime(VET_SEQUENCE.stepMs * 2);
    });
    expect(stepOf("vet")).toBe(2);
    // Step 2 is the quick-capture card: the note types in, one span per word.
    const typed = container.querySelector(".lp-seq-type");
    expect(typed?.children).toHaveLength(VET_NOTE.split(" ").length);
    expect(typed?.textContent).toBe(VET_NOTE);
    expect(container.textContent).toContain("Registrá lo que atendiste");
    act(() => {
      vi.advanceTimersByTime(VET_SEQUENCE.stepMs * 5);
    });
    expect(stepOf("vet")).toBe(VET_SEQUENCE.total - 1);
    expect(container.querySelector(".lp-seq-type")).toBeNull();
    expect(container.textContent).toContain("Evento clínico firmado.");
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

  it("‹ › carry Spanish names, stop the autoplay and move one step each", () => {
    vi.useFakeTimers();
    const { chapter: c, index } = chapter("refugio");
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    const { prev, next } = arrows(container);
    expect(container.querySelector("fieldset.lp-seq-nav")).toHaveAttribute(
      "aria-label",
      `Pasos del capítulo ${index + 1}`,
    );
    // Rewound to step 0: back is disabled at the start.
    expect(prev).toBeDisabled();
    expect(next).toBeEnabled();
    act(() => FakeIntersectionObserver.instances[0]?.callback([{ isIntersecting: true }]));
    fireEvent.click(next);
    expect(stepOf("refugio")).toBe(1);
    fireEvent.click(next);
    expect(stepOf("refugio")).toBe(2);
    act(() => {
      vi.advanceTimersByTime(SHELTER_SEQUENCE.stepMs * 10);
    });
    // The autoplay is stopped for good.
    expect(stepOf("refugio")).toBe(2);
    fireEvent.click(prev);
    expect(stepOf("refugio")).toBe(1);
    // Moving back slides the next screen in from the other side.
    expect(container.querySelector(".lp-seq-slide")).toHaveAttribute("data-dir", "back");
    for (let i = 0; i < SHELTER_SEQUENCE.total; i++) fireEvent.click(next);
    expect(stepOf("refugio")).toBe(SHELTER_SEQUENCE.total - 1);
    expect(next).toBeDisabled();
    expect(prev).toBeEnabled();
  });

  it("the vet chapter's ‹ › stop at the named steps, not at every field", () => {
    const { chapter: c, index } = chapter("vet");
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    const { next } = arrows(container);
    const stops = [stepOf("vet")];
    while (!next.disabled) {
      fireEvent.click(next);
      stops.push(stepOf("vet"));
    }
    // Step 0 is where the rewind leaves it; then each item's own step.
    expect(stops).toEqual([0, ...VET_SEQUENCE.items.slice(1).map((it) => it.at)]);
  });

  it("the refugio's tablet slides out and the owner's phone slides in, then the stage clears", () => {
    vi.useFakeTimers();
    const { chapter: c, index } = chapter("refugio");
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    act(() => FakeIntersectionObserver.instances[0]?.callback([{ isIntersecting: true }]));
    act(() => {
      vi.advanceTimersByTime(SHELTER_SEQUENCE.stepMs * (OWNER_FROM - 1));
    });
    expect(container.querySelector(".lp-seq-dev-out")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(SHELTER_SEQUENCE.stepMs);
    });
    expect(stepOf("refugio")).toBe(OWNER_FROM);
    const out = container.querySelector(".lp-seq-dev-out");
    expect(out?.querySelector('.lp-seq-case[data-actor="shelter"] .lp-tablet')).not.toBeNull();
    const incoming = container.querySelector(".lp-seq-dev-in");
    expect(incoming?.querySelector('.lp-seq-case[data-actor="owner"] .lp-phone')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector(".lp-seq-dev-out")).toBeNull();
    expect(container.querySelector(".lp-seq-dev-in")).toBeNull();
    // A screen change within one device does not move the device.
    act(() => {
      vi.advanceTimersByTime(SHELTER_SEQUENCE.stepMs);
    });
    expect(container.querySelector(".lp-seq-dev-out")).toBeNull();
    expect(container.querySelector(".lp-seq-slide")).not.toBeNull();
  });

  it("the client's first rewind is not a device switch", () => {
    const { chapter: c, index } = chapter("refugio");
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    // SSR rests on Martín's phone; the rewind lands on the shelter's tablet.
    expect(stepOf("refugio")).toBe(0);
    expect(container.querySelector(".lp-seq-dev-out")).toBeNull();
  });

  it("restarts cleanly after the visitor navigates away mid-play and back", () => {
    vi.useFakeTimers();
    const { chapter: c, index } = chapter("anon");
    const first = render(<SequenceChapter chapter={c} index={index} />);
    act(() => FakeIntersectionObserver.instances[0]?.callback([{ isIntersecting: true }]));
    act(() => {
      vi.advanceTimersByTime(LOST_SEQUENCE.stepMs);
    });
    expect(stepOf("anon")).toBe(1);
    first.unmount();
    render(<SequenceChapter chapter={c} index={index} />);
    expect(stepOf("anon")).toBe(0);
    // The old run's timers are gone and it freed the one-at-a-time slot.
    act(() => FakeIntersectionObserver.instances[1]?.callback([{ isIntersecting: true }]));
    act(() => {
      vi.advanceTimersByTime(LOST_SEQUENCE.stepMs);
    });
    expect(stepOf("anon")).toBe(1);
  });

  // PO 2026-09-29, twice: chapter 3 ("Se pierde") used to switch a
  // "deviceLabel" caption between "App de Martín" and "Celular del vecino ·
  // sin app" mid-chapter (two devices in one chapter); the refugio chapter's
  // own "Portal del refugio" / "App de Martín" caption survived that first
  // pass, then got removed too — the whole `deviceLabel` mechanism (the
  // `SequenceSpec` field, the `.lp-seq-who` element and its CSS) is gone.
  // The PO's intent, stated directly the second time: "sin tener que
  // aclarar en cada caso" — the device itself (phone vs tablet, and the
  // portal header inside a tablet) has to say whose it is, with no caption
  // anywhere naming it. No sequence chapter may render `.lp-seq-who`, at
  // any step — this guard covers all three, not just the ones that used to
  // have the bug.
  it.each(SEQUENCES)(
    "$key: no device caption at any step ('sin aclarar en cada caso')",
    ({ key }) => {
      const { chapter: c, index } = chapter(key);
      const { container } = render(<SequenceChapter chapter={c} index={index} />);
      expect(container.querySelector(".lp-seq-who")).toBeNull();
      const { next } = arrows(container);
      while (!next.disabled) {
        fireEvent.click(next);
        expect(container.querySelector(".lp-seq-who")).toBeNull();
      }
    },
  );
});

// PO 2026-09-30, second call: a visible one-line step caption + "n/total"
// counter under the ‹ › controls, for all three animated chapters — and the
// refugio merge that dropped its two identical-looking match-card steps into
// one (7 steps → 6).
describe("story sequences — the visible step caption", () => {
  it("shows the current step's caption and updates it after a ‹ › click", () => {
    const { chapter: c, index } = chapter("refugio");
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    const { next } = arrows(container);
    expect(container.querySelector(".lp-seq-caption-text")?.textContent).toBe(
      SHELTER_SEQUENCE.items[0]?.label,
    );
    fireEvent.click(next);
    expect(container.querySelector(".lp-seq-caption-text")?.textContent).toBe(
      SHELTER_SEQUENCE.items[1]?.label,
    );
  });

  it.each(SEQUENCES)("$key: the counter reads n/total and tracks the step", ({ key, spec }) => {
    const { chapter: c, index } = chapter(key);
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    const { next } = arrows(container);
    expect(container.querySelector(".lp-seq-caption-count")?.textContent).toBe(
      `1/${spec.items.length}`,
    );
    fireEvent.click(next);
    expect(container.querySelector(".lp-seq-caption-count")?.textContent).toBe(
      `2/${spec.items.length}`,
    );
  });

  it("the refugio chapter merged its two identical-looking match steps: 6 steps, not 7", () => {
    expect(SHELTER_SEQUENCE.total).toBe(6);
    expect(SHELTER_SEQUENCE.items).toHaveLength(6);
  });

  it.each(SEQUENCES)(
    "$key: no two consecutive steps render identical device markup",
    ({ spec }) => {
      for (let i = 1; i < spec.total; i++) {
        const prev = renderToStaticMarkup(spec.device(i - 1, false));
        const curr = renderToStaticMarkup(spec.device(i, false));
        expect(curr).not.toBe(prev);
      }
    },
  );
});

// PO 2026-09-30: "un color de carcasa distinto por persona".
describe("case colours — one per person", () => {
  const css = readFileSync(join(__dirname, "..", "..", "app", "landing.css"), "utf8");

  it("every step of every chapter wraps its device in its actor's case", () => {
    const expected: Record<string, (step: number) => string> = {
      vet: () => "vet",
      // Martín, Martín, the neighbour, the neighbour, Martín (PO 2026-10-01).
      anon: (s) => (["owner", "owner", "neighbour", "neighbour", "owner"] as const)[s] ?? "?",
      refugio: (s) => (s >= OWNER_FROM ? "owner" : "shelter"),
    };
    for (const { key, spec } of SEQUENCES) {
      for (let i = 0; i < spec.total; i++) {
        const html = renderToStaticMarkup(spec.device(i, false));
        expect(html, `${key} step ${i}`).toContain(
          `class="lp-seq-case" data-actor="${expected[key]?.(i)}"`,
        );
      }
    }
  });

  it("each actor has its own case token, in light and in dark, all distinct", () => {
    expect([...ACTORS]).toEqual(["owner", "neighbour", "vet", "shelter"]);
    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start, selector).toBeGreaterThan(-1);
      return css.slice(start, css.indexOf("}", start));
    };
    for (const theme of [block(".lp"), block(":where(.dark) .lp")]) {
      const values = ACTORS.map((a) => {
        const m = theme.match(new RegExp(`--lp-case-${a}:\\s*([^;]+);`));
        expect(m, a).not.toBeNull();
        return m?.[1]?.trim();
      });
      expect(new Set(values).size).toBe(ACTORS.length);
    }
    for (const a of ACTORS) {
      expect(css).toContain(`.lp-seq-case[data-actor="${a}"] {\n  --lp-case: var(--lp-case-${a});`);
    }
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
    expect(rail.indexOf('aria-current="step"')).toBeLessThan(rail.indexOf(">Vacuna<"));
    expect(CHAPTERS.filter((c) => c.state === "lost").map((c) => c.key)).toEqual([
      "anon",
      "refugio",
    ]);
  });
});

// Critique 2026-09-29, M5 — every chapter ends on its payoff, not on a
// dialog or an empty phone.
describe("chapter endings (M5)", () => {
  const finalScreen = (spec: typeof SHELTER_SEQUENCE) =>
    renderToStaticMarkup(spec.device(spec.total - 1, false));

  // PO 2026-10-01: the chapter ends on Martín's "Sí, la encontré" turning into
  // the closed search — the confirm only while it plays, the result at rest.
  it("chapter 4 ends on the closed search, after the native devolución", () => {
    const last = finalScreen(SHELTER_SEQUENCE);
    expect(last).toContain('data-actor="owner"');
    expect(last).toContain("Modo perdida");
    // commandDoneLabel("mark_found") and situationHeadline, for a female pet.
    expect(last).toContain(
      "Listo. La marcamos como encontrada y avisamos a quienes la estaban buscando.",
    );
    expect(last).toContain("Pampa no está perdida.");
    expect(last).not.toContain("¿Confirmás?");
    // No claim that her vaccines are current: the 2022 dose had lapsed.
    expect(last).not.toMatch(/al día|vigente/i);
    // Playing, the same step first shows the confirm, pressed, then swaps.
    const playing = renderToStaticMarkup(SHELTER_SEQUENCE.device(SHELTER_SEQUENCE.total - 1, true));
    expect(playing).toContain("Sí, la encontré");
    expect(playing).toMatch(/lp-seq-swap-before[\s\S]*¿Confirmás\?[\s\S]*lp-seq-swap-after/);
    expect(playing).toMatch(/lp-seq-late[^>]*>Sí, la encontré/);
    // The step before it is the native return screen.
    const devolucion = renderToStaticMarkup(
      SHELTER_SEQUENCE.device(SHELTER_SEQUENCE.total - 2, false),
    );
    expect(devolucion).toContain("Devolución de Pampa");
    // `can_propose`: the chip match writes no proposal for him to accept.
    expect(devolucion).toContain("Proponer la devolución");
    expect(devolucion).not.toContain("Ya tengo a Pampa");
    // And the step list names the payoff.
    expect(SHELTER_SEQUENCE.items.at(-1)?.at).toBe(SHELTER_SEQUENCE.total - 1);
  });

  // Chapter 3 (PO 2026-10-01): Martín reports her lost and shares the
  // poster; a neighbour scans it, sends a sighting with a contact; Martín's
  // inbox gets it.
  it("chapter 3: owner, neighbour, owner — and ends on the sighting notification", () => {
    const at = (s: number, animate = false) =>
      renderToStaticMarkup(LOST_SEQUENCE.device(s, animate));
    expect(at(LOST_REPORT_STEP)).toContain("Marcar como perdida");
    expect(at(LOST_POSTER_STEP)).toContain("Compartir o imprimir el cartel");
    // The native card draws no poster preview.
    expect(at(LOST_POSTER_STEP)).not.toContain("<svg");
    expect(at(LOST_PUBLIC_STEP)).toContain('data-actor="neighbour"');
    expect(at(LOST_PUBLIC_STEP)).toMatch(/data-used="true"[^>]*>.*La vi cerca de acá/);
    // The old found form is gone.
    expect(at(LOST_PUBLIC_STEP)).not.toContain("¿Encontraste a esta mascota?");
    // The sighting step at rest is the form's thanks…
    expect(at(LOST_SIGHTING_STEP)).toContain("¡Gracias!");
    // …and while it plays, the form is typed first.
    const typing = at(LOST_SIGHTING_STEP, true);
    expect(typing).toContain("Algún detalle (opcional)");
    expect(typing).toContain("Avisar al dueño/a");
    const last = finalScreen(LOST_SEQUENCE);
    expect(LOST_SEQUENCE.total - 1).toBe(LOST_INBOX_STEP);
    expect(last).toContain('data-actor="owner"');
    expect(last).toContain("Avistaje de Pampa");
    expect(last).toContain("Atención");
    expect(last).toContain(SIGHTING_MESSAGE);
    expect(last).toContain(SIGHTING_CONTACT);
    expect(last).not.toContain("Celular del vecino");
  });

  it("the neighbour types the message, then the contact, in one stagger", () => {
    vi.useFakeTimers();
    const { chapter: c, index } = chapter("anon");
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    act(() => FakeIntersectionObserver.instances[0]?.callback([{ isIntersecting: true }]));
    act(() => {
      vi.advanceTimersByTime(LOST_SEQUENCE.stepMs * LOST_SIGHTING_STEP);
    });
    expect(stepOf("anon")).toBe(LOST_SIGHTING_STEP);
    const fields = [...container.querySelectorAll(".lp-seq-swap-before .lp-seq-type")];
    expect(fields.map((f) => f.textContent)).toEqual([SIGHTING_MESSAGE, SIGHTING_CONTACT]);
    const words = SIGHTING_MESSAGE.split(" ").length;
    const contactWord = fields[1]?.firstElementChild as HTMLElement | null;
    expect(contactWord?.style.getPropertyValue("--i")).toBe(String(words));
    expect(container.querySelector(".lp-seq-swap-after")?.textContent).toContain("¡Gracias!");
  });

  it("chapter 3's actor switches slide one phone out and the other in, both ways", () => {
    vi.useFakeTimers();
    const { chapter: c, index } = chapter("anon");
    const { container } = render(<SequenceChapter chapter={c} index={index} />);
    act(() => FakeIntersectionObserver.instances[0]?.callback([{ isIntersecting: true }]));
    act(() => {
      vi.advanceTimersByTime(LOST_SEQUENCE.stepMs * LOST_PUBLIC_STEP);
    });
    expect(stepOf("anon")).toBe(LOST_PUBLIC_STEP);
    expect(
      container.querySelector('.lp-seq-dev-out .lp-seq-case[data-actor="owner"] .lp-phone'),
    ).not.toBeNull();
    expect(
      container.querySelector('.lp-seq-dev-in .lp-seq-case[data-actor="neighbour"] .lp-phone'),
    ).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(LOST_SEQUENCE.stepMs * (LOST_INBOX_STEP - LOST_PUBLIC_STEP));
    });
    expect(stepOf("anon")).toBe(LOST_INBOX_STEP);
    expect(
      container.querySelector('.lp-seq-dev-out .lp-seq-case[data-actor="neighbour"] .lp-phone'),
    ).not.toBeNull();
    expect(
      container.querySelector('.lp-seq-dev-in .lp-seq-case[data-actor="owner"] .lp-phone'),
    ).not.toBeNull();
  });

  it("the client story bundle does not ship the qrcode encoder", () => {
    const src = readFileSync(join(__dirname, "story-sequences.tsx"), "utf8");
    expect(src).not.toMatch(/from "qrcode"/);
  });

  it("no chapter's phone carries a size modifier — every chapter is the same size (PO 2026-09-29)", () => {
    // The short phone (chapter 1) and the tall libreta phone (chapter 5) both
    // made their chapter's device visibly different from the rest of the
    // story — the PO reversed BOTH: every chapter's phone is the same size,
    // always. PhoneFrame no longer even has a size prop to pass.
    const html = renderToStaticMarkup(<StorySection />);
    expect(html).not.toContain("lp-scr--short");
    expect(html).not.toContain("lp-scr--tall");
  });
});
