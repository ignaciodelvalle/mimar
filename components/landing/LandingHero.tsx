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
// Flip: the card turns edge-on (rotateY → 90°), swaps the visible face, and
// keeps turning the SAME way from the far edge (-90° → 0°) — one continuous
// half-turn, drawn with the single-painted-face mechanism the product's
// FlipCard uses (never two faces in a preserve-3d/backface context; see the
// FlipCard comment + .ln-doc-turn in globals.css). The back is a mini libreta.
// The two halves are CSS keyframes (app/landing.css, lp-hcard-turn-out/-in)
// shaped like a real flick (PO 2026-10-02, v2): slow start, fastest at the
// edge, a slow landing that carries a few degrees past flat and settles.
//
// Motion contract: the one-shot cycle and the turn only run when motion is
// allowed. Under prefers-reduced-motion (or before hydration / no-JS / SSR)
// the credential sits on the resting state, "al día", front face, never
// advances, and the flip swaps instantly. The "lost" state keeps a subtle
// border pulse (motion-gated).
//
// A held card, not a picture of one (PO 2026-10-02). Four nested layers, each
// owning ONE transform channel so none of them fights another for it:
//   .lp-hcardwrap    perspective + the one-time CSS entrance (@starting-style)
//   .lp-hcard-float  the first-sight hint, one gentle turn (`rotate`) that says
//                    "this turns", and a slow float (`translate`) that stops by
//                    itself after two breaths. Both are CSS animations, started
//                    ONCE, when the card first comes into view (data-alive).
//   .lp-hcard-tilt   the desktop pointer tilt (`transform`, written per frame)
//                    plus the parallax offsets its children read (custom
//                    properties written in the same frame) and the hover lift
//                    (`translate`, CSS :hover)
//   .lp-hcard-slab   the edge-on flip (`animation` on `transform`), carrying
//                    the card AND the stacked edge layers that give it a
//                    carnet's thickness
// The chain is preserve-3d end to end, so nothing in it may carry a property
// that flattens 3D (overflow, opacity < 1, filter, clip-path, mask). The
// card's own overflow clip is fine: it is the LEAF of the chain.
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
  type HeroTilt,
  heroParallax,
  smoothTilt,
  tiltTowardPointer,
} from "@/components/landing/hero-card-tilt";
import {
  CRISIS_DOORS,
  HERO_CREDENTIAL_FIELDS,
  HERO_LIBRETA_ROWS,
  PAMPA,
  heroMrzLines,
} from "@/components/landing/landing-content";
import { resolvePlayStoreUrl } from "@/lib/ui/play-store";
import { lostThirdPersonPhrase } from "@/lib/utils/format";
import googlePlayBadge from "@/public/landing/google-play-badge-es419.png";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// Read once at module scope by LITERAL access so Next inlines the value into
// this client bundle; null keeps the badge a plain image.
const playStoreUrl = resolvePlayStoreUrl({
  NEXT_PUBLIC_PLAY_STORE_URL: process.env.NEXT_PUBLIC_PLAY_STORE_URL,
});

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
 * The two halves of the hero card's turn, in milliseconds.
 *
 * COUPLED TO CSS: the halves are the lp-hcard-turn-out / lp-hcard-turn-in
 * animations on `.lp-hcard-slab[data-turn]` in app/landing.css, timed
 * `calc(var(--motion-slow) * 0.9)` (300 × 0.9 = 270ms, accelerating into the
 * edge) and `calc(var(--motion-deliberate) * 0.75)` (600 × 0.75 = 450ms,
 * landing with the overshoot). The timers below must fire just BEYOND each
 * half — a timer that fires mid-turn swaps the face while it is still
 * visible. A setTimeout cannot read a CSS custom property, so these are
 * hand-maintained pairs: change a token or a factor, change the constant.
 */
const TURN_OUT_MS = 270;
const TURN_IN_MS = 450;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A mouse or trackpad that can hover: the only input the pointer tilt
 *  answers. Touch screens never get it: a finger has no hover, and a tilt that
 *  followed a drag would fight the page's own scroll. */
function hasFinePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

/** How much of the card must be on screen before the first-sight hint plays. */
const ALIVE_THRESHOLD = 0.6;

/** The stacked layers behind the card that read as its edge when it leans.
 *  Each layer's depth lives in CSS (.lp-hcard-edge:nth-child). */
const EDGE_LAYERS = [1, 2, 3, 4, 5] as const;

const FLAT: HeroTilt = { rx: 0, ry: 0 };

/** The parallax offsets the card's layers read, as custom properties on the
 *  tilt layer (app/landing.css: .lp-hcard-photo img, .lp-hcard-sec). */
const PARALLAX_VARS = ["--lp-photo-x", "--lp-photo-y", "--lp-sec-x", "--lp-sec-y"] as const;

/** The issuer line both faces print (PO 2026-10-02, v2): the mark and the
 *  name, small and quiet, the way an issuer reads on a printed card. The mark
 *  is drawn as a CSS mask of the real small-size cut so it takes the band's
 *  ink instead of sitting on a paper tile. */
function IssuerMark() {
  return (
    <span className="lp-hcard-issuer">
      <span className="lp-hcard-mark" aria-hidden="true" />
      <span className="lp-hcard-issuer-name">miMAR</span>
    </span>
  );
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

  const wrapRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const slabRef = useRef<HTMLDivElement>(null);
  // Wakes the tilt loop (set by the tilt effect). A flip calls it so the card
  // settles flat while it turns edge-on.
  const wakeTiltRef = useRef<(() => void) | null>(null);
  // Set the first time the card is really on screen, never unset: starts the
  // CSS hint + float exactly once per page view.
  const [alive, setAlive] = useState(false);
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

  // First sight: once most of the card is on screen, play the hint and the
  // float, once. No observer (old browser, jsdom) or reduced motion: the card
  // stays still, which is exactly the no-JS rendering.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setAlive(true);
          io.disconnect();
        }
      },
      { threshold: ALIVE_THRESHOLD },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Pointer tilt, desktop only. The listeners only RECORD the pointer; one
  // requestAnimationFrame loop reads the box, smooths toward the target and
  // writes a single transform, then stops itself once the card has settled.
  useEffect(() => {
    if (prefersReducedMotion() || !hasFinePointer()) return;
    const wrap = wrapRef.current;
    const tilt = tiltRef.current;
    if (!wrap || !tilt) return;

    let pointer: { x: number; y: number } | null = null;
    let current: HeroTilt = FLAT;
    let frame = 0;
    let last = 0;

    const tick = (now: number) => {
      const dt = last === 0 ? 16 : now - last;
      last = now;
      let target = FLAT;
      if (pointer && !flippingRef.current) {
        const box = wrap.getBoundingClientRect();
        target = tiltTowardPointer(
          pointer.x - box.left,
          pointer.y - box.top,
          box.width,
          box.height,
        );
      }
      current = smoothTilt(current, target, dt);
      const settled =
        Math.abs(current.rx - target.rx) < 0.02 && Math.abs(current.ry - target.ry) < 0.02;
      if (settled) current = target;
      if (current.rx === 0 && current.ry === 0) {
        tilt.style.transform = "";
        for (const name of PARALLAX_VARS) tilt.style.removeProperty(name);
      } else {
        tilt.style.transform = `rotateX(${current.rx.toFixed(3)}deg) rotateY(${current.ry.toFixed(3)}deg)`;
        // The same smoothed lean, seen at two more depths: the photo rides
        // above the surface, the security hatch below it.
        const { photo, pattern } = heroParallax(current);
        tilt.style.setProperty("--lp-photo-x", `${photo.x.toFixed(2)}px`);
        tilt.style.setProperty("--lp-photo-y", `${photo.y.toFixed(2)}px`);
        tilt.style.setProperty("--lp-sec-x", `${pattern.x.toFixed(2)}px`);
        tilt.style.setProperty("--lp-sec-y", `${pattern.y.toFixed(2)}px`);
      }
      // Settled on its target: stop. The next pointer event wakes it again,
      // so a still pointer over a still card costs nothing.
      if (settled) {
        frame = 0;
        last = 0;
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };
    const wake = () => {
      if (frame === 0) frame = window.requestAnimationFrame(tick);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      pointer = { x: e.clientX, y: e.clientY };
      wake();
    };
    const onLeave = () => {
      pointer = null;
      wake();
    };

    wakeTiltRef.current = wake;
    wrap.addEventListener("pointermove", onMove, { passive: true });
    wrap.addEventListener("pointerleave", onLeave, { passive: true });
    return () => {
      wakeTiltRef.current = null;
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      tilt.style.transform = "";
      for (const name of PARALLAX_VARS) tilt.style.removeProperty(name);
    };
  }, []);

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

  // The face showing, readable from the flip without re-creating it. Only the
  // flip's own swap changes the face, so the swap keeps this in step.
  const faceRef = useRef<"front" | "back">("front");

  // Half-turn: accelerate into the edge (data-turn="out"), swap the face at the
  // invisible edge, land from the far edge with a little overshoot
  // (data-turn="in"). Front → back turns one way, back → front the other, the
  // way a hand turns a card over and back. Icon-only trigger; both faces carry
  // one. Instant swap under reduced motion.
  const flip = useCallback(() => {
    if (flippingRef.current) return;
    flippingRef.current = true;
    stopCycle();
    const el = slabRef.current;
    const swap = () => {
      faceRef.current = faceRef.current === "front" ? "back" : "front";
      setFace(faceRef.current);
    };
    if (!el || prefersReducedMotion()) {
      swap();
      flippingRef.current = false;
      return;
    }
    // The pointer tilt settles flat while the card turns, so lean + turn never
    // add up past edge-on (the card's reverse would show, mirrored).
    wakeTiltRef.current?.();
    el.dataset.dir = faceRef.current === "front" ? "fwd" : "rev";
    el.dataset.turn = "out";
    const t1 = setTimeout(() => {
      swap();
      el.dataset.turn = "in";
      const t2 = setTimeout(() => {
        delete el.dataset.turn;
        flippingRef.current = false;
        wakeTiltRef.current?.();
      }, TURN_IN_MS + 20);
      flipTimersRef.current.push(t2);
    }, TURN_OUT_MS + 10);
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
            {/* No eyebrow (PO 2026-10-02): the H1 opens the hero. The eyebrow
                once claimed state backing ("República Argentina · Ministerio de
                Salud", an endorsement nobody granted) and later described the
                card the hero already draws; neither earns the first line.
                state-endorsement-fence keeps any endorsement from coming back. */}
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
            {/* Quick doors (PO 2026-10-02): four public entry points in a 2×2
                grid, no account needed — Encontré, Adoptar, Refugios y vets
                cerca, Maltrato (landing-content.ts, CRISIS_DOORS). Real links
                (app/landing.css, .lp-hero-doors). The aria-label anchors the
                landing's marker in e2e/csp-smoke.spec.ts. */}
            <nav
              className="lp-hero-doors lp-reveal"
              data-d="3"
              aria-label="Accesos rápidos — sin cuenta"
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
            {/* Google Play badge, aligned under the doors grid (PO
                2026-10-02). Google's own es-419 PNG, unmodified (Google Play
                and the Google Play logo are trademarks of Google LLC; used per
                Google's brand guidelines), sized by CSS height only
                (.lp-hero-badge img). It becomes a link only once
                NEXT_PUBLIC_PLAY_STORE_URL resolves to a real listing
                (lib/ui/play-store.ts); until then it stays a plain image —
                an inert link is worse than an inert image. The env var is read
                by literal access so Next inlines it into this client bundle.
                width/height are the asset's real pixels (646×250). */}
            <div className="lp-hero-badge lp-reveal" data-d="3">
              {playStoreUrl ? (
                <a href={playStoreUrl} rel="noopener">
                  <Image
                    src={googlePlayBadge}
                    alt="Disponible en Google Play"
                    width={646}
                    height={250}
                  />
                </a>
              ) : (
                <Image
                  src={googlePlayBadge}
                  alt="Disponible en Google Play"
                  width={646}
                  height={250}
                />
              )}
            </div>
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
              <div className="lp-hcardwrap" ref={wrapRef} data-alive={alive ? "true" : undefined}>
                {/* The soft shadow the card casts on the paper; it breathes
                    with the float (CSS only). */}
                <span className="lp-hcard-ground" aria-hidden="true" />
                <div className="lp-hcard-float">
                  <div className="lp-hcard-tilt" ref={tiltRef}>
                    <div className="lp-hcard-slab" ref={slabRef}>
                      {/* The carnet's thickness: layers stacked BEHIND the card
                          in depth, coloured like a printed card's core (paper
                          laminate, navy core, one celeste stripe). Flat-on
                          they hide behind it; turning edge-on, their rims read
                          as the card's edge. */}
                      {EDGE_LAYERS.map((n) => (
                        <span key={n} className="lp-hcard-edge" aria-hidden="true" />
                      ))}
                      {/* The deeper shadow of a card lifted off the paper: it
                          fades in on hover (opacity only) behind the stack. */}
                      <span className="lp-hcard-lift" aria-hidden="true" />
                      <div
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
                          {/* The security hatch, printed UNDER everything on the
                          face (miMAR's own, not a State seal: no hologram, no
                          iridescence). Its own layer so the parallax can slide
                          it. */}
                          <span className="lp-hcard-sec" aria-hidden="true" />
                          <div className="lp-hcard-band">
                            {/* The issuer line (PO 2026-10-02, v2): quiet, small,
                            letter-spaced — it says who issued the card and then
                            gets out of the way of the pet. */}
                            <div className="lp-hcard-head">
                              <IssuerMark />
                              <span className="lp-hcard-doctype">Credencial digital</span>
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
                          <span className="lp-hcard-sec" aria-hidden="true" />
                          {/* The same quiet issuer line as the front, on a
                          shorter band: two sides of one document. */}
                          <div className="lp-hcard-libhead">
                            <div className="lp-hcard-head">
                              <IssuerMark />
                              <span className="lp-hcard-doctype">Libreta sanitaria</span>
                              <span className="lp-hcard-trim-r">
                                <FlipButton label="Volver a la credencial" onFlip={flip} />
                              </span>
                            </div>
                          </div>
                          <div className="lp-hcard-libmeta">
                            <span className="lp-hcard-libname">{PAMPA.name}</span>
                            <span className="lp-hcard-libtoken">{displayToken}</span>
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
