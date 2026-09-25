// The share card for the landing family (`/` and `/municipios`), rendered by
// next/og from each route's `opengraph-image.tsx` file convention.
//
// ONE DRAWING, TWO CAPTIONS. Both routes share the brand frame — the guilloche
// stripe the public credential's own share card opens with
// (app/(public)/p/[publicToken]/opengraph-image.tsx), the real mark, the
// wordmark — and differ only in the two lines of copy, which each route passes
// in from text it already shows on the page. Nothing here is written for the
// card alone: a share preview that promises something the page does not say is
// the overclaim the honesty fences exist to stop.
//
// THE MARK IS THE FILE, NOT A LOOK-ALIKE. The paths below are copied from
// public/logo-mimar-mark.svg (a QR finder pattern with chamfered corners
// holding a paw). satori cannot fetch a relative /public URL while rendering,
// so the geometry is inlined; if that file's drawing changes, change it here.
//
// Literal hex, not CSS vars, for the same reason the credential card gives:
// satori has no CSSOM to resolve var(--color-ln-*) against. Each constant
// names the globals.css token it restates, and they live in named constants
// rather than inside style={{…}} so lint:tokens' hex-in-style ratchet stays
// at zero for this file.

import { ImageResponse } from "next/og";

export const LANDING_OG_SIZE = { width: 1200, height: 630 };

const INK = "#1b2a33"; // --color-ln-ink
const INK_2 = "#3c4b55"; // --color-ln-ink-2
const PAPER = "#fbfaf5"; // --color-ln-paper
const CARD = "#ffffff"; // --color-ln-card
const LINE = "#e4dfd3"; // --color-ln-line
const AZUL = "#0e5a99"; // --color-ln-azul
const AZUL_900 = "#0a3556"; // --color-ln-azul-900
const CELESTE = "#4e97d1"; // --color-ln-celeste

type LandingOgCopy = {
  /** The page's own headline, verbatim. */
  headline: string;
  /** One supporting line the page already shows. */
  sub: string;
};

function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="miMAR">
      <g fill={AZUL}>
        <path
          fillRule="evenodd"
          d="M26 5H74L95 26V74L74 95H26L5 74V26ZM31.8 19H68.2L81 31.8V68.2L68.2 81H31.8L19 68.2V31.8Z"
        />
        <g transform="translate(50 50) scale(0.5) translate(-50 -55)">
          <circle cx="20.5" cy="40" r="9.6" />
          <circle cx="39.5" cy="26.5" r="9.6" />
          <circle cx="60.5" cy="26.5" r="9.6" />
          <circle cx="79.5" cy="40" r="9.6" />
          <path d="M50 54C64.9 54 77 61.6 77 72C77 83.6 64.9 93 50 93C35.1 93 23 83.6 23 72C23 61.6 35.1 54 50 54Z" />
        </g>
      </g>
    </svg>
  );
}

export function renderLandingOgImage({ headline, sub }: LandingOgCopy): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: PAPER,
        fontFamily: "sans-serif",
      }}
    >
      {/* Guilloche stripe — the credential's own top band. */}
      <div
        style={{
          display: "flex",
          height: 16,
          width: "100%",
          background: `linear-gradient(90deg, ${AZUL_900}, ${AZUL} 55%, ${CELESTE})`,
        }}
      />

      <div
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 88px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <Mark size={92} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ display: "flex", fontSize: 52, fontWeight: 700, color: INK }}>
              miMAR
            </span>
            <span style={{ display: "flex", fontSize: 24, color: INK_2, marginTop: 2 }}>
              Mi Mascota Argentina
            </span>
          </div>
        </div>

        <span
          style={{
            display: "flex",
            marginTop: 54,
            fontSize: 64,
            fontWeight: 700,
            lineHeight: 1.08,
            letterSpacing: -1,
            color: INK,
            maxWidth: 980,
          }}
        >
          {headline}
        </span>
        <span
          style={{
            display: "flex",
            marginTop: 22,
            fontSize: 30,
            lineHeight: 1.35,
            color: INK_2,
            maxWidth: 940,
          }}
        >
          {sub}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "22px 88px",
          borderTop: `1px solid ${LINE}`,
          backgroundColor: CARD,
        }}
      >
        <span style={{ display: "flex", fontSize: 24, color: INK_2 }}>
          {/* The hero eyebrow, verbatim (state-endorsement fence pins it). */}
          Credencial digital · QR público verificable
        </span>
      </div>
    </div>,
    { ...LANDING_OG_SIZE },
  );
}
