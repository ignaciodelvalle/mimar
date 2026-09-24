// Public "stateful" cache policy — privacy-class regression tests (2026-07-07).
//
// Guards the fix for the CDN/full-route-cache privacy leak where a REVOKED
// libreta share and a FOUND pet's owner phone were served stale at the exact
// public URL. Three layers are asserted:
//   1. The middleware allowlist (isPublicNoStoreRoute) covers every privacy-
//      sensitive public route and excludes static/owner routes.
//   2. Each of those pages still declares `export const dynamic = "force-dynamic"`
//      (defense-in-depth beneath the no-store header).
//   3. (audit A03-1, 2026-09-18) The allowlist is checked against the TREE: every
//      `force-dynamic` route under the public roots is either stamped or
//      exempted with a reason, and every entry names a route that exists.
//
// Layer 3 exists because layers 1 and 2 are hand lists and drifted: `/t/{serial}`
// and both `/refugios` pages were force-dynamic and never stamped, and layer 1
// positively asserted that `/refugios` was NOT no-store.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NO_STORE_CACHE_CONTROL,
  NO_STORE_EXACT,
  NO_STORE_EXEMPT_DYNAMIC_ROUTES,
  NO_STORE_PREFIXES,
  isPublicNoStoreRoute,
} from "@/lib/infra/public-cache-policy";

describe("isPublicNoStoreRoute — privacy-sensitive public surface", () => {
  it("never lets a cache keep a found pet on 'SE BUSCA' at its QR credential", () => {
    // The guarantee this file was written for, stated on its own: the
    // credential flips lost → found and must stop showing the owner's phone
    // the moment the owner marks it found.
    expect(isPublicNoStoreRoute("/p/DIM-ABCD-1234")).toBe(true);
  });

  it.each([
    // QR credential + finder/sighting subpaths + OG image
    "/p/DIM-ABCD-1234",
    "/p/DIM-ABCD-1234/encontre",
    "/p/DIM-ABCD-1234/sighting",
    "/p/DIM-ABCD-1234/opengraph-image",
    // revocable Tier-2 medical share
    "/libreta/compartir/some-share-token",
    // lost-pet public listing (exact)
    "/perdidas",
    // adoption listing + detail + apply
    "/adoptar",
    "/adoptar/DIM-ABCD-1234",
    "/adoptar/DIM-ABCD-1234/postular",
    // public denuncia status (viewer-gated PII)
    "/casos/CAS-ABCD-1234",
    // physical-tag resolver — a revoked chapa must stop redirecting (A03-1)
    "/t/TAG-ABCD-1234",
    // shelter directory + profile — auth-aware chrome, admin banner (A03-1)
    "/refugios",
    "/refugios/ORG-ABCD-1234",
  ])("marks %s as no-store", (pathname) => {
    expect(isPublicNoStoreRoute(pathname)).toBe(true);
  });

  it.each([
    // static public pages — safe to cache
    "/",
    "/ayuda",
    "/privacidad",
    "/terminos",
    "/leyes",
    "/acerca",
    // `/t/` carries its slash so it cannot swallow a page that merely starts
    // with the letter.
    "/terminos-y-condiciones",
    // owner / operator surfaces are auth-gated, not part of this public allowlist
    "/mis-mascotas/DIM-ABCD-1234",
    "/gob/casos/CAS-ABCD-1234",
    "/admin/censo",
  ])("does NOT mark %s as no-store", (pathname) => {
    expect(isPublicNoStoreRoute(pathname)).toBe(false);
  });

  it("emits an explicit no-store Cache-Control value", () => {
    expect(NO_STORE_CACHE_CONTROL).toContain("no-store");
    expect(NO_STORE_CACHE_CONTROL).toContain("private");
  });
});

describe("force-dynamic defense-in-depth on public stateful pages", () => {
  const repoRoot = join(__dirname, "..");
  const pages = [
    "app/(public)/p/[publicToken]/page.tsx",
    "app/(public)/p/[publicToken]/encontre/page.tsx",
    "app/(public)/p/[publicToken]/sighting/page.tsx",
    "app/libreta/compartir/[shareToken]/page.tsx",
    "app/(public)/perdidas/page.tsx",
    "app/(public)/adoptar/page.tsx",
    "app/(public)/adoptar/[petToken]/page.tsx",
    "app/(public)/casos/[publicCode]/page.tsx",
  ];

  it.each(pages)("%s declares dynamic = force-dynamic", (relPath) => {
    const src = readFileSync(join(repoRoot, relPath), "utf8");
    expect(src).toMatch(/export const dynamic\s*=\s*["']force-dynamic["']/);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — the allowlist against the tree (A03-1)
// ---------------------------------------------------------------------------

const REPO_ROOT = join(__dirname, "..");

/** The trees an anonymous caller reaches without a session. */
const PUBLIC_ROOTS = ["app/(public)", "app/libreta", "app/r"] as const;

/** Next's file conventions for a separately requestable route. */
const ROUTE_ENTRY_FILES = new Set([
  "page.tsx",
  "page.ts",
  "route.ts",
  "opengraph-image.tsx",
  "twitter-image.tsx",
]);

/** A declaration in code: at the start of a line, so a comment quoting it does not count. */
const FORCE_DYNAMIC = /^export const dynamic\s*=\s*["']force-dynamic["']/m;

type RouteFile = { file: string; path: string; forceDynamic: boolean };

/**
 * The URL a route file answers, with every dynamic segment filled by a sample.
 * Route groups `(x)` and parallel slots `@x` do not appear in URLs.
 */
function urlPathOf(file: string): string {
  const segments = file
    .split("/")
    .slice(1, -1)
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"))
    .map((s) => (/^\[.+\]$/.test(s) ? "SAMPLE-TOKEN" : s));
  return `/${segments.join("/")}`;
}

function publicRouteFiles(): RouteFile[] {
  const out: RouteFile[] = [];
  for (const root of PUBLIC_ROOTS) {
    for (const entry of readdirSync(join(REPO_ROOT, root), {
      withFileTypes: true,
      recursive: true,
    })) {
      if (!entry.isFile() || !ROUTE_ENTRY_FILES.has(entry.name)) continue;
      const abs = join(entry.parentPath, entry.name);
      const file = abs.slice(REPO_ROOT.length + 1).replaceAll("\\", "/");
      out.push({
        file,
        path: urlPathOf(file),
        forceDynamic: FORCE_DYNAMIC.test(readFileSync(abs, "utf8")),
      });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

describe("the no-store allowlist is derived from the tree, not trusted as a list", () => {
  const routes = publicRouteFiles();
  const dynamicRoutes = routes.filter((r) => r.forceDynamic);

  it("finds the force-dynamic public routes (non-vacuity)", () => {
    // Fifteen on the day this landed. A drop means the walk or the
    // declaration match broke and every assertion below passes over nothing.
    expect(dynamicRoutes.length).toBeGreaterThanOrEqual(15);
    const files = dynamicRoutes.map((r) => r.file);
    expect(files).toContain("app/(public)/p/[publicToken]/page.tsx");
    // The three A03-1 found uncovered.
    expect(files).toContain("app/(public)/t/[serial]/page.tsx");
    expect(files).toContain("app/(public)/refugios/page.tsx");
    expect(files).toContain("app/(public)/refugios/[orgToken]/page.tsx");
    // Route handlers are routes too.
    expect(files).toContain("app/(public)/denuncias/seguimiento/salir/route.ts");
    // It reaches beyond the (public) group.
    expect(files).toContain("app/libreta/compartir/[shareToken]/page.tsx");
  });

  it("stamps every force-dynamic public route, unless it is exempted with a reason", () => {
    const unstamped = dynamicRoutes
      .filter((r) => NO_STORE_EXEMPT_DYNAMIC_ROUTES[r.file] === undefined)
      .filter((r) => !isPublicNoStoreRoute(r.path))
      .map((r) => `${r.file} (${r.path})`);
    expect(unstamped).toEqual([]);
  });

  it("keeps every exemption pointed at a force-dynamic route that really is unstamped", () => {
    const byFile = new Map(dynamicRoutes.map((r) => [r.file, r]));
    for (const [file, reason] of Object.entries(NO_STORE_EXEMPT_DYNAMIC_ROUTES)) {
      const route = byFile.get(file);
      expect(route, `${file} is exempt but is not a force-dynamic public route`).toBeDefined();
      expect(
        route && isPublicNoStoreRoute(route.path),
        `${file} is exempt and stamped anyway — drop one`,
      ).toBe(false);
      expect(reason.length, `${file} needs a written reason`).toBeGreaterThan(40);
    }
  });

  it("names only routes that exist — no entry outlives the page it was for", () => {
    const paths = routes.map((r) => r.path);
    const stale = [
      ...NO_STORE_PREFIXES.filter((prefix) => !paths.some((p) => p.startsWith(prefix))),
      ...NO_STORE_EXACT.filter((exact) => !paths.includes(exact)),
    ];
    expect(stale).toEqual([]);
  });

  it("the derivation bites: without the two A03-1 entries, it names the routes they cover", () => {
    // RED control over the real tree: re-run the stamping rule as the list was
    // before this change. If the walk could not see these routes, this would
    // come back empty and the assertion above would be vacuous.
    const before = (path: string) =>
      isPublicNoStoreRoute(path) && !path.startsWith("/t/") && !path.startsWith("/refugios");
    const missed = dynamicRoutes.filter((r) => !before(r.path)).map((r) => r.file);
    expect(missed).toEqual([
      "app/(public)/refugios/[orgToken]/page.tsx",
      "app/(public)/refugios/page.tsx",
      "app/(public)/t/[serial]/page.tsx",
    ]);
  });

  it("reads the URL off the file path the way Next does", () => {
    expect(urlPathOf("app/(public)/t/[serial]/page.tsx")).toBe("/t/SAMPLE-TOKEN");
    expect(urlPathOf("app/(public)/refugios/page.tsx")).toBe("/refugios");
    expect(urlPathOf("app/libreta/compartir/[shareToken]/page.tsx")).toBe(
      "/libreta/compartir/SAMPLE-TOKEN",
    );
    expect(urlPathOf("app/(public)/denuncias/seguimiento/salir/route.ts")).toBe(
      "/denuncias/seguimiento/salir",
    );
  });
});
