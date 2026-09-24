"use client";

// FlipCard — the pet profile's two-sided credential ("Una sola libreta").
// PRESENTATION ONLY: `activeFace` comes from the caller (PetDetailTabsPanel,
// which owns the ?tab= sync + tablist wiring) and `onFlip` toggles it.
//
// SINGLE PAINTED FACE (paint-bug fix). The two faces are BOTH mounted (so the
// face a11y wiring + the eager Libreta fetch stay intact), but only the
// active one is painted — the inactive face is `display:none`. There is NO
// preserve-3d / backface-visibility stacking: two faces painting inside a
// 3D context failed to COMPOSITE in Chromium with the credential's tall,
// complex content (band + z-index frame + QR SVG) and rendered the whole
// credential as an empty frame. One painted face in normal flow cannot hit
// that bug, and it is exactly the mockup's mechanic (a single visible face
// that swaps at edge-on).
//
// THE TURN (mockup §Interactions). On an activeFace change we turn the sheet
// edge-on, swap which face is shown at the invisible edge, then turn back:
//   rotateY(0 → 87°) ease-in .2s  →  swap shown face + jump to -87° (no anim)
//   →  rotateY(-87° → 0°) ease-out .26s   (~485ms, `turningRef` re-entrancy
//   guard; if activeFace changed again mid-turn it reconciles on completion).
// Reduced motion: instant swap, no rotation (read at turn time — never during
// render — so the initial tree stays hydration-deterministic).
//
// Height needs no ResizeObserver anymore: the one painted face lives in normal
// flow, so the container auto-sizes to it (and to the Libreta face growing from
// its loading skeleton to real content).

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type ChromeSituation, DocumentChrome } from "./DocumentChrome";

export type FlipCardFace = "credencial" | "libreta";

// Stable face ids — PetDetailTabsPanel moves focus onto the newly-shown face
// after a user-initiated flip (single-flip-control a11y: the band turn button
// is the only switcher, so the reader must land on the content that appeared).
export const PET_FACE_PANEL_ID: Record<FlipCardFace, string> = {
  credencial: "pet-face-credencial",
  libreta: "pet-face-libreta",
};

// Accessible face names (es-AR UI copy) — the faces are labelled <section>
// regions now, not tabpanels: the tablist was removed (tarjeta-todo,
// re-affirming PO decision #645) and a tabpanel without tabs is broken ARIA.
// A named region also makes the back face discoverable from the screen-reader
// landmark/region list even before the first flip.
const PET_FACE_LABEL: Record<FlipCardFace, string> = {
  credencial: "Credencial · frente del documento",
  libreta: "Libreta · dorso del documento",
};

type FlipCardProps = {
  front: ReactNode;
  back: ReactNode;
  activeFace: FlipCardFace;
  /** Toggles the face — wired by the caller (PetDetailTabsPanel.switchFace) to its ?tab= write. */
  onFlip: () => void;
  /**
   * Fired the moment a face becomes the PAINTED one — i.e. after the turn's
   * edge-on swap, not when `activeFace` was requested.
   *
   * This exists because focus cannot be moved any earlier. The inactive face is
   * `display:none`, and `HTMLElement.focus()` on a display:none element is a
   * silent no-op in a real browser. A caller focusing on the `activeFace`
   * change lands ~205ms before the swap and loses the focus into <body> — which
   * is exactly what a keyboard user experiences as "the card flipped and I lost
   * my place". jsdom does not enforce the display rule, so a unit test asserting
   * document.activeElement passes while the browser does the opposite.
   */
  onFaceShown?: (face: FlipCardFace) => void;
  /** Pet situation for the chrome band — threaded to BOTH DocumentChrome faces
   *  so flipping the card never loses the state (pet-state-header). */
  situation?: ChromeSituation | null;
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function FlipCard({
  front,
  back,
  activeFace,
  onFlip,
  onFaceShown,
  situation,
}: FlipCardProps) {
  // `displayedFace` lags `activeFace` during the turn — it swaps at the edge-on
  // midpoint so the content change is invisible. Initialised to activeFace so
  // the FIRST render (server + client hydration) is identical and deterministic.
  const [displayedFace, setDisplayedFace] = useState<FlipCardFace>(activeFace);
  const displayedRef = useRef<FlipCardFace>(activeFace);
  const activeRef = useRef<FlipCardFace>(activeFace);
  const turningRef = useRef(false);
  const turnElRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Kept in a ref so `commit` (and therefore `maybeTurn`) does not change
  // identity when the caller passes a fresh closure each render.
  const onFaceShownRef = useRef(onFaceShown);
  onFaceShownRef.current = onFaceShown;

  const commit = useCallback((face: FlipCardFace) => {
    displayedRef.current = face;
    setDisplayedFace(face);
  }, []);

  // Announce the shown face from an EFFECT, not from `commit`. The listener
  // focuses the face, and focus only takes on an element the browser has
  // actually laid out — an announcement fired inside commit (or in a
  // microtask after it) still runs before React has committed the DOM, so the
  // target is `display:none` and .focus() is a silent no-op. Skips the first
  // run: the initial face is not something the user flipped to, and stealing
  // focus on page load would be its own defect.
  const announcedRef = useRef(false);
  useEffect(() => {
    if (!announcedRef.current) {
      announcedRef.current = true;
      return;
    }
    onFaceShownRef.current?.(displayedFace);
  }, [displayedFace]);

  const maybeTurn = useCallback(() => {
    if (turningRef.current) return;
    const target = activeRef.current;
    if (target === displayedRef.current) return;

    const el = turnElRef.current;
    if (!el || prefersReducedMotion()) {
      commit(target);
      // Reduced motion / no node: reconcile again in case activeFace advanced.
      if (activeRef.current !== target) queueMicrotask(maybeTurn);
      return;
    }

    turningRef.current = true;
    // Phase 1: turn the sheet edge-on.
    el.style.transition = "transform 0.2s ease-in";
    el.style.transform = "rotateY(87deg)";
    timersRef.current.push(
      setTimeout(() => {
        // At edge-on: swap the shown face (to the LATEST target) and jump to the
        // opposite edge without animating.
        commit(activeRef.current);
        el.style.transition = "none";
        el.style.transform = "rotateY(-87deg)";
        // Force reflow so the jump isn't coalesced with the turn-in below.
        void el.offsetWidth;
        // Phase 2: turn the new face in.
        el.style.transition = "transform 0.26s ease-out";
        el.style.transform = "rotateY(0deg)";
        timersRef.current.push(
          setTimeout(() => {
            turningRef.current = false;
            // Reconcile if activeFace changed again during the turn.
            maybeTurn();
          }, 280),
        );
      }, 205),
    );
  }, [commit]);

  // Run a turn whenever the requested face changes. Sync the ref here (rather
  // than during render) so `maybeTurn` and its reconcile timer always read the
  // latest target, and so `activeFace` is a genuine dependency of this effect.
  useEffect(() => {
    activeRef.current = activeFace;
    maybeTurn();
  }, [activeFace, maybeTurn]);

  // Clear any in-flight timers on unmount only (NOT on activeFace change — that
  // would cancel a turn mid-flight).
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, []);

  const isCredencialShown = displayedFace === "credencial";
  const isLibretaActive = activeFace === "libreta";

  return (
    <div data-section="flip-card" className="ln-doc-root">
      <div className="ln-doc-stage">
        <div className="ln-doc-wrap">
          <div ref={turnElRef} className="ln-doc-turn w-full">
            <section
              id={PET_FACE_PANEL_ID.credencial}
              aria-label={PET_FACE_LABEL.credencial}
              tabIndex={-1}
              data-section="flip-front"
              aria-hidden={!isCredencialShown}
              className={isCredencialShown ? "outline-none" : "hidden"}
            >
              <DocumentChrome
                face="credencial"
                onFlip={onFlip}
                isLibretaActive={isLibretaActive}
                situation={situation}
              >
                {front}
              </DocumentChrome>
            </section>
            <section
              id={PET_FACE_PANEL_ID.libreta}
              aria-label={PET_FACE_LABEL.libreta}
              tabIndex={-1}
              data-section="flip-back"
              aria-hidden={isCredencialShown}
              className={isCredencialShown ? "hidden" : "outline-none"}
            >
              <DocumentChrome
                face="libreta"
                onFlip={onFlip}
                isLibretaActive={isLibretaActive}
                situation={situation}
              >
                {back}
              </DocumentChrome>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
