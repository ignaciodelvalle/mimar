"use client";

// Milestone orchestrator — the landing's progressive-reveal choreography
// (PO-approved design 2026-08-02).
//
// The public landing reads as SIX milestones (existing sections — this is
// choreography, not new content): credential hero → crisis band → bond band →
// story → life moments → empezar. FAQ + footer stay OUTSIDE the sequence:
// always reachable below, never a jump target, and the CTA disappears once the
// last milestone is reached so nothing floats over the closing content.
//
// Contract (locked decisions):
//  - ZERO keyboard interception. Navigation keys keep scrolling natively; this
//    component only RESPONDS to scroll. No document-level key listeners, no
//    preventDefault on anything.
//  - The ONLY new interactive element is the persistent, discreet
//    "Continuar ↓" button. It jumps to the next milestone via the same
//    scrollToChapter pattern StorySection uses: smooth ONLY when motion is
//    allowed AND the document has focus, else an instant jump.
//  - Visible under reduced motion too — motion preference is not a navigation
//    preference; the jump is simply instant.
//  - Fail-open: the button renders nothing until hydration (a no-JS visitor
//    must never see an affordance that cannot work), and every section stays
//    server-rendered and reachable by native scroll regardless.
//  - Milestone 4 jumps INTO the story section; the story's own rail/scroll-spy
//    handles navigation within its six chapters.
//
// Active tracking mirrors StorySection's scroll-spy (the milestone whose
// section last crossed 45% of the viewport is active) rather than a separate
// IntersectionObserver: one shared vocabulary, one behavior to reason about.
//
// ...with ONE exception, the click latch (PO-5, 2026-08-05). The scroll-spy is
// a good answer to "where am I reading?" and a bad answer to "where did the
// button just take me?": a section shorter than 45% of the viewport (the crisis
// band is 163px at 1440×800) is already overhung by the NEXT section's top when
// the CTA parks it under the nav, so the spy reports the section AFTER the one
// the visitor was sent to and the CTA offers the one after THAT — a milestone
// skipped per click. So a click LATCHES its own destination as the CTA's base,
// and the latch outranks the spy until the visitor scrolls for themselves.

import { useEffect, useRef, useState } from "react";

export type LandingMilestone = {
  /** Stable section anchor id (the section elements carry these ids). */
  id: string;
  /** es-AR display name — used in the CTA's accessible label. */
  name: string;
};

// Order mirrors app/page.tsx section order. FAQ is deliberately absent.
export const MILESTONES: LandingMilestone[] = [
  { id: "top", name: "La credencial" },
  { id: "crisis", name: "Emergencias, sin cuenta" },
  { id: "vinculo", name: "El vínculo" },
  { id: "idea", name: "Una mascota, muchas manos" },
  { id: "features", name: "Cuando no es un buen día" },
  { id: "empezar", name: "Empezar" },
];

/** Same sticky-nav offset scrollToChapter (StorySection.tsx) compensates. */
const NAV_OFFSET_PX = 84;

/** Fraction of the viewport a section top must cross to become active. */
const ACTIVE_VIEWPORT_FRACTION = 0.45;

/**
 * How far (px) `window.scrollY` may sit from the position a click asked for and
 * still count as "the page is where the button put it". Covers sub-pixel
 * rounding and fractional device-pixel-ratio scroll positions; anything larger
 * is somebody scrolling.
 */
const ARRIVAL_TOLERANCE_PX = 4;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Jump to a milestone section — the scrollToChapter pattern verbatim:
 * smooth is gated on motion being allowed AND the document holding focus
 * (a smooth scroll in a backgrounded tab arrives at the wrong place).
 *
 * Returns the scroll position it asked the browser for, or `null` when the
 * section is not in the document — the click latch below needs to know where
 * the page was SENT, which is the only thing the caller cannot recompute later
 * (by the time the scroll ends, every rect has moved).
 */
export function scrollToMilestone(id: string): number | null {
  const el = document.getElementById(id);
  if (!el) return null;
  const top = el.getBoundingClientRect().top + window.scrollY - NAV_OFFSET_PX;
  const smooth = !prefersReducedMotion() && document.hasFocus();
  const target = Math.max(top, 0);
  window.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });
  return target;
}

/**
 * What a CTA click leaves behind so later scroll samples can tell "the trip the
 * button started" from "the visitor took over".
 */
type ClickLatch = {
  /** Milestone the click navigated TO. While latched, the CTA offers index+1. */
  index: number;
  /** Scroll position `scrollToMilestone` asked for. */
  targetY: number;
  /** Distance to `targetY` at the previous scroll sample. */
  lastDistance: number;
  /** The page has reached `targetY` (within tolerance) at least once. */
  arrived: boolean;
};

export function MilestoneNav() {
  // Hydration gate: SSR and no-JS render nothing (see contract above).
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(0);
  /** Milestone latched by the last click, or null while the spy governs. */
  const [clicked, setClicked] = useState<number | null>(null);
  const latchRef = useRef<ClickLatch | null>(null);

  useEffect(() => {
    setMounted(true);
    const onScroll = () => {
      // --- Latch bookkeeping ------------------------------------------------
      // Deliberately derived from scroll POSITION, not from input events. The
      // component's contract forbids document-level key listeners (zero
      // keyboard interception), and wheel/touch listeners would still miss the
      // keyboard, the scrollbar and the browser's own find-in-page. Position is
      // the one signal every input shares, and a programmatic scroll has a
      // shape a human cannot fake: it closes on its target and then holds.
      const latch = latchRef.current;
      if (latch) {
        const distance = Math.abs(window.scrollY - latch.targetY);
        if (distance <= ARRIVAL_TOLERANCE_PX) {
          // Landed (or still resting) where the button aimed. Under reduced
          // motion this is the FIRST sample: the jump is instant, so the very
          // first scroll event already reports the destination.
          latch.arrived = true;
          latch.lastDistance = distance;
        } else if (latch.arrived || distance > latch.lastDistance + ARRIVAL_TOLERANCE_PX) {
          // Either the visitor moved off the spot the CTA parked them on, or a
          // still-flying scroll started receding from its target — a smooth
          // scroll only ever closes the gap, so widening it means a human
          // grabbed the page. Hand governance back to the scroll-spy.
          latchRef.current = null;
          setClicked(null);
        } else {
          latch.lastDistance = distance;
        }
      }

      const mid = window.innerHeight * ACTIVE_VIEWPORT_FRACTION;
      let current = 0;
      MILESTONES.forEach((m, i) => {
        const el = document.getElementById(m.id);
        if (el && el.getBoundingClientRect().top <= mid) current = i;
      });
      setActive((prev) => (prev === current ? prev : current));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A click's destination outranks the spy until the visitor scrolls away from
  // it (see the latch bookkeeping above).
  const base = clicked ?? active;
  const nextIndex = base + 1;
  const next = MILESTONES[nextIndex];
  // Past the last milestone the affordance disappears — FAQ and footer below
  // are plain scroll territory, never CTA targets.
  if (!mounted || !next) return null;

  const onClick = () => {
    const targetY = scrollToMilestone(next.id);
    // No section, no navigation, nothing to latch — leave the spy in charge.
    if (targetY === null) return;
    const distance = Math.abs(window.scrollY - targetY);
    latchRef.current = {
      index: nextIndex,
      targetY,
      lastDistance: distance,
      // A click that asks for the position the page already holds fires no
      // scroll event at all, so arrival has to be recognised here.
      arrived: distance <= ARRIVAL_TOLERANCE_PX,
    };
    setClicked(nextIndex);
  };

  return (
    <button
      type="button"
      className="lp-milestone-cta"
      data-section="milestone-cta"
      aria-label={`Continuar a la próxima sección: ${next.name}`}
      onClick={onClick}
    >
      Continuar
      <span className="lp-milestone-ar" aria-hidden="true">
        ↓
      </span>
    </button>
  );
}
