"use client";

// LibretaFeed — chapter 6 "the libreta fills up" animation (WU3, PO-approved
// landing plan). Reveals the 10 real event types one by one, newest on top,
// once the chapter is ~40% in view. Plays ONCE, then stays settled.
//
// Fail-open contract (mirrors RevealManager.tsx / CountUp.tsx):
//  - SSR renders every entry visible, with no hiding class — a no-JS visitor
//    always sees the complete list, and the page length never depends on
//    this component running.
//  - The very first client render (before any effect runs) matches SSR
//    exactly, so hydration never mismatches.
//  - Only a client effect — and only when prefers-reduced-motion allows it
//    and IntersectionObserver exists — switches unplayed entries into a
//    hidden "pending" state and starts the staggered reveal. That flip
//    happens in useLayoutEffect (pre-paint), the same trick CountUp uses to
//    avoid a flash of the full list before it hides.
//  - If the chapter never reports ~40% in view within ~1.4s (RevealManager's
//    own fallback window), every entry reveals immediately.
//
// The phone screen keeps a fixed height (.lp-scr--tall) and clips overflow —
// entries are always present in the DOM, only opacity/transform change, so
// nothing here ever reflows the page or shifts layout.

import { PAMPA } from "@/components/landing/landing-content";
import type { LibretaEvent } from "@/components/landing/landing-content";
import { LnStatusFlag, LnVstamp } from "@/components/ui/StatusFlag";
import type { EventType } from "@/db/schema";
import { eventTypeLabel } from "@/lib/utils/format";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Interval between two consecutive entries entering. */
const STEP_MS = 700;
/** Same fail-open window RevealManager uses for its own IntersectionObserver. */
const FAIL_OPEN_MS = 1400;
/** "About 40% in view" — measured against the chapter section, not just the phone mock. */
const VIEW_THRESHOLD = 0.4;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LibretaFeed({ events }: { events: LibretaEvent[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // SSR + first client render: everything already "played" — the full list,
  // static, no animation classes. Only flipped to a staged reveal client-side
  // when motion is allowed (fail-open rule 1 — nothing visible ever blinks
  // out; see RevealManager.tsx).
  const [playedCount, setPlayedCount] = useState(events.length);
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    if (prefersReducedMotion()) return;
    if (typeof IntersectionObserver === "undefined") return;
    setAnimate(true);
    setPlayedCount(0);
  }, []);

  useEffect(() => {
    if (!animate) return;
    const el = containerRef.current;
    if (!el) return;
    // Observe the CHAPTER section (id="cap-libreta"), not just the phone
    // mock — the trigger is "the chapter is ~40% in view", per the brief.
    const chapter = el.closest<HTMLElement>('[id^="cap-"]') ?? el;

    let played = false;
    const timers: number[] = [];
    // Normal path: the chapter crossed the threshold — stage the entries in
    // one by one, ~STEP_MS apart.
    const playStaggered = () => {
      if (played) return;
      played = true;
      for (let i = 0; i < events.length; i++) {
        timers.push(
          window.setTimeout(() => {
            setPlayedCount((c) => Math.max(c, i + 1));
          }, i * STEP_MS),
        );
      }
    };
    // Fail-open path: the observer never reported intersecting — show every
    // entry AT ONCE, exactly like RevealManager's own revealAll() (no further
    // staggering once the safety net has to catch it).
    const revealAllNow = () => {
      if (played) return;
      played = true;
      setPlayedCount(events.length);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            playStaggered();
            io.disconnect();
          }
        }
      },
      { threshold: VIEW_THRESHOLD },
    );
    io.observe(chapter);

    // Fail-open rule 2 (RevealManager.tsx): the observer never fired within
    // ~1.4s → reveal everything immediately.
    const fallback = window.setTimeout(() => {
      revealAllNow();
      io.disconnect();
    }, FAIL_OPEN_MS);
    timers.push(fallback);

    return () => {
      io.disconnect();
      for (const t of timers) window.clearTimeout(t);
    };
    // events is a static landing-content.ts constant — only its length is a
    // meaningful dependency, and it never changes at runtime.
  }, [animate, events.length]);

  return (
    <div className="lp-app-body lp-lib-feed" ref={containerRef}>
      {events.map((e, i) => {
        const played = i < playedCount;
        const rowClass = [
          "lp-lib-row",
          animate && (played ? "lp-lib-row--in" : "lp-lib-row--pending"),
        ]
          .filter(Boolean)
          .join(" ");
        const stampClass = ["ml-auto", animate && played && "lp-lib-stamp--in"]
          .filter(Boolean)
          .join(" ");
        return (
          <div className={rowClass} key={`${e.type}-${e.year}-${e.month}-${e.title}`}>
            <div className="lp-lib-when">
              <div className="lp-lib-y">{e.year}</div>
              <div className="lp-lib-m">{e.month}</div>
            </div>
            <div className="lp-lib-spine">
              <span className="lp-lib-dot" data-t={e.tone} />
            </div>
            <div>
              <div className="lp-lib-t">
                {e.title}
                {e.flag && <LnStatusFlag status={e.flag} sex={PAMPA.sexEnum} />}
                {e.stamp && (
                  <span className={stampClass}>
                    {/* Historical log entry — "signed", not "currently valid"
                        (label override same mechanism LnHero uses for AL DÍA). */}
                    <LnVstamp variant={e.stamp} label="FIRMADO" />
                  </span>
                )}
              </div>
              <div className="lp-lib-meta">{e.meta}</div>
              <div className="lp-lib-foot">
                <span className="lp-lib-type">{eventTypeLabel(e.type as EventType)}</span>
                <span className="lp-lib-by">{e.by}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
