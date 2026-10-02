"use client";

// Landing hero — Pampa's "credencial viva": a miniature of the REAL public
// credential the QR opens (app/(public)/p/[publicToken]/page.tsx and the owner
// app's DocumentChrome band — PO 2026-09-25: "a credential similar to the
// actually implemented one … clearly a type of credential or document"). It is
// miMAR's document, never a State one: no escudo, no "República Argentina",
// and the machine-readable strip is miMAR's own format (heroMrzLines), not the
// "P<ARG" passport line it replaced. The card plays ONCE through the states a
// real pet moves through over a life,
// then settles for good on "AL DÍA" — the calm, done resting state (PO
// landing redesign 2026-07-04; calmer/institutional pass 2026-07-21: this
// used to loop forever, which read as a consumer-product demo reel — a
// public national registry should not look like it's still selling itself
// after the first look).
//
// The sequence plays once on load: al día → perdida → en observación
// antirrábica → en tratamiento → back to AL DÍA, where the interval clears
// itself and the card stops for good. The "de vuelta en casa" state was
// removed (PO 2026-09-29): it resolved back to the same AL DÍA wording
// anyway. Only states an OWNER lives through (PO 2026-09-29, critique M4,
// reversing handoff decision B4): "EN OBSERVACIÓN" and "REGISTRO PPP ·
// Requisito jurisdiccional" were removed because that pair was jurisdiction
// PAPERWORK — "PPP" is explained nowhere on the page, and /municipios already
// covers that registration workflow. The rabies-observation state below (PO
// request, same day) is a DIFFERENT thing: a pet under clinical quarantine
// after a bite is squarely the owner's own situation, not a jurisdiction
// form — the product's own lib/ui/pet-situation.ts already names it
// "observacion-antirrabica" on the real credential, so the hero now tells the
// same truth about it.
//
// The WHOLE card tints per state: trim background, photo ring, the one
// contextual read-only row, and the card border. The visible status badge
// (PO 2026-09-25: "no me gusta el chip") is GONE — the lost state instead
// recolors the card's own front background, mirroring the same
// --color-ln-err-050 token the owner app's public credential uses for its
// masthead tint (.pc-cred[data-situation="perdida"] .pc-head, app/globals.css)
// and LnStatusFlag's lost variant (components/ui/StatusFlag.tsx). The state is
// still exposed to assistive tech via an sr-only aria-live region (see the
// span right inside .lp-hcard) since the visible label is gone. Clicking a
// state dot takes control (stops the one-shot cycle if it's still running)
// and just shows that state — no auto-resume; once a person has taken the
// wheel, the card stays wherever they left it.
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

import { Icon } from "@/components/Icon";
import {
  CRISIS_DOORS,
  HERO_CREDENTIAL_FIELDS,
  HERO_LIBRETA_ROWS,
  PAMPA,
  heroMrzLines,
} from "@/components/landing/landing-content";
import { lostThirdPersonPhrase } from "@/lib/utils/format";
import googlePlayBadge from "@/public/landing/google-play-badge-es419.png";
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

/** Landing-local status tone group (drives the card tint in CSS via data-tone).
 *  "vigilancia" mirrors the product's own tone for this situation (see
 *  lib/ui/pet-situation.ts's `PetSituationTone`). */
type HeroTone = "ok" | "lost" | "vigilancia" | "sick";

type HeroState = {
  key: string;
  /** Badge label on the credential (also the dot's accessible name). */
  badge: string;
  tone: HeroTone;
  /** The single contextual read-only row on the credential front. */
  row: string;
};

// PO-approved sequence. The "encontrada" / "de vuelta en casa" state was
// removed (PO 2026-09-29): it only resolved back to AL DÍA, so it read as a
// second, differently-named copy of the resting state. "observacion" was
// added the same day (separate PO request): the badge reuses the product's
// own "observacion-antirrabica" label verbatim (lib/ui/pet-situation.ts) so
// stateWord()'s default capitalize(badge.toLowerCase()) path reproduces it
// exactly — no special-casing needed, unlike "perdida"'s sex agreement.
const HERO_STATES: HeroState[] = [
  { key: "aldia", badge: "AL DÍA", tone: "ok", row: "Vacunas firmadas" },
  { key: "perdida", badge: "PERDIDA", tone: "lost", row: "Llamar al dueño" },
  {
    key: "observacion",
    badge: "EN OBSERVACIÓN ANTIRRÁBICA",
    tone: "vigilancia",
    // Shortened (PO 2026-09-30): "Mordedura · control de 10 días" — and even
    // "Mordedura · 10 días" — pushed the notice past one line at 390px
    // alongside the (already long) state word. "Mordedura" alone still says
    // the truthful cause; the 10-day control period lives in the pet's own
    // history once the credential is real.
    row: "Mordedura",
  },
  // Kept (landing-vs-app audit 2026-09-30): the PUBLIC page never shows it
  // (its situation is fed public-safe signals only), but this card is the
  // OWNER's view, and there it is real — an active medication course sets
  // inTreatment (src/modules/pets/application/read/load-owner-pet-detail.ts:
  // 503, :710) and derivePetSituation returns "En tratamiento"
  // (lib/ui/pet-situation.ts:166); the native document band prints it too
  // (apps/mobile/src/pets/DocumentChromeNative.tsx:95, its band skin).
  { key: "tratamiento", badge: "EN TRATAMIENTO", tone: "sick", row: "Plan en el historial" },
];

/**
 * The state, in words, on the card's own body (critique 2026-09-29, M4).
 *
 * The chip that used to carry it was removed (PO 2026-09-25), which left the
 * lost state readable ONLY through the card turning pink: colour as the sole
 * carrier, WCAG 1.4.1. One line, not a chip: the word leads the contextual row.
 */
function stateWord(key: string, badge: string): string {
  if (key === "perdida") return capitalize(lostThirdPersonPhrase(PAMPA.sexEnum));
  return capitalize(badge.toLowerCase());
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

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
  // What the live region says. Empty until the PERSON changes something: the
  // one-shot cycle used to be announced too, six announcements in a row while
  // a screen-reader user was still reaching the H1 (critique 2026-09-29, M4).
  const [announcement, setAnnouncement] = useState("");

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

  // Only a person flips the card (the cycle never does), so every face change
  // after mount is theirs to hear about.
  const shownFaceRef = useRef(face);
  useEffect(() => {
    if (shownFaceRef.current === face) return;
    shownFaceRef.current = face;
    setAnnouncement(
      face === "back" ? "Mostrando la libreta sanitaria." : "Mostrando la credencial.",
    );
  }, [face]);

  const selectState = useCallback(
    (i: number) => {
      stopCycle();
      setIndex(i);
      const picked = HERO_STATES[i];
      if (picked) {
        setAnnouncement(
          `Estado de la credencial: ${stateWord(picked.key, picked.badge)}. ${picked.row}.`,
        );
      }
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
  const word = stateWord(state.key, state.badge);
  // A scannable QR needs BOTH the markup and a target that resolves; app/page.tsx
  // only supplies them together. Anything less renders the inert glyph.
  const scannable = qrSvg !== null && publicHref !== null;
  const displayToken = publicToken ?? PLACEHOLDER_TOKEN;
  const mrz = heroMrzLines(publicToken);

  return (
    <section className="lp-section lp-section--paper lp-hero" id="top" data-section="landing-hero">
      <div className="lp-wrap-wide">
        <div className="lp-hero-grid">
          {/* COPY FIRST, in the DOM and on every screen (critique 2026-09-29,
              C3). The credential used to come first on phones: at 390px the
              H1 began at y≈734, below the fold, so the first screen showed a
              card without saying what miMAR is. Source order is now reading
              order at every width: desktop puts the copy left and the card
              right with no `order` reordering at all, which also retires the
              focus-order trade-off the 2026-08-10 inversion had to make. */}
          <div className="lp-hero-copy">
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
            <h1 className="lp-display lp-h-hero lp-reveal" data-d="1">
              Toda una vida,
              <br />
              en una sola libreta.
            </h1>
            {/* Honesty pass (WU1, landing redesign 2026-09-24; corrected
                2026-09-24 review): "registro nacional" and "inmutable" both
                overclaimed — there is no convenio with any state body (see
                state-endorsement-fence), and art. 16 de la Ley 25.326
                requires an audited suppression exception over the event log
                (límites honestos A.1). "Nada se reescribe" ALSO overclaimed —
                /privacidad documents that account erasure replaces the
                user's free text with a notice, which is a rewrite. Now uses
                A.1's own wording: "una corrección es un asiento nuevo, nunca
                una edición" describes the append-only DEFAULT without
                denying the audited exception.
                Owner's words (critique 2026-09-29, M2, PO-approved): the
                technical "asiento" sentence now lives only in chapter 5. The
                critique proposed "Nadie puede borrar ni cambiar lo que firmó
                tu veterinaria", which denies the same audited exception, so
                this says what is true in the same plain register.
                PO 2026-09-30: the "no se edita … asiento nuevo" sentence was
                removed from the hero lead entirely (it still lives in
                chapter 5, see StorySection.tsx) to make room for the Play
                badge right below. */}
            <p className="lp-lead lp-reveal" data-d="2">
              La libreta de tu mascota en el teléfono, con un QR que cualquiera puede escanear si se
              pierde.
            </p>
            {/* Google Play badge (PO 2026-09-30): the Android app is approved
                on Play, but there is no listing URL yet — this renders the
                OFFICIAL es-419 badge asset as a plain image, never an anchor,
                so nothing here looks clickable before there is somewhere to
                click. Do not wrap this in a disabled/dead <a>: an inert link
                is worse than an inert image (same doctrine as the hero QR
                never scanning to a 404, see demo-pet.ts). The asset is
                Google's own PNG, downloaded unmodified from Google's badge
                service (play.google.com/intl/en_us/badges/static/images/
                badges/es-419_badge_web_generic.png — Google Play and the
                Google Play logo are trademarks of Google LLC; this badge is
                used per Google's brand guidelines, unaltered), sized in
                landing.css (.lp-hero-badge) by CSS height only so its aspect
                ratio, colors and clear space are never distorted. Once
                NEXT_PUBLIC_PLAY_STORE_URL resolves (lib/ui/play-store.ts),
                wrap this same image in that link — do not build a second
                badge element. */}
            <div className="lp-hero-badge lp-reveal" data-d="2">
              {/* width/height are the asset's real pixel dimensions (Google's
                  own PNG, 646×250) — required because this import resolves to
                  a plain public-URL string, not a bundler-probed
                  StaticImageData object (the file lives in public/, and this
                  image isn't shown with `fill`, so next/image needs the box
                  explicitly). CSS
                  (.lp-hero-badge img, app/landing.css) then scales it by
                  height only, so the true aspect ratio is preserved. */}
              <Image
                src={googlePlayBadge}
                alt="Disponible en Google Play"
                width={646}
                height={250}
              />
            </div>
            {/* The three crisis doors (PO 2026-10-02), in place of the old
                "Crear la libreta de mi mascota" / "Cómo funciona" row: the
                nav's "Crear mi miMAR" is the sign-up entry above the fold, and
                the separate crisis band that carried these doors below the
                fold is gone, so a visitor in a hurry finds them on the first
                screen at every width. Real links, one row on desktop and a
                compact stack on a phone (app/landing.css, .lp-hero-doors). The
                aria-label is the one the band carried, which
                e2e/csp-smoke.spec.ts anchors the landing's marker on. */}
            <nav
              className="lp-hero-doors lp-reveal"
              data-d="3"
              aria-label="Emergencias — sin cuenta"
              data-section="crisis-doors"
            >
              {CRISIS_DOORS.map((door) => (
                <Link key={door.t} className="lp-hero-door" data-t={door.t} href={door.href}>
                  <span className="lp-hero-door-ic" aria-hidden="true">
                    <Icon name={door.icon} size="sm" decorative />
                  </span>
                  <span className="lp-hero-door-txt">
                    <b>{door.label}</b>
                    <span className="lp-hero-door-sub">{door.sub}</span>
                  </span>
                </Link>
              ))}
            </nav>
            {/* Hero triad — exact copy is a PO-locked decision (#4), revised by
                the PO 2026-09-29 (critique M3): "Datos abiertos" beside a pet's
                credential read as "my pet's data is open", which the FAQ
                "¿Quién ve los datos…?" contradicts. What is open is the
                statistics, and they carry no personal data. */}
            <p className="lp-hero-kill lp-reveal" data-d="4">
              <b>Gratis para siempre.</b> Sin papeleo. Estadísticas abiertas y anónimas.
            </p>
          </div>

          <div className="lp-hero-photo lp-reveal" data-d="2">
            <div className="flex w-full flex-col items-center">
              <div className="lp-hcardwrap">
                <div
                  ref={cardRef}
                  className="lp-hcard"
                  data-section="hero-credential"
                  data-tone={state.tone}
                  data-face={face}
                  aria-label={`Credencial de ${PAMPA.name} — estado: ${word}`}
                >
                  {/* Live region for the changes a PERSON makes: a state dot,
                      the flip. The automatic cycle is not announced, it would
                      talk over the H1. The aria-label above carries the
                      CURRENT state for a reader that lands on the card, and
                      the visible state word below carries it for everyone. */}
                  <span className="sr-only" aria-live="polite">
                    {announcement}
                  </span>
                  {/* FRONT — the credential the QR opens, in miniature: the
                      guilloche band and issuing line, photo and QR rising out
                      of the band, name and token between them, the identity
                      fields the public page prints, the one state row, and
                      miMAR's own machine-readable strip. */}
                  <div className="lp-hcard-front">
                    <div className="lp-hcard-band">
                      <span className="lp-hcard-issuer">
                        {/* The real mark, decorative: the issuing line beside
                            it is the text. */}
                        <span className="lp-hcard-mark" aria-hidden="true">
                          {/* <=24px surface: the small-size cut, not the main
                              mark scaled down — see public/logo-mimar-mark-small.svg. */}
                          <img src="/logo-mimar-mark-small.svg" alt="" width={18} height={18} />
                        </span>
                        <span>
                          <span className="lp-hcard-issuer-name">Credencial miMAR</span>
                          <span className="lp-hcard-issuer-sub">Libreta sanitaria · frente</span>
                        </span>
                      </span>
                      <span className="lp-hcard-trim-r">
                        {/* The status seal/badge was removed (PO 2026-09-25:
                            "no me gusta el chip"). The state now reads through
                            the card's own background colour (lost) plus the
                            border pulse, photo ring and contextual row that
                            already tinted per state — see the sr-only live
                            region above for the accessible carrier. */}
                        <FlipButton label="Girar credencial" onFlip={flip} />
                      </span>
                    </div>
                    {/* The per-state rule under the band — the public card's
                        8px strip recolouring by situation, in miniature. */}
                    <div className="lp-hcard-tone" aria-hidden="true" />

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
                          // The box it paints into is 96px (.lp-hcard-photo);
                          // "76px" asked for an image smaller than the box and
                          // scaled it up (critique 2026-09-29, m3).
                          sizes="96px"
                          // Above the fold on phones and desktop alike.
                          // fetchPriority alone left next/image's default
                          // loading="lazy" in place; `priority` loads it
                          // eagerly and preloads it.
                          priority
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

                    {/* Identity fields — the public credential's own labels. */}
                    <dl className="lp-hcard-fields">
                      {HERO_CREDENTIAL_FIELDS.map((f) => (
                        <div key={f.label}>
                          <dt>{f.label}</dt>
                          <dd>{f.value}</dd>
                        </div>
                      ))}
                    </dl>

                    <div key={index} className="lp-hcard-ctx" data-section="hero-state-line">
                      <span className="lp-hcard-ctx-chev" aria-hidden="true">
                        ▸
                      </span>
                      <span>
                        <b className="lp-hcard-ctx-state">{word}</b> · {state.row}
                      </span>
                    </div>

                    {/* miMAR's own machine-readable strip (see heroMrzLines):
                        decorative, so hidden from assistive tech — and still
                        drawn at full contrast, because a low-vision reader
                        can see it (review L-5). */}
                    <div className="lp-hcard-mrz" aria-hidden="true">
                      <span>{mrz[0]}</span>
                      <span>{mrz[1]}</span>
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

                    {/* The three newest vet-signed entries of Pampa's
                        libreta, from the seed's data module. */}
                    {HERO_LIBRETA_ROWS.map((row) => (
                      <div className="lp-hcard-librow" key={`${row.what}-${row.who}`}>
                        <span>
                          <span className="lp-hcard-libwhat">{row.what}</span>
                          <span className="lp-hcard-libwho">{row.who}</span>
                        </span>
                        <span className="lp-hcard-libstamp">FIRMADA</span>
                      </div>
                    ))}
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
        </div>
      </div>
    </section>
  );
}
