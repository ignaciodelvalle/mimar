import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import { ErrorSinkBootstrap } from "@/components/ErrorSinkBootstrap";
import { Toaster } from "@/components/Toaster";
import { BRANDING } from "@/lib/ui/branding";

import "./globals.css";

// ---------- Encode Sans (gob.ar portals — the default --font-sans) ----------
// Loaded via next/font/local from committed .woff2 files (app/fonts/README.md
// has source, version, subset and license) — self-hosted by Next, served
// from /_next/static, same as before. Switched off next/font/google
// 2026-09-18 (L-21, dim-interno:docs/plans/PENDIENTES.md): that loader fetches from
// fonts.gstatic.com AT BUILD TIME, which took the CI "Lint, typecheck,
// build" job down whole on 2026-08-10 when Google didn't answer — unrelated
// to the commit under test. Vendoring removes the build-time network
// dependency; runtime self-hosting behavior is unchanged. Exposed as a CSS
// var wired to --font-sans in globals.css.
const encodeSans = localFont({
  src: [
    { path: "./fonts/encode-sans/encode-sans-v23-latin-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/encode-sans/encode-sans-v23-latin-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/encode-sans/encode-sans-v23-latin-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/encode-sans/encode-sans-v23-latin-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--encode-sans-font",
  display: "swap",
});

// ---------- Libreta Nacional typefaces (IBM Plex family + Caveat) ----------
// Exposed as CSS vars and wired into Tailwind @theme as --font-ln-* tokens.
// All loaded via next/font/local from committed .woff2 (app/fonts/README.md)
// — see the encodeSans comment above for why (L-21).

// Weight lists are a CONTRACT with the utility classes the app actually uses.
// A weight that is requested but not loaded does not fail — the browser silently
// falls back to the nearest loaded face (CSS Fonts 4 §5.2 matching), so
// `font-bold` on a serif element rendered 600 and `font-medium` on a mono
// element rendered 400. Nothing errors, nothing lints; only a computed-style
// read catches it. Before adding a weight utility to a font-ln-* element, check
// that the weight is in the list below. Guarded by
// __tests__/font-weight-contract.test.ts, which re-derives the requested set
// from the source and fails on any weight that is asked for but not loaded.

const ibmPlexSerif = localFont({
  src: [
    // 700: `font-bold` on font-ln-serif (LostCaseBlock's lost-pet initial, the
    // design-tokens page h1) used to render 600.
    {
      path: "./fonts/ibm-plex-serif/ibm-plex-serif-v20-latin-500.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "./fonts/ibm-plex-serif/ibm-plex-serif-v20-latin-600.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "./fonts/ibm-plex-serif/ibm-plex-serif-v20-latin-700.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--a-serif-font",
  display: "swap",
});

const ibmPlexSans = localFont({
  src: [
    {
      path: "./fonts/ibm-plex-sans/ibm-plex-sans-v23-latin-400.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/ibm-plex-sans/ibm-plex-sans-v23-latin-500.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "./fonts/ibm-plex-sans/ibm-plex-sans-v23-latin-600.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "./fonts/ibm-plex-sans/ibm-plex-sans-v23-latin-700.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--a-sans-font",
  display: "swap",
});

const ibmPlexMono = localFont({
  src: [
    // 500: `.lp-ch-num`, `.lp-lib-y`, `.ln-band-title` and SuccessScreen's mono
    // labels used to render 400 (CSS matching for 500 tries 400 before 600).
    // 700: the whole operator micro-type tier (OpStatusPill / OpPill /
    // OpScopeChip / OpCodeBadge / OpCrumbs, CaseQueue headers, `.ln-ledlbl`,
    // `.lp-hcard-badge`) used to render 600 — including comments that read
    // "9px bold" over text that was not bold.
    {
      path: "./fonts/ibm-plex-mono/ibm-plex-mono-v20-latin-400.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/ibm-plex-mono/ibm-plex-mono-v20-latin-500.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "./fonts/ibm-plex-mono/ibm-plex-mono-v20-latin-600.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "./fonts/ibm-plex-mono/ibm-plex-mono-v20-latin-700.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--a-mono-font",
  display: "swap",
});

const caveat = localFont({
  src: [
    { path: "./fonts/caveat/caveat-v23-latin-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/caveat/caveat-v23-latin-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--a-caveat-font",
  display: "swap",
});

const lnFontVars = [
  ibmPlexSerif.variable,
  ibmPlexSans.variable,
  ibmPlexMono.variable,
  caveat.variable,
].join(" ");

// --------------------------------------------------------------------------

// Single source of truth for the app's public origin (task #43 share-first
// lost flow). Same env var app/sitemap.ts and /p's generateMetadata resolve
// against — see dim-interno:docs/ops/production-deploy-plan.md "Site URL consistency".
// metadataBase only resolves relative metadata URLs (og:url, canonical
// links); it never touches the DB, so — unlike sitemap.ts's per-request
// resolveSiteUrl() — it's safe to read at module scope for every route's
// static metadata. Falls back to localhost for local dev/CI only; production
// must set NEXT_PUBLIC_SITE_URL.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Deployed build marker — Vercel injects VERCEL_GIT_COMMIT_SHA at build time.
// Rendered as a <meta> in every page's <head>, so the live commit is readable
// via view-source on ANY route WITHOUT touching the DB — it survives even when
// a data-heavy page degrades. "dev" locally/CI where the var is absent.
const APP_VERSION = (process.env.VERCEL_GIT_COMMIT_SHA ?? "dev").slice(0, 7);

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  other: { "mimar-version": APP_VERSION },
  title: `${BRANDING.appName} — ${BRANDING.appNameLong}`,
  description:
    "La libreta sanitaria digital de tu mascota. Para encontrarse, para cuidarse, para ayudarnos a cuidar a todas.",
  applicationName: BRANDING.appName,
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: BRANDING.appName,
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/icon-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // maximumScale intentionally omitted — disabling zoom violates WCAG 1.4.4 (Resize Text).
  // Ley 26.653 / Disp. ONTI 6/2019 mandates WCAG 2.1 AA for Argentine gov-adjacent systems.
  // cover: let the installed PWA draw into the notch / home-indicator areas;
  // the pt-safe/pb-safe utilities in globals.css pad content back out of them
  // (native-mobile audit 2026-07-04 §2).
  viewportFit: "cover",
  // Single value only (no dark variant): dark mode is explicitly disabled in this
  // redesign — the app is light-only (see "Dark mode desactivado" note in globals.css).
  // #0e5a99 matches app/manifest.ts theme_color and the navy masthead so the
  // status bar doesn't flash white over the chrome (audit §6).
  themeColor: "#0e5a99",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es-AR" className={`${encodeSans.variable} ${lnFontVars}`}>
      <body>
        {/* Skip-to-main — first focusable element; visible on keyboard focus (WCAG 2.4.1). */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[9999] focus:rounded focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-ln-azul focus:shadow-md focus:outline focus:outline-2 focus:outline-ln-azul"
        >
          Ir al contenido principal
        </a>
        {children}
        <Toaster />
        {/* Instala el transporte de errores del cliente. No dibuja nada; hasta
            que existió, una excepción en el navegador de alguien moría en su
            pestaña y no la veía nadie. */}
        <ErrorSinkBootstrap />
      </body>
    </html>
  );
}
