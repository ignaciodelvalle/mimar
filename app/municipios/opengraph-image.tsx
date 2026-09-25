// Share card for /municipios — the same drawing as the landing's
// (components/landing/landing-og-image.tsx), captioned with this page's own
// headline and kicker so a link sent to a Zoonosis office previews as the page
// it opens.

import { LANDING_OG_SIZE, renderLandingOgImage } from "@/components/landing/landing-og-image";

export const size = LANDING_OG_SIZE;
export const contentType = "image/png";
export const alt =
  "miMAR para municipios y provincias. La sanidad animal de tu territorio, en un solo tablero.";

export default function Image() {
  return renderLandingOgImage({
    // The page's h1 and kicker (app/municipios/page.tsx).
    headline: "La sanidad animal de tu territorio, en un solo tablero.",
    sub: "Para oficinas de Zoonosis y bienestar animal.",
  });
}
