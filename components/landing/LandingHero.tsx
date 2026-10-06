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
// Status colour lives in ONE inset plaque on the front. The card perimeter,
// photo and QR mounts stay neutral. The visible status badge is gone (PO
// 2026-09-25). The state is still exposed to assistive tech via an sr-only
// aria-live region inside .lp-hcard. Clicking a state dot takes control
// (stops the one-shot cycle if it's still running) and just shows that
// state — no auto-resume; once a person has taken the wheel, the card stays
// wherever they left it.
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
// advances, and the flip swaps instantly.
//
// A held card, not a picture of one (PO 2026-10-02). Four nested layers, each
// owning ONE transform channel so none of them fights another for it:
//   .lp-hcardwrap    perspective + the one-time CSS entrance (@starting-style)
//   .lp-hcard-float  the first-sight hint, one gentle turn (`rotate`) that says
//                    "this turns", then an infrequent idle breath (`translate`,
//                    one short lift every 12s) so the card still reads as held
//                    and waiting. A flip writes data-hint-done and the idle
//                    stops. Both are CSS animations, started when the card
//                    first comes into view (data-alive).
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
import { CredentialCarnetFaces } from "@/components/landing/CredentialCarnetFaces";
import { buildLandingCarnetSlots } from "@/components/landing/build-landing-carnet-slots";
import {
  type HeroTilt,
  heroParallax,
  heroPivot,
  heroPress,
  smoothTilt,
  tiltTowardPointer,
} from "@/components/landing/hero-card-tilt";
import { CRISIS_DOORS, PAMPA } from "@/components/landing/landing-content";
import {
  TAP_FLIP_PX,
  displayRotateYFromYaw,
  faceFromYaw,
  groundEdgeFromYaw,
  opticPressFromPose,
  pitchFromDrag,
  springSettled,
  springTick,
  wrapDeg360,
  yawFromDrag,
  yawReleaseTarget,
} from "@/components/landing/landing-flip";
import { resolvePlayStoreUrl } from "@/lib/ui/play-store";
import { lostThirdPersonPhrase } from "@/lib/utils/format";
import googlePlayBadge from "@/public/landing/google-play-badge-es419.png";
import { CARNET_HOOK_TURN_IN_MS, CARNET_HOOK_TURN_OUT_MS } from "@dim/contract/credential";
import Image from "next/image";
import Link from "next/link";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

// Read once at module scope by LITERAL access so Next inlines the value into
// this client bundle; null keeps the badge a plain image.
const playStoreUrl = resolvePlayStoreUrl({
  NEXT_PUBLIC_PLAY_STORE_URL: process.env.NEXT_PUBLIC_PLAY_STORE_URL,
});
const LANDING_TILT_MAX_DEG = 8;

type LandingHeroProps = {
  /** Pre-rendered QR SVG markup (qrcode's toString({ type: "svg" })), or null
   *  when this deployment has no demo pet to point at. */
  qrSvg: string | null;
  /** Public credential URL the QR encodes, e.g. /p/DIM-XXXX-XXXX, or null. */
  publicHref: string | null;
  /** Token displayed on the credential (must match the QR target), or null. */
  publicToken: string | null;
};

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
 * The two halves of the hero card's flick. Numbers live in
 * `@dim/contract/credential` as CARNET_HOOK_* (beside the document turn, named
 * separately). Coupled to `app/landing.css` `.lp-hcard-slab[data-turn]`.
 * Timers fire just BEYOND each half so the face is not swapped while visible.
 */
const TURN_OUT_MS = CARNET_HOOK_TURN_OUT_MS;
const TURN_IN_MS = CARNET_HOOK_TURN_IN_MS;

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
 *  wrap (app/landing.css: hatch, paper shadow, band light). The tilt layer
 *  only writes `transform`. */
const PARALLAX_VARS = [
  "--lp-qr-x",
  "--lp-qr-y",
  "--lp-sec-x",
  "--lp-sec-y",
  "--lp-press",
  "--lp-emb-x",
  "--lp-emb-y",
] as const;

function clearParallaxVars(el: HTMLElement) {
  for (const name of PARALLAX_VARS) el.style.removeProperty(name);
}

function writeParallaxVars(el: HTMLElement, tilt: HeroTilt, max: number) {
  const { qr, pattern } = heroParallax(tilt, max);
  el.style.setProperty("--lp-qr-x", `${qr.x.toFixed(2)}px`);
  el.style.setProperty("--lp-qr-y", `${qr.y.toFixed(2)}px`);
  el.style.setProperty("--lp-sec-x", `${pattern.x.toFixed(2)}px`);
  el.style.setProperty("--lp-sec-y", `${pattern.y.toFixed(2)}px`);
  const press = heroPress(tilt, max);
  el.style.setProperty("--lp-press", press.mag.toFixed(3));
  const rest = press.mag < 0.02;
  el.style.setProperty("--lp-emb-x", rest ? "0px" : `${(press.rimX * 0.9).toFixed(2)}px`);
  el.style.setProperty("--lp-emb-y", rest ? "0.35px" : `${(press.rimY * 0.9).toFixed(2)}px`);
}

/**
 * Write one smoothed tilt onto the card, or clear it when flat. Lifted out of
 * the hover loop's frame callback (biome cognitive-complexity ceiling); the
 * loop decides WHAT the tilt is, this paints it.
 */
function paintHeroTilt(wrap: HTMLElement, tilt: HTMLElement, current: HeroTilt) {
  // A drag writes --lp-press from the card's own yaw/pitch. The hover loop
  // must not paint over it, or the portrait seal stays dark for the whole
  // gesture.
  const dragOwnsOptics = wrap.dataset.turning === "true";
  if (current.rx === 0 && current.ry === 0) {
    tilt.style.transform = "";
    tilt.style.transformOrigin = "";
    tilt.style.willChange = "";
    if (!dragOwnsOptics) clearParallaxVars(wrap);
    return;
  }
  const pivot = heroPivot(current, LANDING_TILT_MAX_DEG);
  const press = heroPress(current, LANDING_TILT_MAX_DEG);
  tilt.style.willChange = "transform";
  tilt.style.transformOrigin = `${pivot.x.toFixed(1)}% ${pivot.y.toFixed(1)}%`;
  tilt.style.transform = `translateZ(${(-press.sinkPx).toFixed(2)}px) rotateX(${current.rx.toFixed(3)}deg) rotateY(${current.ry.toFixed(3)}deg) scale(${press.scale.toFixed(4)})`;
  if (!dragOwnsOptics) writeParallaxVars(wrap, current, LANDING_TILT_MAX_DEG);
}

/** Snapshot the in-flight peek/float, then ease to rest so a turn does not jump. */
function settleHeroMotion(wrap: HTMLElement) {
  const floatEl = wrap.querySelector<HTMLElement>(".lp-hcard-float");
  const ground = wrap.querySelector<HTMLElement>(".lp-hcard-ground");
  for (const el of [floatEl, ground]) {
    if (!el) continue;
    const cs = getComputedStyle(el);
    el.style.animation = "none";
    el.style.rotate = cs.rotate;
    el.style.translate = cs.translate;
    el.style.transform = cs.transform;
    el.style.opacity = cs.opacity;
    void el.getBoundingClientRect();
    el.style.rotate = "none";
    el.style.translate = "none";
    el.style.transform = "none";
    el.style.opacity = "";
  }
}

/** Static hero copy — isolated so a face/state change does not rebuild doors. */
const LandingHeroCopy = memo(function LandingHeroCopy() {
  return (
    <div className="lp-hero-copy">
      <h1 className="lp-display lp-h-hero lp-reveal" data-d="1">
        Toda una vida,
        <br />
        en una sola libreta.
      </h1>
      <p className="lp-lead lp-reveal" data-d="2">
        La libreta de tu mascota en el teléfono, con un QR que cualquiera puede escanear si se
        pierde.
      </p>
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
      <div className="lp-hero-badge lp-reveal" data-d="3">
        {playStoreUrl ? (
          <a href={playStoreUrl} rel="noopener">
            <Image src={googlePlayBadge} alt="Disponible en Google Play" width={646} height={250} />
          </a>
        ) : (
          <Image src={googlePlayBadge} alt="Disponible en Google Play" width={646} height={250} />
        )}
      </div>
      <p className="lp-hero-kill lp-reveal" data-d="4">
        <b>Gratis para siempre.</b> Sin papeleo. Estadísticas abiertas y anónimas.
      </p>
    </div>
  );
});

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
  // Wakes the tilt loop. A flip freezes the live lean (frozenLeanRef) so the
  // card stays in the same 3D space while it turns — it does not snap flat.
  const wakeTiltRef = useRef<(() => void) | null>(null);
  const frozenLeanRef = useRef<HeroTilt | null>(null);
  const tiltNowRef = useRef<HeroTilt>(FLAT);
  const faceRef = useRef<"front" | "back">("front");
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
    return () => {
      for (const t of flipTimersRef.current) clearTimeout(t);
    };
  }, []);

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
    };
  }, [stopCycle]);

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
      const frozen = frozenLeanRef.current;
      if (frozen) {
        target = frozen;
      } else if (pointer) {
        const box = wrap.getBoundingClientRect();
        target = tiltTowardPointer(
          pointer.x - box.left,
          pointer.y - box.top,
          box.width,
          box.height,
          LANDING_TILT_MAX_DEG,
        );
      }
      current = smoothTilt(current, target, dt);
      const settled =
        Math.abs(current.rx - target.rx) < 0.02 && Math.abs(current.ry - target.ry) < 0.02;
      if (settled) current = target;
      tiltNowRef.current = current;
      paintHeroTilt(wrap, tilt, current);
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
      tilt.style.transformOrigin = "";
      tilt.style.willChange = "";
      clearParallaxVars(wrap);
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

  // Half-turn: accelerate into the edge (data-turn="out"), swap the face at the
  // invisible edge, land from the far edge with a little overshoot
  // (data-turn="in"). Front → back turns one way, back → front the other, the
  // way a hand turns a card over and back. Icon-only trigger; both faces carry
  // one. Instant swap under reduced motion. The live pointer lean is FROZEN
  // for the whole gesture so the object never leaves the 3D pose it already
  // had — Y rotation is added on the slab, not after flattening the tilt.
  const flip = useCallback(() => {
    if (flippingRef.current) return;
    flippingRef.current = true;
    stopCycle();
    const el = slabRef.current;
    const wrap = wrapRef.current;
    // A tap during the first-sight hint would add the hint's 18° to the turn
    // and show the reverse mirrored for a few frames: the hint ends here.
    if (wrap) {
      wrap.dataset.hintDone = "true";
      settleHeroMotion(wrap);
      wrap.dataset.turning = "true";
    }
    frozenLeanRef.current = { ...tiltNowRef.current };
    const swap = () => {
      const refocus = !!el && el.contains(document.activeElement);
      faceRef.current = faceRef.current === "front" ? "back" : "front";
      flushSync(() => {
        setFace(faceRef.current);
        setAnnouncement(
          faceRef.current === "back"
            ? "Mostrando la libreta sanitaria."
            : "Mostrando la credencial.",
        );
      });
      if (refocus) {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const next = Array.from(
              el?.querySelectorAll<HTMLButtonElement>(".lp-hcard-flip") ?? [],
            ).find((b) => getComputedStyle(b).visibility !== "hidden");
            next?.focus();
          }),
        );
      }
    };
    if (!el || prefersReducedMotion()) {
      swap();
      flippingRef.current = false;
      frozenLeanRef.current = null;
      if (wrap) {
        delete wrap.dataset.turning;
        wrap.style.removeProperty("--lp-edge");
      }
      return;
    }
    wakeTiltRef.current?.();
    el.dataset.dir = faceRef.current === "front" ? "fwd" : "rev";
    el.dataset.turn = "out";
    let swapped = false;
    let finished = false;
    let edgeRaf = 0;
    const writeEdge = (edge: number) => {
      wrap?.style.setProperty("--lp-edge", edge.toFixed(3));
    };
    const animateEdge = (from: number, to: number, ms: number) => {
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / ms);
        writeEdge(from + (to - from) * t);
        if (t < 1) edgeRaf = window.requestAnimationFrame(step);
      };
      if (edgeRaf !== 0) window.cancelAnimationFrame(edgeRaf);
      edgeRaf = window.requestAnimationFrame(step);
    };
    writeEdge(0);
    animateEdge(0, 1, TURN_OUT_MS);
    const swapOnce = () => {
      if (swapped) return;
      swapped = true;
      swap();
      el.dataset.turn = "in";
      animateEdge(1, 0, TURN_IN_MS);
    };
    const finishOnce = () => {
      if (finished) return;
      finished = true;
      if (edgeRaf !== 0) window.cancelAnimationFrame(edgeRaf);
      delete el.dataset.turn;
      flippingRef.current = false;
      frozenLeanRef.current = null;
      if (wrap) {
        delete wrap.dataset.turning;
        wrap.style.removeProperty("--lp-edge");
      }
      wakeTiltRef.current?.();
    };
    const onAnimEnd = (e: AnimationEvent) => {
      if (e.target !== el) return;
      if (e.animationName === "lp-hcard-turn-out") swapOnce();
      if (e.animationName === "lp-hcard-turn-in") finishOnce();
    };
    el.addEventListener("animationend", onAnimEnd);
    const t1 = setTimeout(swapOnce, TURN_OUT_MS + 10);
    const t2 = setTimeout(
      () => {
        el.removeEventListener("animationend", onAnimEnd);
        finishOnce();
      },
      TURN_OUT_MS + TURN_IN_MS + 40,
    );
    flipTimersRef.current.push(t1, t2);
  }, [stopCycle]);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const wrap = wrapRef.current;
    const slab = slabRef.current;
    if (!wrap || !slab) return;

    let dragging = false;
    let tapArmed = false;
    let startX = 0;
    let startY = 0;
    let startYaw = 0;
    let yaw = 0;
    let pitch = 0;
    let pointerId = -1;
    let cardWidth = wrap.getBoundingClientRect().width;
    let cardHeight = wrap.getBoundingClientRect().height;
    let lastYaw = 0;
    let lastT = 0;
    let yawPerMs = 0;
    let springFrame = 0;

    const announceFace = (next: "front" | "back") => {
      flushSync(() => {
        setFace(next);
        setAnnouncement(
          next === "back" ? "Mostrando la libreta sanitaria." : "Mostrando la credencial.",
        );
      });
    };

    const paint = (nextYaw: number, nextPitch: number) => {
      const now = performance.now();
      if (lastT !== 0) {
        const dt = now - lastT;
        if (dt > 0) yawPerMs = (nextYaw - lastYaw) / dt;
      }
      lastYaw = nextYaw;
      lastT = now;
      yaw = nextYaw;
      pitch = nextPitch;
      slab.style.transform = `rotateX(${nextPitch.toFixed(2)}deg) rotateY(${displayRotateYFromYaw(nextYaw).toFixed(2)}deg)`;
      wrap.style.setProperty("--lp-flip-p", (wrapDeg360(nextYaw) / 180).toFixed(3));
      wrap.style.setProperty("--lp-edge", groundEdgeFromYaw(nextYaw).toFixed(3));
      const optic = opticPressFromPose(nextYaw, nextPitch);
      wrap.style.setProperty("--lp-press", optic.toFixed(3));
      const shownYaw = displayRotateYFromYaw(nextYaw);
      wrap.style.setProperty(
        "--lp-emb-x",
        `${(Math.sin((shownYaw * Math.PI) / 180) * 0.9).toFixed(2)}px`,
      );
      wrap.style.setProperty(
        "--lp-emb-y",
        optic < 0.02 ? "0.35px" : `${(Math.sin((nextPitch * Math.PI) / 180) * 0.9).toFixed(2)}px`,
      );
      const next = faceFromYaw(nextYaw);
      if (faceRef.current !== next) {
        const refocus = slab.contains(document.activeElement);
        faceRef.current = next;
        announceFace(next);
        if (refocus) {
          requestAnimationFrame(() => {
            const btn = Array.from(slab.querySelectorAll<HTMLButtonElement>(".lp-hcard-flip")).find(
              (b) => getComputedStyle(b).visibility !== "hidden",
            );
            btn?.focus();
          });
        }
      }
    };

    const stopSpring = () => {
      if (springFrame !== 0) {
        window.cancelAnimationFrame(springFrame);
        springFrame = 0;
      }
    };

    const finishDrag = () => {
      stopSpring();
      slab.style.transform = "";
      wrap.style.removeProperty("--lp-flip-p");
      wrap.style.removeProperty("--lp-edge");
      flippingRef.current = false;
      frozenLeanRef.current = null;
      delete wrap.dataset.turning;
      wakeTiltRef.current?.();
    };

    const springHome = (destYaw: number) => {
      stopSpring();
      let y = yaw;
      let p = pitch;
      let yVel = yawPerMs * 1000;
      let pVel = 0;
      let last = performance.now();
      const step = (now: number) => {
        const dt = now - last;
        last = now;
        const yNext = springTick(y, yVel, destYaw, dt);
        const pNext = springTick(p, pVel, 0, dt);
        y = yNext.pos;
        yVel = yNext.vel;
        p = pNext.pos;
        pVel = pNext.vel;
        paint(y, p);
        if (springSettled(y, yVel, destYaw) && springSettled(p, pVel, 0)) {
          paint(destYaw, 0);
          finishDrag();
          return;
        }
        springFrame = window.requestAnimationFrame(step);
      };
      springFrame = window.requestAnimationFrame(step);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (flippingRef.current) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest("button, a")) return;
      startX = e.clientX;
      startY = e.clientY;
      pointerId = e.pointerId;
      const canDrag = e.pointerType !== "touch" && hasFinePointer();
      if (!canDrag) {
        tapArmed = true;
        return;
      }
      stopCycle();
      wrap.dataset.hintDone = "true";
      settleHeroMotion(wrap);
      flippingRef.current = true;
      frozenLeanRef.current = { ...tiltNowRef.current };
      wrap.dataset.turning = "true";
      wakeTiltRef.current?.();
      dragging = true;
      const box = wrap.getBoundingClientRect();
      cardWidth = box.width;
      cardHeight = box.height;
      startYaw = faceRef.current === "back" ? 180 : 0;
      yaw = startYaw;
      pitch = 0;
      lastYaw = startYaw;
      lastT = 0;
      yawPerMs = 0;
      paint(startYaw, 0);
      wrap.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return;
      paint(
        yawFromDrag(startYaw, e.clientX - startX, cardWidth),
        pitchFromDrag(e.clientY - startY, cardHeight),
      );
    };

    const release = (e: PointerEvent, commit: boolean) => {
      if (pointerId < 0 || e.pointerId !== pointerId) return;
      pointerId = -1;
      if (dragging) {
        dragging = false;
        const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
        if (dist < TAP_FLIP_PX) {
          finishDrag();
          if (commit) flip();
          return;
        }
        springHome(yawReleaseTarget(yaw, yawPerMs));
        return;
      }
      if (!tapArmed) return;
      tapArmed = false;
      if (!commit) return;
      const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
      if (dist < TAP_FLIP_PX) flip();
    };

    const onUp = (e: PointerEvent) => release(e, true);
    const onAbort = (e: PointerEvent) => release(e, false);

    wrap.addEventListener("pointerdown", onDown);
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerup", onUp);
    wrap.addEventListener("pointercancel", onAbort);
    wrap.addEventListener("lostpointercapture", onAbort);
    return () => {
      stopSpring();
      wrap.removeEventListener("pointerdown", onDown);
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerup", onUp);
      wrap.removeEventListener("pointercancel", onAbort);
      wrap.removeEventListener("lostpointercapture", onAbort);
    };
  }, [stopCycle, flip]);

  const state = HERO_STATES[index] ?? HERO_STATES[0];
  const word = stateWord(state.key, state.badge);
  // A scannable QR needs BOTH the markup and a target that resolves; app/page.tsx
  // only supplies them together. Anything less renders the inert glyph.
  const scannable = qrSvg !== null && publicHref !== null;
  const slots = buildLandingCarnetSlots({
    face,
    publicToken,
    publicHref,
    heroStateKey: state.key,
    contextWord: word,
    contextRow: state.row,
  });
  const photoAlt =
    state.tone === "lost"
      ? `${PAMPA.name}, ${lostThirdPersonPhrase(PAMPA.sexEnum)}`
      : `${PAMPA.name}, ${PAMPA.speciesNoun}`;

  return (
    <section className="lp-section lp-section--paper lp-hero" id="top" data-section="landing-hero">
      <div className="lp-wrap-wide">
        <div className="lp-hero-grid">
          {/* Copy first in the DOM (critique 2026-09-29, C3). Isolated so
              a face/state change does not rebuild doors or the Play badge. */}
          <LandingHeroCopy />

          <div className="lp-hero-photo lp-reveal" data-d="2">
            <div className="flex w-full flex-col items-center">
              <div className="lp-hcardwrap" ref={wrapRef} data-alive={alive ? "true" : undefined}>
                {/* The paper shadow: 7pm-warm, same key as the laminate
                    catch. It breathes with the float (CSS only). */}
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
                      <section
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
                        <CredentialCarnetFaces
                          slots={slots}
                          qrSvg={qrSvg}
                          photoAlt={photoAlt}
                          onFlip={flip}
                          contextKey={index}
                        />
                      </section>
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
                {face === "back"
                  ? "Girala para volver a la credencial"
                  : scannable
                    ? `Escanealo para ver más sobre ${PAMPA.name}`
                    : "Cada mascota registrada tiene su credencial pública con QR"}
              </p>

              {/* Exclusive owner-state picker. Not a fieldset: the dots are
                  visual radio-like controls; fieldset would restyle the row. */}
              {/* biome-ignore lint/a11y/useSemanticElements: visual dots, not a form fieldset */}
              <div className="lp-hdots" role="group" aria-label="Estados de la credencial">
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
