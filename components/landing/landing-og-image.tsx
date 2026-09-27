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
// THE MARK IS THE FILE, NOT A LOOK-ALIKE. The path below is copied from
// public/logo-mimar-mark.svg (round 3, "chaflán 10, pata +6%": a QR finder
// pattern with a 10-unit chamfer holding an organic paw pad). satori cannot
// fetch a relative /public URL while rendering, so the geometry is inlined;
// if that file's drawing changes, change it here.
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
      <path
        fill={AZUL}
        fillRule="evenodd"
        d="M15 5H85L95 15V85L85 95H15L5 85V15ZM20.8 19H79.2L81 20.8V79.2L79.2 81H20.8L19 79.2V20.8ZM42 30.92C43.58 30.68 45.31 31.1 46.56 32.38C47.8 33.67 48.55 35.81 48.67 37.92C48.78 40.03 48.26 42.09 47.38 43.66C46.5 45.23 45.27 46.29 43.91 46.49C42.55 46.68 41.08 45.99 39.81 44.67C38.54 43.35 37.49 41.39 37.15 39.33C36.81 37.28 37.18 35.13 38.08 33.6C38.99 32.08 40.42 31.17 42 30.92ZM57.98 30.06C59.59 30.31 61.05 31.43 61.88 33.09C62.71 34.75 62.91 36.96 62.47 38.98C62.03 41.01 60.95 42.85 59.66 44.18C58.37 45.51 56.86 46.32 55.43 46.15C54.01 45.98 52.65 44.83 51.85 43.15C51.06 41.48 50.82 39.28 51.08 37.18C51.34 35.08 52.1 33.08 53.36 31.76C54.62 30.45 56.37 29.82 57.98 30.06ZM27.7 40.36C28.81 39.46 30.45 39.09 31.98 39.61C33.52 40.12 34.96 41.5 35.95 43.11C36.93 44.71 37.46 46.53 37.48 48.12C37.49 49.7 36.99 51.06 36.02 51.81C35.06 52.56 33.62 52.71 32.06 52.21C30.5 51.71 28.82 50.56 27.68 49.11C26.55 47.66 25.97 45.89 25.98 44.3C25.99 42.7 26.59 41.26 27.7 40.36ZM71.69 39.8C72.9 40.59 73.8 41.87 73.93 43.48C74.07 45.09 73.44 47.04 72.32 48.56C71.19 50.08 69.57 51.18 68.02 51.75C66.47 52.32 65.01 52.36 63.96 51.7C62.91 51.04 62.28 49.68 62.18 48.04C62.08 46.4 62.52 44.47 63.47 42.81C64.42 41.16 65.9 39.77 67.41 39.24C68.92 38.7 70.47 39.01 71.69 39.8ZM50.23 47.71C52.56 47.72 54.9 48.39 57.06 49.51C59.22 50.63 61.19 52.19 62.71 54.07C64.23 55.94 65.3 58.13 65.64 60.22C65.97 62.3 65.58 64.29 64.47 65.83C63.36 67.37 61.54 68.47 59.1 68.48C56.67 68.5 53.6 67.45 50.43 67.42C47.25 67.4 43.96 68.4 41.36 68.38C38.76 68.36 36.84 67.31 35.7 65.73C34.55 64.15 34.18 62.04 34.53 59.9C34.88 57.75 35.97 55.57 37.55 53.75C39.13 51.93 41.21 50.46 43.4 49.4C45.6 48.35 47.9 47.7 50.23 47.71Z"
      />
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
