// Share card for the landing (`/`). Next's file convention publishes it as
// og:image and twitter:image — see components/landing/landing-og-image.tsx for
// the drawing and why it only repeats copy the site already shows.
//
// SCOPE, AND WHY THE CAPTION IS THE SITE'S AND NOT THE HERO'S. A file at the
// app root is also the fallback for every route below it that declares no
// `openGraph` of its own (verified on the running build: /perdidas, /adoptar
// and /login all pick it up). That is intended — those links used to preview
// with no image at all — but it means this card must be true of ALL of them.
// So it carries the root layout's own description, the same text those routes
// already inherit as og:description, and not the hero headline. A route that
// sets `openGraph` replaces the inherited block wholesale (the adoption ficha,
// the shelter page), and a route with its own image file (/p/[publicToken],
// /municipios) wins outright.

import { LANDING_OG_SIZE, renderLandingOgImage } from "@/components/landing/landing-og-image";

export const size = LANDING_OG_SIZE;
export const contentType = "image/png";
export const alt = "miMAR — La libreta sanitaria digital de tu mascota.";

export default function Image() {
  return renderLandingOgImage({
    // The root layout's description (app/layout.tsx), split at its first stop.
    headline: "La libreta sanitaria digital de tu mascota.",
    sub: "Para encontrarse, para cuidarse, para ayudarnos a cuidar a todas.",
  });
}
