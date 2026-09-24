import type { NextConfig } from "next";

// Derive the Supabase hostname from the env var so local dev (127.0.0.1)
// and any custom self-hosted instance are covered automatically.
//
// Parsed once, and never with a bare `new URL()`. An unvalidated env var here
// aborts the whole build with nothing but "TypeError: Invalid URL" — no
// variable name, no value, and Vercel masks the input as [SENSITIVE] — which
// is an hour of bisecting a config file to find a misconfigured secret. The
// throw below names the variable and shows only the scheme prefix, which for a
// NEXT_PUBLIC_ URL discloses nothing that is not already in the client bundle.
function parseSupabaseUrl(raw: string): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    throw new Error(
      `NEXT_PUBLIC_SUPABASE_URL is set but is not a valid absolute URL. Length ${raw.length}, begins ${JSON.stringify(raw.slice(0, 8))}. Expected something like https://<ref>.supabase.co — check for wrapping quotes, a trailing newline, or a missing scheme.`,
    );
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseParsed = parseSupabaseUrl(supabaseUrl);
const supabaseHostname = supabaseParsed?.hostname ?? "127.0.0.1";

// Shared by /denuncias/codigo/* and /denuncias/seguimiento/*. See the rationale
// at the `headers()` entries that use it.
const DENUNCIA_PRIVATE_HEADERS = [
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self)" },
        ],
      },
      {
        // Denuncia surfaces — the reference-code stub and the reporter view.
        //
        // A denuncia is an UNVERIFIED allegation of a crime that carries prison
        // (Ley 14.346 art. 1) about a person who has not been investigated yet.
        // Two headers, because page metadata alone was not enough:
        //
        //  • X-Robots-Tag. Before `app/robots.ts` landed (2026-08-22, closing
        //    report M8 / fix queue row 17), there was no robots.txt in this
        //    repo, so a leaked denuncia URL had nothing telling a crawler to
        //    stay away. `app/robots.ts` now disallows `/denuncias/codigo` and
        //    `/denuncias/seguimiento`, but that only stops a well-behaved
        //    crawler from REQUESTING the URL in the first place — this header
        //    (unlike `export const metadata.robots`) still earns its place
        //    because it also covers the 303 from /seguimiento/entrar and any
        //    non-HTML response on the subtree, neither of which a disallow
        //    line alone reaches.
        //  • Referrer-Policy: no-referrer. The global policy is
        //    strict-origin-when-cross-origin, which already keeps the DEN code
        //    out of cross-origin referrers — but it still sends the FULL URL
        //    same-origin, and /seguimiento/entrar briefly holds a live access
        //    token in its query string. `no-referrer` means that URL is never
        //    quoted to anybody, including us.
        //
        // Scoped to these two paths on purpose: /denuncias and /denuncias/nueva
        // are the intake funnel and SHOULD be findable — a person searching for
        // how to report cruelty needs to land on the form.
        source: "/denuncias/codigo/:path*",
        headers: DENUNCIA_PRIVATE_HEADERS,
      },
      {
        source: "/denuncias/seguimiento/:path*",
        headers: DENUNCIA_PRIVATE_HEADERS,
      },
      {
        // Public credential — INDEXABLE, NOT ARCHIVABLE.
        //
        // A lost pet's credential renders the owner's first name, phone (with a
        // live `tel:` link) and last known location, and it is meant to be
        // found: /perdidas sits in the site-wide footer linking to every one of
        // them, and app/sitemap.ts feeds them daily at priority 0.85. That is a
        // deliberate, reviewed decision (PII audit 2026-07-04 — "expected for
        // reunification SEO"), so `noindex` here would be the wrong fix.
        //
        // The problem is what happens AFTER the dog comes home. The owner flips
        // the disclosure toggles off, the live page changes instantly — and the
        // search snippet and the archived copy keep the phone number, until the
        // next crawl or forever. `no-store` does not help: it is a CACHE
        // directive, and Google honours `noarchive` / `nosnippet` for this.
        //
        //  • noarchive  — no "cached" copy served from the index.
        //  • nosnippet  — no text excerpt in the results page, which is exactly
        //    where "Lo busca Juan · Av. Rivadavia 1234 · +54 9 11 …" would sit.
        //
        // Cost, stated honestly: a result with no snippet converts worse. The
        // trade is that turning a toggle off actually turns it off, and the live
        // page stays the only copy. The owner is told this next to the toggles
        // (LostDisclosureCard) and in the privacy policy — the header alone is
        // an unkept secret.
        source: "/p/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noarchive, nosnippet" }],
      },
      {
        // Panorama basemap GeoJSON (public/geo/*) is immutable PER DEPLOY (see
        // components/panorama/geojson-cache.ts) but the filenames are NOT
        // content-hashed/versioned — so `immutable` would be wrong (a new
        // deploy reuses the same URL for changed content). 1 day + SWR lets
        // repeat visits skip the round-trip within a deploy's lifetime while
        // still revalidating well before a typical deploy cadence (perf sweep
        // P3, 2026-08-02).
        source: "/geo/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        // maplibre's worker and its shared chunk (public/maplibre/*), generated
        // by scripts/copy-maplibre-worker.ts on prebuild. Same class of asset as
        // /geo above and the same reasoning applies verbatim: immutable per
        // deploy, filenames NOT content-hashed, so `immutable` would be wrong.
        //
        // Without an entry here these two fall back to Next's `public/` default
        // of max-age=0 and revalidate on every page that draws a map — and the
        // shared chunk is 514 KB. It is the same 514 KB webpack already bundles
        // for the main thread; a worker cannot share the page's bundle, so the
        // second copy is unavoidable, which makes not caching it cost twice.
        source: "/maplibre/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
    ];
  },
  images: {
    remotePatterns: [
      // Local Supabase (127.0.0.1:54321) and any self-hosted instance derived
      // from NEXT_PUBLIC_SUPABASE_URL.
      {
        protocol: "http",
        hostname: supabaseHostname,
        port: supabaseParsed?.port ?? "54321",
        pathname: "/storage/v1/object/**",
      },
      // Production Supabase projects (*.supabase.co).
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/**",
      },
    ],
  },
  typescript: {
    // `next build` runs a full tsc pass after compiling. On Vercel's build
    // container (2 cores, 8 GB — see scripts/build.mjs) that pass is what
    // fails, every time, in three disguises: with an 8 GB heap ceiling the
    // container OOM-kills it, with a smaller ceiling it grinds in "ineffective
    // mark-compacts" until the 45-minute build timeout, and with Node's own
    // ~2 GB default it dies outright. Compilation itself finishes in 79s — the
    // type pass is the entire problem. Reproduced 2026-08-20 in a container
    // matched to Vercel's: 2 cpuset cores, 8192 MB cgroup, Node 24, pnpm
    // 10.28.0.
    //
    // Skipped ONLY where the machine cannot afford it, and nothing goes
    // unchecked as a result. Types are verified twice before a deploy can
    // exist: `pnpm typecheck` is the first step of `pnpm verify` (the
    // Definition of Done) and its own CI step, and `pnpm build` still
    // type-checks everywhere else — the workstation and CI runners both clear
    // the threshold by a wide margin. A Vercel build deploys a commit those
    // gates already passed; it is not itself a gate.
    //
    // The flag comes from scripts/build.mjs, which sets DIM_CONSTRAINED_BUILD
    // from the real cgroup memory limit. It is deliberately NOT keyed off
    // `process.env.VERCEL`: that variable only exists when a project has
    // "Automatically expose System Environment Variables" turned on, so a
    // dashboard toggle could silently disarm this and the build would fail the
    // old way with no clue why. A cgroup limit cannot be switched off.
    //
    // Do NOT widen this to every environment. tsconfig.json includes
    // `.next/types/**/*.ts`, so the local and CI build passes are what cover
    // Next's generated route types; a standalone `tsc --noEmit` on a clean tree
    // runs before those files exist and would miss them.
    ignoreBuildErrors: process.env.DIM_CONSTRAINED_BUILD === "1",
  },
  experimental: {
    // Build fleet size, decided by scripts/build.mjs from the cgroup memory
    // limit and handed over as DIM_BUILD_WORKERS.
    //
    // Without this Next calls getNumberOfWorkers(), which defaults to
    // `os.cpus().length - 1` — the HOST's core count from inside a container.
    // The build script sizes each worker's heap as headroom/workers, so if Next
    // forks a different number of workers than the script divided by, the
    // ceiling stops bounding anything: on Vercel the script divided by 2 while
    // Next stood ready to fork ~15, each inheriting the same NODE_OPTIONS.
    // Empty (an unconstrained box) leaves Next's own default alone.
    ...(process.env.DIM_BUILD_WORKERS ? { cpus: Number(process.env.DIM_BUILD_WORKERS) } : {}),
    // Trades compilation speed for a lower peak RSS. Only where memory is the
    // binding constraint: on the workstation and CI the build keeps its speed.
    ...(process.env.DIM_CONSTRAINED_BUILD === "1" ? { webpackMemoryOptimizations: true } : {}),
    // Welfare denuncia evidence allows up to 5 files × 25 MB.
    serverActions: {
      bodySizeLimit: "50mb",
    },
    optimizePackageImports: ["lucide-react", "recharts", "maplibre-gl"],
  },
  webpack: (config) => {
    // No filesystem cache on the constrained box.
    //
    // Three consecutive Vercel builds (32d9bbdc2, 91668ca5e, 297b4a5cc) were
    // SIGKILLed by the container's OOM killer ~90s into compilation, the last
    // one with the heap ceiling already lowered to 6144 MB — the V8 heap was
    // not what overflowed. All three restored the webpack build cache from the
    // last READY deployment, produced by a module graph that two work units
    // have since reshaped. Deserializing a large stale cache balloons RSS
    // outside the heap ceiling's reach, and under cgroup v2 even the page
    // cache of the cache file itself counts against memory.max.
    //
    // Disabling the cache here trades build minutes for a memory profile that
    // does not depend on what the previous deployment left behind. Scoped to
    // the constrained box: the workstation and CI keep their incremental
    // builds untouched.
    if (process.env.DIM_CONSTRAINED_BUILD === "1") {
      config.cache = false;
    }
    return config;
  },
};

export default nextConfig;
