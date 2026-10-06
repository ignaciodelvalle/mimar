"use client";

// The landing carnet, still, for the showcase. No tilt and no auto-cycle:
// those belong to the hero. The faces are the same painter.

import { CredentialCarnetFaces } from "@/components/landing/CredentialCarnetFaces";
import { buildLandingCarnetSlots } from "@/components/landing/build-landing-carnet-slots";
import { PAMPA } from "@/components/landing/landing-content";
import { useState } from "react";

export function LandingSample({ qrSvg, href }: { qrSvg: string; href: string }) {
  const [face, setFace] = useState<"front" | "back">("front");
  const slots = buildLandingCarnetSlots({
    face,
    publicToken: "DIM-MUES-0001",
    publicHref: href,
    heroStateKey: "aldia",
    contextWord: "Al día",
    contextRow: "Vacunas firmadas",
  });

  return (
    <div className="lp">
      <section
        className="lp-hcard"
        data-section="hero-credential"
        data-tone="ok"
        data-face={face}
        aria-label={`Credencial de ${PAMPA.name}`}
      >
        <CredentialCarnetFaces
          slots={slots}
          qrSvg={qrSvg}
          photoAlt={`${PAMPA.name}, ${PAMPA.speciesNoun}`}
          onFlip={() => setFace((current) => (current === "front" ? "back" : "front"))}
          contextKey={0}
        />
      </section>
    </div>
  );
}
