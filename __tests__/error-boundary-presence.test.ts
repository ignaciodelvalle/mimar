// Error-boundary presence fitness (error-path audit 2026-07-04 E7) — the
// sibling of skeleton.test.tsx's loading coverage: every portal segment that
// ships loading.tsx in CI must have an error.tsx with a portal-scoped escape,
// or a throw lands on app/error.tsx (fullscreen, wrong home — the E1 class
// that made the /admin/sistema digest crash disorienting).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

// Portal segments that MUST carry their own error.tsx. Grow this list when a
// new portal (route group with its own shell/layout) ships.
const REQUIRED_BOUNDARIES: Array<{ segment: string; expectedHome: string | null }> = [
  // Root boundary uses ErrorBoundary's default homeHref="/" — expectedHome
  // null means "no explicit override required".
  { segment: "app/error.tsx", expectedHome: null },
  { segment: "app/(app)/error.tsx", expectedHome: "/inicio" },
  { segment: "app/gob/error.tsx", expectedHome: "/gob" },
  { segment: "app/admin/error.tsx", expectedHome: "/admin" },
  // Panorama consoles (RESILIENCE 2026-07-10, PO finding #1): the board streams
  // its slow seed behind <Suspense>, so a throw there must land on a panorama-
  // local boundary — otherwise the operator is stranded on the parent skeleton.
  { segment: "app/admin/panorama/error.tsx", expectedHome: "/admin" },
  { segment: "app/gob/panorama/error.tsx", expectedHome: "/gob" },
  { segment: "app/(public)/p/[publicToken]/error.tsx", expectedHome: "/" },
  // Added nav-QOL/error-path audit 2026-07-04 N5/E2:
  { segment: "app/(app)/mis-mascotas/[publicToken]/error.tsx", expectedHome: "/mis-mascotas" },
  // Vet-facing surface — no portal-specific escape, uses ErrorBoundary's
  // generic default (homeHref="/"), so no explicit override to assert here.
  { segment: "app/libreta/compartir/[shareToken]/error.tsx", expectedHome: null },
];

describe("error-boundary presence (audit E1/E7)", () => {
  for (const { segment, expectedHome } of REQUIRED_BOUNDARIES) {
    it(`${segment} exists and escapes to ${expectedHome}`, () => {
      const path = join(ROOT, segment);
      expect(existsSync(path), `${segment} is missing`).toBe(true);
      const src = readFileSync(path, "utf-8");
      expect(src, `${segment} must render the shared ErrorBoundary`).toMatch(
        /ErrorBoundary|error\.digest/,
      );
      if (expectedHome !== null) {
        expect(src, `${segment} must escape to its own portal`).toContain(`"${expectedHome}"`);
      }
    });
  }

  it("org portal boundary exists (dynamic token home)", () => {
    const path = join(ROOT, "app/org/[orgToken]/error.tsx");
    expect(existsSync(path)).toBe(true);
  });
});
