"use client";

// Landing hero — Pampa's "credencial viva": a mini DNI-style credential card
// that plays ONCE through the states a real pet moves through over a life,
// then settles for good on "AL DÍA" — the calm, done resting state (PO
// landing redesign 2026-07-04; calmer/institutional pass 2026-07-21: this
// used to loop forever, which read as a consumer-product demo reel — a
// public national registry should not look like it's still selling itself
// after the first look).
//
// The sequence plays once on load: al día → perdida → encontrada (al día) →
// en observación antirrábica → en tratamiento → requiere registro PPP → back
// to AL DÍA, where the interval clears itself and the card stops for good.
// Two of these — "en observación antirrábica" and "requiere registro PPP" —
// are landing-hero-only states with a landing-local tone treatment; the shared
// LnPetStatus/LnStatusFlag type is intentionally NOT extended for them (each
// state carries its own `tone`, mapped to tokens in globals.css via data-tone).
//
// The WHOLE card tints per state: trim background, status badge, photo ring,
// the one contextual read-only row, and the card border. Clicking a state dot
// takes control (stops the one-shot cycle if it's still running) and just
// shows that state — no auto-resume; once a person has taken the wheel, the
// card stays wherever they left it.
//
// Flip: the card turns edge-on (rotateY → 90°), swaps the visible face, then
// turns back — the same single-painted-face mechanism the product's FlipCard
// uses (never two faces in a preserve-3d/backface context; see the FlipCard
// comment + .ln-doc-turn in globals.css). The back is a mini libreta.
//
// Motion contract: the one-shot cycle and the turn only run when motion is
// allowed. Under prefers-reduced-motion (or before hydration / no-JS / SSR)
// the credential sits on the resting state, "al día", front face, never
// advances, and the flip swaps instantly. The "lost" state keeps a subtle
// border pulse (motion-gated).
//
// The QR is REAL and scannable — WHEN the deployment has one to offer:
// server-generated SVG (qrcode package, same pattern as
// /mis-mascotas/[publicToken]) pointing at the demo pet this deployment
// declared and app/page.tsx verified actually resolves. Unchanged as Pampa
// plays through states.
//
// When there is no such pet (production, per dim-interno:docs/ops/cutover-playbook.md's
// "no seed pets"), qrSvg/publicHref/publicToken all arrive null and the card
// degrades to an ILLUSTRATIVE credential: an inert QR glyph, no link, a masked
// token, and microcopy that describes the product instead of inviting a scan.
// It must never render a QR that scans to a 404 — on a government front door
// that is worse than no QR (cold-start review RA-6, finding 1).
//
// Sub-brand note: the serif "Libreta Nacional" display face used across the
// landing (lp-display / --font-ln-serif, see globals.css) is an INTENTIONAL
// departure from literal Poncho — Poncho supplies the palette + Encode Sans
// body type, but the serif display motif is a deliberate sub-brand choice
// (PO decision: keep it, make the page around it calmer). Don't "fix" it back
// to a Poncho display font.

import { PAMPA } from "@/components/landing/landing-content";
import { lostThirdPersonPhrase } from "@/lib/utils/format";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type LandingHeroProps = {
  /** Pre-rendered QR SVG markup (qrcode's toString({ type: "svg" })), or null
   *  when this deployment has no demo pet to point at. */
  qrSvg: string | null;
  /** Public credential URL the QR encodes, e.g. /p/DIM-XXXX-XXXX, or null. */
  publicHref: string | null;
  /** Token displayed on the credential (must match the QR target), or null. */
  publicToken: string | null;
};

/** Shown in place of a real token when there is no demo pet to resolve. */
const PLACEHOLDER_TOKEN = "DIM-••••-••••";

/** Landing-local status tone group (drives the card tint in CSS via data-tone). */
type HeroTone = "ok" | "lost" | "watch" | "sick" | "ppp";

type HeroState = {
  key: string;
  /** Badge label on the credential (also the dot's accessible name). */
  badge: string;
  tone: HeroTone;
  /** The single contextual read-only row on the credential front. */
  row: string;
};

// PO-approved sequence. "encontrada" resolves back to AL DÍA (green) on
// purpose — being found returns the credential to its resting state.
const HERO_STATES: HeroState[] = [
  { key: "aldia", badge: "AL DÍA", tone: "ok", row: "Vacunas firmadas" },
  { key: "perdida", badge: "PERDIDA", tone: "lost", row: "Llamar al dueño" },
  { key: "encontrada", badge: "AL DÍA", tone: "ok", row: "Volvió a casa" },
  { key: "observacion", badge: "EN OBSERVACIÓN", tone: "watch", row: "Cierra sola en 8 días" },
  { key: "tratamiento", badge: "EN TRATAMIENTO", tone: "sick", row: "Plan en el historial" },
  { key: "ppp", badge: "REGISTRO PPP", tone: "ppp", row: "Requisito jurisdiccional" },
];

const CYCLE_MS = 2600;

/**
 * The hero card's edge-on turn, in milliseconds.
 *
 * COUPLED TO CSS: the turn itself is `.lp-hcard { transition: transform … }`
 * in app/globals.css, which reads --motion-slow (300ms) after the MOT-1 token
 * migration collapsed its old 0.28s into the motion scale. The flip timers
 * below must fire just BEYOND this — a timer that fires mid-turn swaps the
 * face while it is still visible. A setTimeout cannot read a CSS custom
 * property, so this is a hand-maintained pair: change --motion-slow, change
 * this constant.
 */
const TURN_MS = 300;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Decorative MRZ line (the DNI wink). Built from the real token by replacing
 * "-" with "<" and padding to the ICAO 44-char width. aria-hidden.
 */
function buildMrz(token: string): string {
  return `P<ARG${PAMPA.name.toUpperCase()}<<${token.replaceAll("-", "<")}`.padEnd(44, "<");
}

/**
 * The credential's flip trigger — one component for both faces so the two
 * triggers can never drift apart (visual 26px, but the CSS ::after extends the
 * hit area to 44×44 — critique 2026-07-27 item A2; the raw <button> is counted
 * once instead of twice by the citizen ratchet, offsetting MilestoneNav's).
 */
function FlipButton({ label, onFlip }: { label: string; onFlip: () => void }) {
  return (
    <button
      type="button"
      className="lp-hcard-flip"
      aria-label={label}
      title="Girar"
      onClick={onFlip}
    >
      ↻
    </button>
  );
}

export function LandingHero({ qrSvg, publicHref, publicToken }: LandingHeroProps) {
  // Always start on "al día", front face — correct for SSR, no-JS, reduced motion.
  const [index, setIndex] = useState(0);
  const [face, setFace] = useState<"front" | "back">("front");

  const cardRef = useRef<HTMLDivElement>(null);
  const cycleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flipTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const flippingRef = useRef(false);

  // Stop the one-shot cycle wherever it currently is (used by manual
  // interaction and by the cycle itself once it completes a full lap).
  const stopCycle = useCallback(() => {
    if (cycleRef.current) {
      clearInterval(cycleRef.current);
      cycleRef.current = null;
    }
  }, []);

  // Play the sequence exactly once, then settle back on "al día" and stop —
  // no restart, ever. Reduced motion (or SSR/no-JS) never starts it at all,
  // so the card simply sits on the initial resting state.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    let step = 0;
    cycleRef.current = setInterval(() => {
      step += 1;
      setIndex(step % HERO_STATES.length);
      if (step >= HERO_STATES.length) stopCycle();
    }, CYCLE_MS);
    return () => {
      stopCycle();
      for (const t of flipTimersRef.current) clearTimeout(t);
    };
  }, [stopCycle]);

  const selectState = useCallback(
    (i: number) => {
      stopCycle();
      setIndex(i);
    },
    [stopCycle],
  );

  // Edge-on flip: turn to 90°, swap the face at the invisible edge, turn back.
  // Icon-only trigger; both faces carry one. Instant swap under reduced motion.
  const flip = useCallback(() => {
    if (flippingRef.current) return;
    flippingRef.current = true;
    stopCycle();
    const el = cardRef.current;
    const swap = () => setFace((f) => (f === "front" ? "back" : "front"));
    if (!el || prefersReducedMotion()) {
      swap();
      flippingRef.current = false;
      return;
    }
    el.style.transform = "rotateY(90deg)";
    const t1 = setTimeout(() => {
      swap();
      el.style.transform = "rotateY(0deg)";
      const t2 = setTimeout(() => {
        flippingRef.current = false;
      }, TURN_MS + 20);
      flipTimersRef.current.push(t2);
    }, TURN_MS + 10);
    flipTimersRef.current.push(t1);
  }, [stopCycle]);

  const state = HERO_STATES[index] ?? HERO_STATES[0];
  // A scannable QR needs BOTH the markup and a target that resolves; app/page.tsx
  // only supplies them together. Anything less renders the inert glyph.
  const scannable = qrSvg !== null && publicHref !== null;
  const displayToken = publicToken ?? PLACEHOLDER_TOKEN;
  const mrz = buildMrz(displayToken);

  return (
    <section className="lp-section lp-section--paper lp-hero" id="top" data-section="landing-hero">
      <div className="lp-wrap-wide">
        <div className="lp-hero-grid">
          <div className="lp-hero-photo lp-reveal" data-d="2">
            <div className="flex w-full flex-col items-center">
              <div className="lp-hcardwrap">
                <div
                  ref={cardRef}
                  className="lp-hcard"
                  data-section="hero-credential"
                  data-tone={state.tone}
                  data-face={face}
                  aria-label={`Credencial de ${PAMPA.name}`}
                >
                  {/* FRONT — the mini credential */}
                  <div className="lp-hcard-front">
                    <div className="lp-hcard-trim">
                      <span className="lp-hcard-brand">
                        <i />
                        miMAR
                      </span>
                      <span className="lp-hcard-trim-r">
                        <span key={index} className="lp-hcard-badge">
                          {state.badge}
                        </span>
                        <FlipButton label="Girar credencial" onFlip={flip} />
                      </span>
                    </div>

                    <div className="lp-hcard-body">
                      <span className="lp-hcard-photo">
                        <Image
                          src="/landing/pampa-hero.jpg"
                          alt={
                            state.tone === "lost"
                              ? `${PAMPA.name}, ${lostThirdPersonPhrase(PAMPA.sexEnum)}`
                              : `${PAMPA.name}, ${PAMPA.speciesNoun}`
                          }
                          fill
                          sizes="64px"
                          className="object-cover"
                        />
                      </span>
                      <span className="lp-hcard-id">
                        <span className="lp-hcard-name">{PAMPA.name}</span>
                        <span className="lp-hcard-token">{displayToken}</span>
                      </span>
                      {scannable ? (
                        <Link
                          href={publicHref}
                          aria-label="Ver la credencial pública de demostración"
                          title="Escaneame — QR real de demostración"
                          className="lp-hcard-qr"
                          // biome-ignore lint/security/noDangerouslySetInnerHtml: server-generated QR SVG from the qrcode package, no user input.
                          dangerouslySetInnerHTML={{ __html: qrSvg }}
                        />
                      ) : (
                        // Inert QR glyph — decorative finder patterns only, no
                        // encoded data and no link. Reuses .lp-hcard-qr so the
                        // card's `64px 1fr auto` grid keeps its shape.
                        <span className="lp-hcard-qr" aria-hidden="true">
                          <svg viewBox="0 0 29 29" fill="none">
                            <title>Ilustración de un código QR</title>
                            <g fill="var(--color-ln-line)">
                              <path d="M0 0h9v9H0zM20 0h9v9h-9zM0 20h9v9H0z" />
                            </g>
                            <g fill="var(--color-ln-card)">
                              <path d="M2 2h5v5H2zM22 2h5v5h-5zM2 22h5v5H2z" />
                            </g>
                            <g fill="var(--color-ln-line)">
                              <path d="M3.5 3.5h2v2h-2zM23.5 3.5h2v2h-2zM3.5 23.5h2v2h-2z" />
                              <path d="M12 0h2v2h-2zM12 4h2v2h-2zM12 8h2v2h-2zM16 12h2v2h-2zM12 12h2v2h-2zM8 12h2v2h-2zM4 12h2v2h-2zM0 12h2v2H0zM20 12h2v2h-2zM24 12h2v2h-2zM12 16h2v2h-2zM12 20h2v2h-2zM12 24h2v2h-2zM16 16h2v2h-2zM20 20h2v2h-2zM24 24h2v2h-2zM16 24h2v2h-2zM24 16h2v2h-2z" />
                            </g>
                          </svg>
                        </span>
                      )}
                    </div>

                    <div key={index} className="lp-hcard-ctx">
                      <span className="lp-hcard-ctx-chev" aria-hidden="true">
                        ▸
                      </span>
                      <span>{state.row}</span>
                    </div>

                    <div className="lp-hcard-mrz" aria-hidden="true">
                      {mrz}
                    </div>
                  </div>

                  {/* BACK — the mini libreta sanitaria */}
                  <div className="lp-hcard-back">
                    <div className="lp-hcard-libhead">
                      <b>Libreta sanitaria</b>
                      <span className="lp-hcard-trim-r">
                        <span className="lp-hcard-libmeta">
                          {PAMPA.name} · {displayToken}
                        </span>
                        <FlipButton label="Volver a la credencial" onFlip={flip} />
                      </span>
                    </div>

                    <div className="lp-hcard-librow">
                      <span>
                        <span className="lp-hcard-libwhat">Antirrábica</span>
                        <span className="lp-hcard-libwho">Vet. M.N. 12.345 · 03/2026</span>
                      </span>
                      <span className="lp-hcard-libstamp">FIRMADA</span>
                    </div>
                    <div className="lp-hcard-librow">
                      <span>
                        <span className="lp-hcard-libwhat">Desparasitación</span>
                        <span className="lp-hcard-libwho">Vet. M.N. 12.345 · 01/2026</span>
                      </span>
                      <span className="lp-hcard-libstamp">FIRMADA</span>
                    </div>
                    <div className="lp-hcard-librow">
                      <span>
                        <span className="lp-hcard-libwhat">Control anual</span>
                        <span className="lp-hcard-libwho">Clínica Recoleta · 11/2025</span>
                      </span>
                      <span className="lp-hcard-libstamp">FIRMADA</span>
                    </div>
                    <div className="lp-hcard-libfoot">…y toda su historia, inmutable.</div>
                  </div>
                </div>
              </div>

              {/* Curiosity-hook microcopy (PO-locked wording, landing microcopy
                  train): sits between the credential and the state dots, so it
                  reads as "about this card" without crowding either. Points at
                  the same QR the card already renders — no new link, just the
                  nudge to actually try it.

                  With no demo pet to resolve, the invitation would be a lie, so
                  the line describes the product instead (RA-6 finding 1). */}
              <p className="lp-hcard-hint lp-reveal" data-d="3">
                {scannable
                  ? `Escanealo para ver más sobre ${PAMPA.name}`
                  : "Cada mascota registrada tiene su credencial pública con QR"}
              </p>

              {/* State dots — tap one to take control of the cycle */}
              <div className="lp-hdots" role="toolbar" aria-label="Estados de la credencial">
                {HERO_STATES.map((s, i) => (
                  <button
                    key={s.key}
                    type="button"
                    className="lp-hdot"
                    data-on={i === index}
                    data-tone={s.tone}
                    aria-label={s.badge}
                    aria-pressed={i === index}
                    onClick={() => selectState(i)}
                  />
                ))}
              </div>
            </div>
          </div>

          <div>
            {/* Eyebrow: describes the artifact the hero card is already
                drawing. It used to read "República Argentina · Ministerio de
                Salud" — an endorsement nobody granted (there is no convenio
                with any state body, and the Mi Argentina agreement is still an
                open prerequisite). A claim of state backing on the first line
                above the headline is exactly what Play treats as impersonation
                and what a funcionario would read as a signature they never
                gave. Replaced with what the product actually is. */}
            <p className="lp-eyebrow lp-eyebrow--dot lp-reveal">
              Credencial digital · QR público verificable
            </p>
            <h1 className="lp-display lp-h-hero lp-reveal mt-4" data-d="1">
              Toda una vida,
              <br />
              en una sola miMAR.
            </h1>
            <p className="lp-lead lp-reveal mt-6" data-d="2">
              miMAR es el registro nacional de mascotas: una identidad pública y un historial
              inmutable, compartido por todas las manos que la cuidan.
            </p>
            <div className="lp-hero-cta lp-reveal" data-d="3">
              {/* The primary "Crear tu miMAR" CTA that used to live here was
                  removed (PO feedback 2026-07-21): it duplicated LandingNav's
                  "Crear mi miMAR" (/signup), both visible above the fold at
                  once. "Cómo funciona" is a distinct secondary action (scrolls
                  to #idea) and stays as the hero's own CTA. */}
              <a href="#idea" className="lp-btn lp-btn--ghost">
                Cómo funciona
              </a>
            </div>
            {/* Hero triad — exact copy is a PO-locked decision (#4). */}
            <p className="lp-hero-kill lp-reveal" data-d="4">
              <b>Gratis para siempre.</b> Sin papeleo. Datos abiertos.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
