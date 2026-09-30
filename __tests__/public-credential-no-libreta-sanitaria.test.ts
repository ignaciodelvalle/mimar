// The public credential (a stranger with a QR, no auth) must never reach
// libreta sanitaria territory — vet-visit-record's W2 hardening.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// src/modules/events/application/clinical/condition-at-intake-form.test.ts
// already asserted "the literal type name never appears under app/(public)",
// but that check has two holes a reviewer found (verify report,
// sdd/vet-visit-record/verify-report, finding W2):
//
//   1. It only greps for the STRING "condition_at_intake_recorded". A future
//      change could read the libreta the wide way — importing
//      LIBRETA_SANITARIA_EVENT_TYPES and iterating it, or building the WHERE
//      clause with libretaSanitariaClause() — and never spell the literal at
//      all, sailing straight past the check while reaching the exact rows
//      the literal check exists to keep off a public page.
//   2. It never looked at the LOADER itself
//      (src/modules/pets/application/read/load-public-credential.ts), which
//      is the one file that actually issues the public credential's queries;
//      app/(public) only calls it.
//
// This fence closes both: it scans app/(public) AND the loader for all three
// shapes — the clause helper, the type-list constant, and the literal type —
// comment-stripped so a comment that NAMES the danger (like this one) is not
// mistaken for code that reaches it.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/scripts/lib/strip-comments.mjs";

/** The one condition_at_intake_recorded-shaped literal this fence guards by name. */
const LIBRETA_ONLY_TYPE_LITERAL = "condition_at_intake_recorded";

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "libretaSanitariaClause", pattern: /libretaSanitariaClause/ },
  { label: "LIBRETA_SANITARIA_EVENT_TYPES", pattern: /LIBRETA_SANITARIA_EVENT_TYPES/ },
  {
    label: `the literal type "${LIBRETA_ONLY_TYPE_LITERAL}"`,
    pattern: new RegExp(LIBRETA_ONLY_TYPE_LITERAL),
  },
];

const PUBLIC_ROOT = join(process.cwd(), "app", "(public)");
const CREDENTIAL_LOADER = join(
  process.cwd(),
  "src",
  "modules",
  "pets",
  "application",
  "read",
  "load-public-credential.ts",
);

function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const dir = (entry as { parentPath?: string; path?: string }).parentPath ?? entry.path ?? root;
    out.push(join(dir, entry.name));
  }
  return out;
}

const SCANNED_FILES = [...collectSourceFiles(PUBLIC_ROOT), CREDENTIAL_LOADER];

type Hit = { file: string; label: string };

function findHits(files: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const { label, pattern } of FORBIDDEN_PATTERNS) {
      if (pattern.test(code)) hits.push({ file: file.replace(/\\/g, "/"), label });
    }
  }
  return hits;
}

describe("public credential never reaches the libreta sanitaria (W2)", () => {
  it("scans a real surface — the fence must not go inert", () => {
    // app/(public) alone carries the credential page, its streamed sections,
    // the lost-pet flow and their tests — comfortably more than a handful.
    expect(SCANNED_FILES.length).toBeGreaterThan(10);
    expect(SCANNED_FILES).toContain(CREDENTIAL_LOADER);
  });

  it("detects all three forbidden shapes on an executable line (detector works at all)", () => {
    const fixture = stripComments(
      [
        "// libretaSanitariaClause() would leak here if uncommented",
        "import { libretaSanitariaClause } from '@/lib/infra/libreta-sanitaria';",
        "import { LIBRETA_SANITARIA_EVENT_TYPES } from '@/lib/infra/libreta-sanitaria';",
        "const t = 'condition_at_intake_recorded';",
      ].join("\n"),
    );
    const detected = FORBIDDEN_PATTERNS.filter(({ pattern }) => pattern.test(fixture)).map(
      (p) => p.label,
    );
    expect(detected).toEqual(FORBIDDEN_PATTERNS.map((p) => p.label));
    // Comment stripping actually ran — the commented-out mention alone would
    // still match libretaSanitariaClause via the real import line, so prove
    // the comment itself is gone.
    expect(fixture).not.toContain("would leak here");
  });

  it("no file under app/(public), nor the credential loader, imports or uses the libreta sanitaria surface", () => {
    const hits = findHits(SCANNED_FILES);
    expect(
      hits.map((h) => `${h.file} — ${h.label}`),
      [
        "A public-credential surface (app/(public) or the loader it calls) referenced",
        "libreta sanitaria machinery a stranger with a QR must never reach:",
        "libretaSanitariaClause(), LIBRETA_SANITARIA_EVENT_TYPES, or the literal type",
        `"${LIBRETA_ONLY_TYPE_LITERAL}". Query the public credential's OWN explicit`,
        "event types instead (see CredentialStreamedSections.tsx for the pattern).",
      ].join("\n"),
    ).toEqual([]);
  });

  it("non-vacuity: the credential loader really was read and is a real query file", () => {
    const credential = readFileSync(CREDENTIAL_LOADER, "utf8");
    expect(credential).toContain("vaccination_administered");
  });
});
