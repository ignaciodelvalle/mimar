// UI-7 B8 — re-derivation de-notify. When a welfare report is re-derived to a
// DIFFERENT org, the previous org's active members must receive a corrective
// notice ("welfare_report_rederived_away") so they know they're no longer
// responsible (true notification retraction isn't possible).
//
// The derivation body moved out of the action into
// src/modules/welfare/infrastructure/derive-to-org-writer.ts, so the branch is
// asserted structurally across BOTH halves: the action must still hand the
// pre-write derivation target to the writer, and the writer must still branch
// on it. Behavioural coverage lives next to the writer
// (infrastructure/derive-to-org-writer.test.ts); this file guards the seam.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ACTIONS_FILE = join(process.cwd(), "src", "modules", "welfare", "actions.ts");
const WRITER_FILE = join(
  process.cwd(),
  "src",
  "modules",
  "welfare",
  "infrastructure",
  "derive-to-org-writer.ts",
);

describe("re-derivation de-notify (UI-7 B8)", () => {
  const actionsSrc = readFileSync(ACTIONS_FILE, "utf8");
  const writerSrc = readFileSync(WRITER_FILE, "utf8");

  it("the action passes the previous derivation target, read BEFORE the write", () => {
    expect(actionsSrc).toMatch(/previousOrgId:\s*report\.derivedToOrganizationId/);
  });

  it("the action reaches the writer through its imported identifier", () => {
    // Not via an object alias: scripts/check-audit-log-coverage.ts follows one
    // hop by identifier, and that hop is what keeps the action AUDITED.
    expect(actionsSrc).toMatch(
      /import\s*\{\s*deriveWelfareToOrg\s*\}\s*from\s*"\.\/infrastructure\/derive-to-org-writer"/,
    );
    expect(actionsSrc).toMatch(/await\s+deriveWelfareToOrg\(/);
  });

  it("only notifies the previous org when it differs from the new target", () => {
    expect(writerSrc).toMatch(/previousOrgId\s*&&\s*previousOrgId\s*!==\s*targetOrg\.id/);
  });

  it("emits a welfare_report_rederived_away corrective notice", () => {
    expect(writerSrc).toContain("welfare_report_rederived_away");
  });

  it("resets org intervention state on re-derivation", () => {
    expect(writerSrc).toMatch(/orgInterventionStatus:\s*null/);
    expect(writerSrc).toMatch(/orgInterventionAt:\s*null/);
  });
});
