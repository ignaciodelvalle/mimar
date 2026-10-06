"use client";

// Public /p/ carnet turn — the landing flick (out to the edge, swap, in
// with a hair of overshoot), not the owner FlipCard and not the hero tilt.
// Both faces stay mounted so the h1 and the streamed back keep their place.
// Reduced motion swaps instantly.

import { CARNET_HOOK_TURN_IN_MS, CARNET_HOOK_TURN_OUT_MS } from "@dim/contract/credential";
import { type ReactNode, useRef, useState } from "react";

import { CardTurnButton } from "./CardTurnButton";
import { PublicCredentialBrandMark } from "./PublicCredentialBrandMark";
import { PublicDocumentBand } from "./PublicDocumentBand";

const EDGES = [1, 2, 3, 4, 5] as const;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function PublicCarnetTurn({
  subtitleFront,
  subtitleBack,
  front,
  back,
}: {
  subtitleFront: string;
  subtitleBack: string;
  front: ReactNode;
  back: ReactNode;
}) {
  const [face, setFace] = useState<"front" | "back">("front");
  const [turn, setTurn] = useState<"out" | "in" | null>(null);
  const [dir, setDir] = useState<"fwd" | "rev">("fwd");
  const run = useRef(0);
  const isBack = face === "back";

  function flip() {
    if (turn) return;
    if (reducedMotion()) {
      setFace(isBack ? "front" : "back");
      return;
    }
    const ticket = ++run.current;
    const next = isBack ? "front" : "back";
    setDir(isBack ? "rev" : "fwd");
    setTurn("out");
    window.setTimeout(() => {
      if (run.current !== ticket) return;
      setFace(next);
      setTurn("in");
      window.setTimeout(() => {
        if (run.current !== ticket) return;
        setTurn(null);
      }, CARNET_HOOK_TURN_IN_MS);
    }, CARNET_HOOK_TURN_OUT_MS);
  }

  const turnAria = isBack ? "Volver a la credencial" : "Girar credencial";
  const flipButton = (
    <CardTurnButton
      skin="pc-band-flip"
      label={turnAria}
      title={turnAria}
      pressed={isBack}
      disabled={turn !== null}
      onClick={flip}
    >
      {isBack ? "↺" : "↻"}
    </CardTurnButton>
  );
  const brandButton = (
    <CardTurnButton
      skin="pc-band-mark-hit"
      label={isBack ? "Marca miMAR: volver a la credencial" : "Marca miMAR: girar la credencial"}
      title={turnAria}
      disabled={turn !== null}
      onClick={flip}
    >
      <PublicCredentialBrandMark />
    </CardTurnButton>
  );

  return (
    <div className="pc-turn" data-face={face} data-turning={turn ? "true" : undefined}>
      <div className="pc-slab" data-turn={turn ?? undefined} data-dir={dir}>
        {EDGES.map((n) => (
          <span key={n} className="pc-edge" aria-hidden="true" />
        ))}
        <PublicDocumentBand
          subtitle={isBack ? subtitleBack : subtitleFront}
          brand={brandButton}
          flip={flipButton}
        />
        <div className="pc-faces">
          <div className="pc-turn-front" inert={isBack} aria-hidden={isBack}>
            {front}
          </div>
          <div className="pc-turn-back" inert={!isBack} aria-hidden={!isBack}>
            {back}
          </div>
        </div>
      </div>
    </div>
  );
}
