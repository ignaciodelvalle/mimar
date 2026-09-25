// The lost-pet poster as ONE self-contained HTML document — what the native
// app prints to PDF (`GET /api/v1/pets/{token}/poster`).
//
// THE SAME POSTER AS THE WEB'S, NOT A SECOND DESIGN. The web renders
// `app/(app)/mis-mascotas/[publicToken]/cartel/PosterPreview.tsx`, a client
// component with Tailwind classes and two interactive controls (the B&W toggle
// and a free-text box that never persists). A phone's print engine has
// neither Tailwind nor a React tree, so this file lays out the same blocks, in
// the same order, with the same words, from the same `LostPosterData` — and
// `__tests__/lost-poster-parity.test.ts` renders both and compares their text,
// so the two cannot drift into saying different things.
//
// WHAT IS NOT HERE, ON PURPOSE: the web's controls (print, B&W, back link),
// its pre-print "sin foto" warning (the app shows that on screen, from
// `hasPhoto`), and the free-text box — it is local to one browser tab and
// empty unless typed into, so an unedited web poster prints without it too.
//
// PURE. Every value is escaped on the way in; the only unescaped string is the
// QR SVG, which the server generated itself from the public credential URL.

import { LN_CSS_TOKENS } from "@dim/contract/tokens";

import { AR_TIME_ZONE, lastSeenHeadingLabel, lostPosterHeadline } from "@/lib/utils/format";

/**
 * Everything the poster shows, ALREADY FILTERED by the disclosure preferences.
 * `loadLostPoster` produces it; both renderers consume it.
 */
export type LostPosterData = {
  publicToken: string;
  petName: string;
  /** Display labels, not enums. */
  species: string;
  breed: string | null;
  sex: string;
  /** Raw sex enum — drives the PERDIDO/PERDIDA/SE BUSCA headline. */
  sexRaw: string | null;
  age: string | null;
  color: string | null;
  distinguishingFeatures: string | null;
  photoUrl: string | null;
  placeName: string | null;
  lastSeenAt: Date | null;
  /** Null = not disclosed (or unknown). */
  ownerFirstName: string | null;
  ownerPhone: string | null;
  locationDisclosed: boolean;
  /** Server-generated SVG of the QR to `/p/{publicToken}`. */
  qrSvg: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The date beside "Vista por última vez", in the web's exact format. */
export function lostPosterLastSeenLabel(lastSeenAt: Date | null): string | null {
  return lastSeenAt
    ? lastSeenAt.toLocaleDateString("es-AR", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: AR_TIME_ZONE,
      })
    : null;
}

const C = {
  seal: LN_CSS_TOKENS["--color-ln-seal"],
  ink: LN_CSS_TOKENS["--color-ln-ink"],
  ink2: LN_CSS_TOKENS["--color-ln-ink-2"],
  mute: LN_CSS_TOKENS["--color-ln-mute"],
  line: LN_CSS_TOKENS["--color-ln-line"],
  stripe: LN_CSS_TOKENS["--color-ln-stripe"],
};

const STYLE = `
@page { size: A4 portrait; margin: 1cm; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; background: #fff; }
body { font-family: "Helvetica Neue", Arial, sans-serif; color: ${C.ink}; }
main { padding: 0; }
main > * + * { margin-top: 12px; }
.headline { background: ${C.seal}; color: #fff; text-align: center; padding: 12px 0; border-radius: 4px; }
.headline p { margin: 0; font-size: 36px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase; }
.photo { display: flex; justify-content: center; }
.photo img, .photo .initial { width: 224px; height: 224px; border-radius: 16px; border: 4px solid ${C.seal}; object-fit: cover; }
.photo .initial { display: flex; align-items: center; justify-content: center; background: ${C.stripe}; color: ${C.mute}; font-size: 60px; font-weight: 700; }
h1 { margin: 0; text-align: center; font-size: 36px; font-weight: 900; letter-spacing: -0.01em; }
.identity { margin: 0; text-align: center; font-size: 16px; color: ${C.ink2}; }
.fact, .block p { margin: 0; font-size: 14px; }
.block p + p { margin-top: 2px; }
b { font-weight: 600; }
.qr { display: flex; flex-direction: column; align-items: center; gap: 8px; padding-top: 8px; }
.qr .code { width: 144px; height: 144px; padding: 4px; background: #fff; border: 1px solid ${C.line}; border-radius: 4px; }
.qr .code svg { width: 100%; height: 100%; }
.qr p { margin: 0; font-size: 12px; color: ${C.ink2}; }
footer { text-align: center; padding-top: 16px; border-top: 1px solid ${C.line}; }
footer p { margin: 0; font-size: 12px; color: ${C.mute}; text-transform: uppercase; letter-spacing: 0.1em; }
`;

/** The poster, as a complete HTML document for one A4 page. */
export function renderLostPosterHtml(data: LostPosterData): string {
  const e = escapeHtml;
  const identity = [data.species, data.breed, data.sex, data.age].filter(Boolean).join(" · ");
  const lastSeenLabel = lostPosterLastSeenLabel(data.lastSeenAt);
  const parts: string[] = [];

  parts.push(`<div class="headline"><p>${e(lostPosterHeadline(data.sexRaw))}</p></div>`);
  parts.push(
    data.photoUrl
      ? `<div class="photo"><img src="${e(data.photoUrl)}" alt="${e(data.petName)}"></div>`
      : `<div class="photo"><div class="initial">${e(data.petName.charAt(0).toUpperCase())}</div></div>`,
  );
  parts.push(`<h1>${e(data.petName)}</h1>`);
  if (identity) parts.push(`<p class="identity">${e(identity)}</p>`);
  if (data.color) parts.push(`<p class="fact"><b>Color:</b> ${e(data.color)}</p>`);
  if (data.distinguishingFeatures) {
    parts.push(`<p class="fact"><b>Señas:</b> ${e(data.distinguishingFeatures)}</p>`);
  }
  if (data.locationDisclosed && (data.placeName || lastSeenLabel)) {
    const rows: string[] = [];
    if (data.placeName) {
      rows.push(`<p><b>${e(lastSeenHeadingLabel(data.sexRaw))}:</b> ${e(data.placeName)}</p>`);
    }
    if (lastSeenLabel) rows.push(`<p><b>Fecha:</b> ${e(lastSeenLabel)}</p>`);
    parts.push(`<div class="block">${rows.join("")}</div>`);
  }
  if (data.ownerFirstName || data.ownerPhone) {
    const who = [data.ownerFirstName, data.ownerPhone].filter(Boolean).join(" · ");
    parts.push(`<div class="block"><p><b>Contacto:</b></p><p>${e(who)}</p></div>`);
  }
  parts.push(
    `<div class="qr"><div class="code">${data.qrSvg}</div><p>Escaneá para más info</p></div>`,
  );
  parts.push("<footer><p>miMAR · Documento de Identificación para Mascotas</p></footer>");

  return [
    "<!doctype html>",
    '<html lang="es-AR"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${e(lostPosterHeadline(data.sexRaw))} · ${e(data.petName)}</title>`,
    `<style>${STYLE}</style></head>`,
    `<body><main>${parts.join("")}</main></body></html>`,
  ].join("");
}
