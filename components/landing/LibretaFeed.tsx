"use client";

// LibretaFeed — chapter 6 "the libreta fills up" animation (WU3, PO-approved
// landing plan). Reveals Pampa's libreta entries one by one, once the chapter
// is ~40% in view. Plays ONCE, then stays settled.
//
// ORDER (PO, 2026-09-25): chronological, the way a libreta fills. `events`
// arrives in DISPLAY order — newest on top (story-screens.tsx reverses the
// chronological constant) — and the reveal walks it from the END: the oldest
// entry appears first, alone at the top; each newer one then enters ABOVE it
// and pushes the earlier ones down, until the settled list is the same
// newest-on-top list SSR renders. The DOM order never changes: an unrevealed
// row is collapsed to zero height (.lp-lib-row--pending) and an entering row
// expands in place, so the push-down is the rows below it moving.
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
//  - If the observer never calls back AT ALL within ~1.4s (RevealManager's
//    own fallback window), every entry reveals immediately. A callback that
//    reports NOT intersecting still counts as "the observer is alive" — the
//    reveal then waits for a later callback that DOES report intersecting,
//    however long that takes. IntersectionObserver always delivers an
//    initial callback right after observe() even when not intersecting
//    (same "fired" flag RevealManager.tsx uses), so this fallback only ever
//    catches an observer that is broken or unsupported, never a chapter that
//    is simply still off-screen.
//
// The phone screen keeps the SAME fixed height as every other chapter's
// (.lp-scr, 640px — the old, taller `.lp-scr--tall` variant was removed, PO
// 2026-09-29), and the feed itself now scrolls (.lp-lib-feed) instead of the
// screen growing around it. The feed still reserves its FINAL height before
// it collapses anything: the full list's height is measured pre-paint and
// pinned as min-height, so rows collapsing and expanding inside it never move
// anything outside it (no CLS). The pin is released once the last row has
// settled — from then on the list is its own height again, and a later
// resize reflows it naturally.

import { type LibretaEvent, asientoRelative } from "@/components/landing/landing-content";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * One asiento, as the native owner app draws it
 * (apps/mobile/src/pets/LibretaScreen.tsx:350-378, EntryCard): the mono
 * eyebrow, the serif title, "{relativo} · {fecha}", the fact rows
 * (FactRow, :389-404) and the provenance line. `now` is the moment the
 * screen depicts — the relative half is measured from it, as the app
 * measures it from the phone's clock.
 */
export function NativeAsiento({
  entry,
  now,
  className = "lp-nat-entry",
}: {
  entry: LibretaEvent;
  now: Date;
  className?: string;
}) {
  return (
    <div className={className}>
      <span className="lp-nat-kind">{entry.kind}</span>
      <span className="lp-lib-t">{entry.title}</span>
      <span className="lp-nat-when">
        {asientoRelative(entry.date, now)} · {entry.whenAbsolute}
      </span>
      {entry.facts.map((f) => (
        <span className="lp-nat-fact" key={f.key}>
          <span>{f.key}</span>
          <b className={f.mono ? "lp-nat-mono" : undefined}>{f.value}</b>
        </span>
      ))}
      <span className="lp-nat-prov">{entry.provenance}</span>
    </div>
  );
}

/** Interval between two consecutive entries entering. */
const STEP_MS = 700;
/** Same fail-open window RevealManager uses for its own IntersectionObserver. */
const FAIL_OPEN_MS = 1400;
/** "About 40% in view" — measured against the chapter section, not just the phone mock. */
const VIEW_THRESHOLD = 0.4;
/**
 * How long one row takes to expand — mirrors --motion-deliberate, the token
 * .lp-lib-row--in transitions on. Only used to know when the last row has
 * settled, so the reserved height can be released.
 */
const ROW_SETTLE_MS = 600;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LibretaFeed({ events, now }: { events: LibretaEvent[]; now: Date }) {
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
    // Reserve the settled list's height BEFORE collapsing any row (still
    // pre-paint), so the page below never moves. Written through the CSSOM,
    // not a `style` prop: nothing about it belongs in the SSR markup.
    const el = containerRef.current;
    if (el) el.style.minHeight = `${el.offsetHeight}px`;
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
    // Set on the observer's FIRST callback, intersecting or not — mirrors
    // RevealManager.tsx's own `fired` flag. IntersectionObserver always
    // delivers that initial callback right after observe(), so this becomes
    // true almost immediately whenever the observer actually works, long
    // before the fallback timer below could ever fire. Only a broken/absent
    // observer leaves it false.
    let fired = false;
    const timers: number[] = [];
    const releaseReservedHeight = () => {
      el.style.minHeight = "";
    };
    // Normal path: the chapter crossed the threshold — stage the entries in
    // one by one, ~STEP_MS apart. May fire well after the fallback window if
    // the visitor simply hasn't scrolled there yet — that is expected, not a
    // failure the fallback needs to catch.
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
      timers.push(
        window.setTimeout(releaseReservedHeight, (events.length - 1) * STEP_MS + ROW_SETTLE_MS),
      );
    };
    // Fail-open path: the observer itself never reported back at all — show
    // every entry AT ONCE, exactly like RevealManager's own revealAll() (no
    // further staggering once the safety net has to catch it).
    const revealAllNow = () => {
      if (played) return;
      played = true;
      setPlayedCount(events.length);
      releaseReservedHeight();
    };

    const io = new IntersectionObserver(
      (entries) => {
        fired = true;
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

    // Fail-open rule 2 (RevealManager.tsx): the observer never called back at
    // all within ~1.4s → reveal everything immediately. A chapter that is
    // merely still off-screen already got its (not-intersecting) callback and
    // set `fired`, so it is NOT affected by this timer — it waits for the
    // real intersecting callback, whenever that comes.
    const fallback = window.setTimeout(() => {
      if (!fired) {
        revealAllNow();
        io.disconnect();
      }
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
        // Revealed from the END of the display order: the oldest (last) row
        // plays first, the newest (first) row plays last.
        const played = i >= events.length - playedCount;
        const rowClass = [
          "lp-lib-row",
          animate && (played ? "lp-lib-row--in" : "lp-lib-row--pending"),
        ]
          .filter(Boolean)
          .join(" ");
        // The native card has no stamp: its provenance line ("Verificado por
        // …") is what says who signed (LibretaScreen.tsx:370).
        return (
          <NativeAsiento
            key={`${e.type}-${e.date}-${e.title}`}
            entry={e}
            now={now}
            className={`lp-nat-entry ${rowClass}`}
          />
        );
      })}
    </div>
  );
}
