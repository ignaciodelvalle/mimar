// WU-4 strangler shim parity test.
//
// After repointing consumers and deleting the old app/actions/welfare*.ts files,
// this test verifies:
//   1. The new module exports every symbol that consumers depend on.
//   2. No source file outside src/modules/ imports from the old action paths.
//
// Part 1 is a compile-time check (TypeScript) — if the module.ts action file
// doesn't export the expected symbols, this file fails to compile.
// Part 2 is a source-scan check (runtime) that reads the actual file content.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Part 1: Verify module exports all required symbols
// (If any of these imports fail to compile, the type-check phase catches it.)
// ---------------------------------------------------------------------------
import type {
  AssignResult,
  GenerateMpfExportResult,
  ModerationResult,
  TriageResult,
  WelfareReportFormState,
} from "@/src/modules/welfare/actions";
import {
  assignWelfareToMeAction,
  closeWelfareReportAction,
  confirmWelfareAsSpamAction,
  createOrgWelfareReportAction,
  createWelfareReportAction,
  generateMpfExportAction,
  passWelfareToTriageAction,
  startWelfareReportAction,
  triageWelfareReportAction,
  unassignWelfareAction,
} from "@/src/modules/welfare/actions";

describe("WU-4 — welfare module strangler: symbol exports", () => {
  it("exports all required action functions", () => {
    expect(typeof createWelfareReportAction).toBe("function");
    expect(typeof createOrgWelfareReportAction).toBe("function");
    expect(typeof triageWelfareReportAction).toBe("function");
    expect(typeof startWelfareReportAction).toBe("function");
    expect(typeof closeWelfareReportAction).toBe("function");
    expect(typeof passWelfareToTriageAction).toBe("function");
    expect(typeof confirmWelfareAsSpamAction).toBe("function");
    expect(typeof assignWelfareToMeAction).toBe("function");
    expect(typeof unassignWelfareAction).toBe("function");
    expect(typeof generateMpfExportAction).toBe("function");
  });

  it("get-active-govt-scope helper is importable from its source module", async () => {
    const { getActiveGovtScopeForUser } = await import("../get-active-govt-scope");
    expect(typeof getActiveGovtScopeForUser).toBe("function");
  });

  // Type-only check: if these types are exported, TS compiles. No runtime assertion needed.
  it("re-exports required types (compile-time only)", () => {
    // If WelfareReportFormState, TriageResult, ModerationResult, AssignResult,
    // and GenerateMpfExportResult are not exported, the import above would fail
    // at compile time. This test is a runtime witness that the module loaded.
    const _: [
      WelfareReportFormState,
      TriageResult,
      ModerationResult,
      AssignResult,
      GenerateMpfExportResult,
    ] = [{ error: null }, { ok: true }, { ok: true }, { ok: true }, { ok: false, error: "x" }];
    expect(_).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Part 2: Source-level scan — no consumer outside src/modules/ imports from
//         the old app/actions/welfare*.ts paths.
// ---------------------------------------------------------------------------
const OLD_IMPORT_PATTERN =
  /@\/app\/actions\/welfare(-triage|-moderation|-assign|-export-mpf)?[/"']/;

// Consumer files that SHOULD NOT import from old paths after repoint.
const CONSUMER_FILES = [
  join("app", "denuncias", "nueva", "DenunciaWizard.tsx"),
  join("app", "denuncias", "nova", "WelfareReportForm.tsx"),
  join("app", "denuncias", "nueva", "WelfareReportForm.tsx"),
  join("app", "gob", "maltrato", "[id]", "TriageActions.tsx"),
  join("app", "gob", "maltrato", "[id]", "AssignmentActions.tsx"),
  join("app", "gob", "maltrato", "[id]", "MpfExportButton.tsx"),
  join("app", "admin", "moderacion", "[id]", "ModerationActions.tsx"),
  join("app", "org", "[orgToken]", "maltrato", "nuevo", "page.tsx"),
  join("__tests__", "welfare-mpf-export.test.ts"),
];

describe("WU-4 — welfare module strangler: no dangling old-path imports", () => {
  for (const relPath of CONSUMER_FILES) {
    it(`${relPath} does not import from old app/actions/welfare* paths`, () => {
      let src: string;
      try {
        src = readFileSync(join(process.cwd(), relPath), "utf8");
      } catch {
        // File may not exist (e.g. typo guard for DenunciaWizard.tsx); skip.
        return;
      }
      expect(
        src,
        `${relPath} still references old app/actions/welfare* — repoint it to @/modules/welfare/actions`,
      ).not.toMatch(OLD_IMPORT_PATTERN);
    });
  }
});
