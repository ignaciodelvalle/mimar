"use client";

// useChapterSequence — the shared engine behind the story chapters' animations
// (vet, lost, shelter). One sequence = N steps that play once, ~STEP_MS apart,
// the first time the chapter is ~40% in view.
//
// Fail-open contract (the same one LibretaFeed.tsx and RevealManager.tsx keep):
//  - SSR and the first client render show the FINAL step, with no animation
//    class, so a no-JS visitor, a reduced-motion visitor and a broken observer
//    all see the finished state and the markup never depends on this running.
//  - Only a client layout effect, and only when prefers-reduced-motion allows
//    it AND IntersectionObserver exists, rewinds to the first step and arms the
//    observer (pre-paint, so the final state never flashes first).
//  - If the observer never calls back at all within FAIL_OPEN_MS, the sequence
//    jumps straight to its final step. A callback that reports "not
//    intersecting" still proves the observer is alive; the sequence then waits
//    for the one that does, however long that takes.
//  - At most ONE sequence animates at a time across the page: a chapter that
//    enters view while another is still playing waits for it (a module-level
//    queue), so two moving phones never compete for the eye.
//  - `goTo(i)` (the clickable step list) stops the autoplay for good and shows
//    step i. It works with motion off too — it is navigation, not animation.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Same fail-open window RevealManager and LibretaFeed use. */
const FAIL_OPEN_MS = 1400;
/** "About 40% in view", measured against the chapter, not the device mock. */
const VIEW_THRESHOLD = 0.4;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ---------------------------------------------------------------------------
// One sequence at a time
// ---------------------------------------------------------------------------

let playing: symbol | null = null;
const waiting: Array<{ id: symbol; start: () => void }> = [];

function acquire(id: symbol, start: () => void): void {
  if (playing === null) {
    playing = id;
    start();
    return;
  }
  waiting.push({ id, start });
}

function release(id: symbol): void {
  const queued = waiting.findIndex((w) => w.id === id);
  if (queued !== -1) waiting.splice(queued, 1);
  if (playing !== id) return;
  playing = null;
  const next = waiting.shift();
  if (next) {
    playing = next.id;
    next.start();
  }
}

/** Test seam: forget any sequence a previous test left holding the slot. */
export function resetChapterSequencesForTests(): void {
  playing = null;
  waiting.length = 0;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export type ChapterSequence = {
  /** Attach to any element inside the chapter; the chapter (id="cap-…") is observed. */
  ref: React.RefObject<HTMLDivElement | null>;
  /** Current step, 0-based. Starts (SSR) at the last step. */
  step: number;
  /** True only on the client, with motion allowed — gates every animation class. */
  animate: boolean;
  /** Jump to a step (clickable step list). Stops the autoplay. */
  goTo: (i: number) => void;
};

export function useChapterSequence(total: number, stepMs: number): ChapterSequence {
  const ref = useRef<HTMLDivElement | null>(null);
  const last = total - 1;
  const [step, setStep] = useState(last);
  const [animate, setAnimate] = useState(false);
  const stoppedRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  const idRef = useRef<symbol>(Symbol("chapter-sequence"));

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
  }, []);

  useLayoutEffect(() => {
    if (prefersReducedMotion()) return;
    if (typeof IntersectionObserver === "undefined") return;
    setAnimate(true);
    setStep(0);
  }, []);

  useEffect(() => {
    if (!animate) return;
    const el = ref.current;
    if (!el) return;
    const chapter = el.closest<HTMLElement>('[id^="cap-"]') ?? el;
    const id = idRef.current;
    let started = false;
    let fired = false;

    const play = () => {
      if (stoppedRef.current) {
        release(id);
        return;
      }
      for (let i = 1; i <= last; i++) {
        timersRef.current.push(
          window.setTimeout(() => {
            if (!stoppedRef.current) setStep(i);
            if (i === last) release(id);
          }, i * stepMs),
        );
      }
      if (last === 0) release(id);
    };

    const io = new IntersectionObserver(
      (entries) => {
        fired = true;
        for (const entry of entries) {
          if (entry.isIntersecting && !started) {
            started = true;
            io.disconnect();
            acquire(id, play);
          }
        }
      },
      { threshold: VIEW_THRESHOLD },
    );
    io.observe(chapter);

    const fallback = window.setTimeout(() => {
      if (!fired && !started) {
        started = true;
        io.disconnect();
        setStep(last);
      }
    }, FAIL_OPEN_MS);
    timersRef.current.push(fallback);

    return () => {
      io.disconnect();
      clearTimers();
      release(id);
    };
  }, [animate, last, stepMs, clearTimers]);

  const goTo = useCallback(
    (i: number) => {
      stoppedRef.current = true;
      clearTimers();
      release(idRef.current);
      setStep(Math.max(0, Math.min(last, i)));
    },
    [clearTimers, last],
  );

  return { ref, step, animate, goTo };
}
