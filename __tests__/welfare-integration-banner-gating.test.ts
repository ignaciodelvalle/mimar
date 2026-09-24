// UI-7 B7 — the "integración pendiente" banner must be gated behind a
// non-terminal status check on both reporter-facing surfaces (it contradicts
// the status badge on closed / invalid / duplicate).
//
// These surfaces are server components; rather than render them, we assert the
// structural guard is present in source (same source-scan style as
// welfare-org-pii-fitness.test.ts). If a future edit drops the guard, this fails.
//
// SCOPE CHANGE, legal/denuncias-despublicadas (2026-08-17). This file used to scan
// `app/(public)/denuncias/codigo/[code]/page.tsx` as the anonymous reporter's
// surface. That page no longer shows status at ALL — status is process information
// about an investigation into a person named in the file, and a bare reference code
// is not an identity — so there is no banner there to gate, and scanning it for one
// would have kept a passing assertion about a screen that no longer exists.
//
// The banner moved to the reporter view, /denuncias/seguimiento, where it is gated
// on the coarse TIMELINE rather than on a named terminal-status predicate (the
// reporter projection deliberately does not expose the raw status enum — see
// lib/domain/denuncia-reporter-view.ts). A source scan for `isTerminal*Status` and
// three string literals cannot express that guard, so it is pinned BEHAVIOURALLY
// instead, by rendering the real page: see
// __tests__/denuncia-reporter-view-contract.test.tsx, "integration-pending banner".
// That is a strictly stronger test than the scan it replaced.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const BANNER_MARKER = "integración con los";

const FILES = [join(process.cwd(), "app", "(app)", "denuncias", "[id]", "page.tsx")];

describe("integration-pending banner gating (UI-7 B7)", () => {
  for (const file of FILES) {
    it(`${file} guards the banner behind a terminal-status check`, () => {
      const src = readFileSync(file, "utf8");

      // The banner copy must still exist (non-vacuity).
      expect(src).toContain(BANNER_MARKER);

      // A terminal-status predicate must be defined and referenced.
      expect(src).toMatch(/isTerminal\w*Status/);
      // The predicate must cover all three terminal statuses.
      expect(src).toContain('"closed"');
      expect(src).toContain('"invalid"');
      expect(src).toContain('"duplicate"');
    });
  }
});
