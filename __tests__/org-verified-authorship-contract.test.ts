// An organization's `verified` flag may back an INSTITUTIONAL claim, never a
// PROFESSIONAL one.
//
// THE DISTINCTION, because it is the whole file. `computeConfidence`
// (lib/events/event-confidence.ts) resolves:
//
//   authorRole "shelter" + authorVerified + an org id → institutional_verified
//   authorRole "vet"     + authorVerified             → professional_verified
//
// and its own table defines the second as "licensed veterinarian with verified
// matriculation". So pairing `authorVerified: organization.verified` — a flag
// an admin sets with one click — with authorRole "shelter" is HONEST: a verified
// institution recorded this act, which is exactly what a custody transfer or a
// chip-match confirmation is. Pairing it with "vet" is a LIE about a person.
//
// That lie was live in `report-bite-from-org.ts` until 2026-08-17, where
// `orgTypeToReporterRole` mapped org_type "clinic" to "vet", so anyone filing a
// bite report from a verified veterinaria received the matriculated vet's seal
// — on the path that opens a rabies observation window. It was fixed by routing
// authorship through `resolveSignerProvenance`.
//
// An audit of that fix reported "9 routes" with the same shape. Eight of them
// are NOT the same defect — they stamp the literal "shelter" for institutional
// acts — and that judgement is the thing this fence records. Without it the
// distinction lives only in a reviewer's head, and the next reader sees nine
// identical-looking lines with no way to tell which one was wrong.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const ORG_VERIFIED = /authorVerified:\s*org(anization)?\.verified/;
const AUTHOR_ROLE = /authorRole:\s*(.+?),/;
const LOOKBACK_LINES = 8;

type Site = { file: string; line: number; role: string };

function sourceFiles(): string[] {
  const found: string[] = [];
  for (const root of ["src", "lib", "app"]) {
    for (const entry of readdirSync(join(ROOT, root), { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (entry.name.includes(".test.")) continue;
      found.push(join(entry.parentPath, entry.name));
    }
  }
  return found;
}

/** Every place that stamps event authorship from the organization's flag. */
function orgVerifiedAuthorshipSites(): Site[] {
  const sites: Site[] = [];
  for (const abs of sourceFiles()) {
    const lines = readFileSync(abs, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comments — report-bite-from-org.ts quotes the OLD code verbatim in
      // its historical note, and flagging that would make this fence a liar
      // about the very file it exists for.
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      if (!ORG_VERIFIED.test(line)) continue;

      const window = lines.slice(Math.max(0, i - LOOKBACK_LINES), i + 2);
      const roleLine = window
        .filter((l) => !l.trim().startsWith("//"))
        .find((l) => AUTHOR_ROLE.test(l));
      const role = roleLine?.match(AUTHOR_ROLE)?.[1]?.trim() ?? "<none>";
      sites.push({ file: abs.slice(ROOT.length + 1).replaceAll("\\", "/"), line: i + 1, role });
    }
  }
  return sites;
}

describe("organization.verified may back an institutional claim, not a professional one", () => {
  it("finds the sites at all", () => {
    // NON-VACUITY. If the walk breaks or the pattern stops matching, the
    // assertion below would pass over an empty list forever.
    expect(orgVerifiedAuthorshipSites().length).toBeGreaterThanOrEqual(5);
  });

  it('stamps the literal "shelter" at every one of them', () => {
    // A variable — `reporterRole === "vet" ? "vet" : "shelter"`, or anything
    // read from org_type — is the defect, whatever it evaluates to today. Only
    // the literal is accepted, because only the literal cannot start meaning
    // "vet" after an unrelated edit.
    const wrong = orgVerifiedAuthorshipSites().filter((s) => s.role !== '"shelter"');
    expect(wrong.map((s) => `${s.file}:${s.line} → authorRole: ${s.role}`)).toEqual([]);
  });

  it("no longer includes the bite-report path, which now asks the signer", () => {
    // The one site that WAS wrong. If it reappears here, someone reverted the
    // fix or reintroduced the pattern next to it.
    const files = orgVerifiedAuthorshipSites().map((s) => s.file);
    expect(files).not.toContain("src/modules/surveillance/application/report-bite-from-org.ts");
  });
});
