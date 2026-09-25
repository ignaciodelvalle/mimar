"use client";

// "Una mascota. Muchas manos." — the cast (CastFila, PO-locked variant #1)
// plus the six chapters with the sticky scroll-spy rail.
//
// Rail contract (handoff README §Interacciones):
//  - click → scrollTo the chapter (smooth ONLY when motion is allowed AND
//    document.hasFocus());
//  - scroll-spy: the step whose chapter last crossed 45% of the viewport is
//    active;
//  - Pampa's rail head turns RED (lost photo + PERDIDO flag) during the
//    anonymous chapter.
//
// Motion notes: static cards, subtle hover only (no loops — the orbit
// variant was explicitly not built). The optional "rail accumulates libreta
// entries" deepener was SKIPPED to protect the timeline (noted in handoff).

import { Icon } from "@/components/Icon";
import { PhoneFrame } from "@/components/landing/PhoneFrame";
import { StepButton } from "@/components/landing/StepButton";
import { ACTORS, CHAPTERS, PAMPA } from "@/components/landing/landing-content";
import type { LandingChapter } from "@/components/landing/landing-content";
import { DuenoScreen, EstadoConsole, LibretaScreen } from "@/components/landing/story-screens";
import { SequenceChapter, hasSequence } from "@/components/landing/story-sequences";
import { LnPetPhoto } from "@/components/ui/RegRow";
import { LnStatusFlag } from "@/components/ui/StatusFlag";
import type React from "react";
import { useEffect, useRef, useState } from "react";

function chapterDevice(key: string) {
  switch (key) {
    case "dueno":
      return (
        <PhoneFrame>
          <DuenoScreen />
        </PhoneFrame>
      );
    case "libreta":
      return (
        <PhoneFrame tall>
          <LibretaScreen />
        </PhoneFrame>
      );
    default:
      return null;
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function scrollToChapter(key: string) {
  const el = document.getElementById(`cap-${key}`);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 84;
  const smooth = !prefersReducedMotion() && document.hasFocus();
  window.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
}

// ---------------------------------------------------------------------------
// CastFila — Pampa + the 4 hands as a 2×2 grid of chapter shortcuts
// ---------------------------------------------------------------------------

function CastFila() {
  return (
    <div className="lp-castfila" data-section="cast-fila">
      <div className="lp-castfila-pet">
        {/* Same photo the hero credential shows — the striped FOTO placeholder
            here broke narrative continuity (critique 2026-07-27, J2): the page
            introduces Pampa with a real face, then the story forgot it. */}
        <LnPetPhoto src="/landing/pampa-hero.jpg" alt={PAMPA.name} status="ok" size={148} />
        <span className="font-ln-serif text-xl font-semibold">{PAMPA.name}</span>
        <LnStatusFlag status="ok" />
      </div>
      <div className="lp-castfila-sep" aria-hidden="true" />
      <div className="lp-castfila-hands">
        {ACTORS.map((a) => (
          <button
            type="button"
            key={a.key}
            className="lp-castfila-hand"
            data-tone={a.tone}
            onClick={() => scrollToChapter(a.chapter)}
          >
            {/* Named by its visible text plus a screen-reader-only purpose, not
                an aria-label: the old label ("Ir al capítulo: …") replaced
                the visible role and sentence, which axe reports as
                label-content-name-mismatch (WCAG 2.5.3) — the same audit as the
                nav's brand link (review L-5). */}
            <span className="lp-role-ic" aria-hidden="true">
              <Icon name={a.icon} size="sm" decorative />
            </span>
            <span>
              {/* The space keeps "Dueño" and its sentence two words in the
                  computed name; both are display:block, so it never renders. */}
              <b>{a.name}</b> <span className="lp-hand-sub">{a.does}</span>
              <span className="sr-only">, ir al capítulo</span>
            </span>
            <span className="lp-ar" aria-hidden="true">
              →
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail — sticky chapter nav with scroll-spy and a progress track
// ---------------------------------------------------------------------------

// PS10 (PO, 2026-09-25). Desktop: a 2px track joins the chapter dots and fills
// in azul from the first dot down to where the reader is; past dots are
// filled, the current one is white with a halo. Mobile (<=940px): the sticky
// pill bar gets a 3px progress bar under it, and the active pill scrolls
// itself into view.
//
// The fill is a CSS scroll-driven animation where the browser has one
// (animation-timeline on the chapters' view timeline, app/landing.css); the
// inline transform below is the fallback everywhere else — the scroll-spy's
// chapter index, as a fraction. A running CSS animation outranks the inline
// style, so the two never fight.
//
// Pampa's flag reads PERDIDA through chapters 3 and 4 (she is lost from
// 2024-03-09 until Martín marks her found on 2024-03-13) and AL DÍA otherwise.

function Rail({ active }: { active: string }) {
  const index = Math.max(
    0,
    CHAPTERS.findIndex((c) => c.key === active),
  );
  const current = CHAPTERS[index] ?? CHAPTERS[0];
  const lost = current?.state === "lost";
  const progress = CHAPTERS.length > 1 ? index / (CHAPTERS.length - 1) : 1;
  const navRef = useRef<HTMLElement>(null);

  // Mobile: keep the active pill in view inside the horizontally scrolling
  // bar. Only when the bar actually scrolls sideways (desktop's column never
  // does), and only the bar itself moves — never the page.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    const pill = nav.querySelectorAll<HTMLElement>(".lp-rail-step")[index];
    if (!pill) return;
    const left = pill.offsetLeft - (nav.clientWidth - pill.offsetWidth) / 2;
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof nav.scrollTo === "function") {
      nav.scrollTo({ left: Math.max(0, left), behavior: reduce ? "auto" : "smooth" });
    }
  }, [index]);

  return (
    <div className="lp-rail-shell" data-section="story-rail-shell">
      <nav className="lp-rail" aria-label="Capítulos" data-section="story-rail" ref={navRef}>
        <div className="lp-rail-head">
          {/* Same Pampa photo as the hero + CastFila (J2 — narrative continuity). */}
          <LnPetPhoto
            src="/landing/pampa-hero.jpg"
            alt={PAMPA.name}
            status={lost ? "lost" : "ok"}
            size={44}
          />
          <span>
            <span className="lp-rail-name">{PAMPA.name}</span>
            <span className="mt-1 block">
              <LnStatusFlag status={lost ? "lost" : "ok"} sex={PAMPA.sexEnum} />
            </span>
          </span>
        </div>
        <div className="lp-rail-steps">
          <span className="lp-rail-track" aria-hidden="true">
            <span
              className="lp-rail-fill"
              style={{ transform: `scaleY(${progress})` } as React.CSSProperties}
            />
          </span>
          {CHAPTERS.map((c, i) => (
            <StepButton
              key={c.key}
              data-s={c.state}
              data-state={i < index ? "past" : i === index ? "current" : "next"}
              className="lp-rail-step"
              active={active === c.key}
              onSelect={() => scrollToChapter(c.key)}
            >
              <span className="lp-rn">{String(i + 1).padStart(2, "0")}</span>
              <span className="lp-rname">{c.hand}</span>
              <span className="lp-rdot" aria-hidden="true" />
            </StepButton>
          ))}
        </div>
      </nav>
      <span className="lp-rail-progress" aria-hidden="true">
        <span
          className="lp-rail-progress-fill"
          style={{ transform: `scaleX(${progress})` } as React.CSSProperties}
        />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

function Chapter({ chapter, index }: { chapter: LandingChapter; index: number }) {
  // Vet, lost and shelter chapters play a sequence (story-sequences.tsx).
  if (hasSequence(chapter.key)) return <SequenceChapter chapter={chapter} index={index} />;
  if (chapter.full) {
    return (
      <div className="lp-chapter" data-full="1" id={`cap-${chapter.key}`}>
        <div className="w-full">
          <div className="lp-ch-num">
            Capítulo {index + 1} · {chapter.hand}
          </div>
          {chapter.lead && <p className="lp-lead lp-ch-lead">{chapter.lead}</p>}
          <div className="mt-4">
            <EstadoConsole />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="lp-chapter" data-side={chapter.side} id={`cap-${chapter.key}`}>
      <div className="lp-chapter-grid">
        <div>
          <div className="lp-ch-num">
            Capítulo {index + 1} · {chapter.hand}
          </div>
          <h3 className="lp-display lp-h-sub lp-ch-title">{chapter.title}</h3>
          <p className="lp-lead lp-ch-lead">{chapter.lead}</p>
        </div>
        <div className="lp-ch-device">{chapterDevice(chapter.key)}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function StorySection() {
  const [active, setActive] = useState(CHAPTERS[0]?.key ?? "dueno");

  useEffect(() => {
    const onScroll = () => {
      const mid = window.innerHeight * 0.45;
      let current = CHAPTERS[0]?.key ?? "dueno";
      for (const c of CHAPTERS) {
        const el = document.getElementById(`cap-${c.key}`);
        if (el && el.getBoundingClientRect().top <= mid) current = c.key;
      }
      setActive((prev) => (prev === current ? prev : current));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <section className="lp-section lp-section--card" id="idea" data-section="story">
      <div className="lp-wrap-wide">
        <div className="lp-maxw-sec mx-auto text-center">
          <p className="lp-eyebrow lp-eyebrow--blue lp-reveal">La idea</p>
          <h2 className="lp-display lp-h-sec lp-reveal mt-3.5" data-d="1">
            Una mascota.
            <br />
            Muchas manos.
          </h2>
          <p className="lp-lead lp-reveal mx-auto mt-4" data-d="2">
            Alrededor de Pampa están su dueño, su veterinaria, un refugio y el Estado. Los tres
            primeros escriben en su libreta; el Estado ve el agregado. Esta es su historia, capítulo
            por capítulo.
          </p>
        </div>

        <div className="lp-reveal mx-auto mt-[clamp(34px,5vw,56px)]" data-d="2">
          <CastFila />
        </div>

        <div className="lp-story-wrap mt-[clamp(40px,6vw,72px)]">
          <Rail active={active} />
          <div className="lp-chapters">
            {CHAPTERS.map((c, i) => (
              <Chapter key={c.key} chapter={c} index={i} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
