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
//
// M16 (2026-09-25) moved the author's banner out of the page into ONE shared
// function, `welfareReportReporterNotice` (src/modules/welfare/domain/types.ts),
// used by both the web page and GET /api/v1/me/welfare-reports/{code}. The
// guard is now a real function, so it is pinned BEHAVIOURALLY — every status in
// the catalogue — and each surface is pinned to call it rather than re-deciding.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  WELFARE_REPORT_STATUSES,
  welfareReportReporterNotice,
} from "@/src/modules/welfare/domain/types";

const BANNER_MARKER = "integración con los";
const TERMINAL = ["closed", "invalid", "duplicate"] as const;

const SURFACES = [
  join(process.cwd(), "app", "(app)", "denuncias", "[id]", "page.tsx"),
  join(process.cwd(), "app", "api", "v1", "me", "welfare-reports", "payload.ts"),
];

describe("integration-pending banner gating (UI-7 B7)", () => {
  it("shows the pending-integration banner for an open report (non-vacuity)", () => {
    expect(welfareReportReporterNotice("open")?.text).toContain(BANNER_MARKER);
  });

  it.each(TERMINAL)("shows no banner at all on a terminal status: %s", (status) => {
    expect(WELFARE_REPORT_STATUSES).toContain(status);
    expect(welfareReportReporterNotice(status)).toBeNull();
  });

  it("never shows the pending-integration copy on any status but open", () => {
    for (const status of WELFARE_REPORT_STATUSES) {
      if (status === "open") continue;
      expect([status, welfareReportReporterNotice(status)?.text ?? ""]).not.toEqual([
        status,
        expect.stringContaining(BANNER_MARKER),
      ]);
    }
  });

  for (const file of SURFACES) {
    it(`${file} takes its banner from the shared function`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).toContain("welfareReportReporterNotice(");
      // …and does not carry its own copy of the banner to drift from it.
      expect(src).not.toContain(BANNER_MARKER);
    });
  }
});
