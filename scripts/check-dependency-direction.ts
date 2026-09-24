// Inter-module dependency direction linter — CI ratchet (F3).
//
// Enforces that no NEW cross-module import edges are introduced beyond the
// baseline set captured on 2026-06-26 (branch integration/session-review).
//
// Within-module layer enforcement (domain → no db/infra/framework) is already
// handled by the biome.json noRestrictedImports overrides on
// src/modules/*/domain/**. This script covers the BETWEEN-module axis.
//
// Rule: every import from src/modules/<A>/** that resolves to
// @/src/modules/<B>/** (where B ≠ A) must be an entry in ALLOWED_EDGES.
// Any edge not in ALLOWED_EDGES is an error and exits 1.
//
// Adding a new edge requires a deliberate update to ALLOWED_EDGES (with a
// justification comment), keeping the graph legible and change-reviewed.
//
// Run: pnpm tsx scripts/check-dependency-direction.ts   (or: pnpm lint:deps)
// Exits 0 when clean; exits 1 listing each offending import with file:line.
//
// Regex-based, not a full AST analyzer — mirrors the sibling linters
// (check-ui-invariants.ts, check-design-tokens.ts, check-authz-guards.ts).

import { globSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Baseline — allowed cross-module edges as of 2026-06-26.
// Format: "from:to" where from and to are module names (the directory name
// under src/modules/).
//
// Current graph (acyclic):
//
//   adoption  ──▶  organizations   (shared kernel — acknowledged in README)
//   foster    ──▶  organizations   (shared kernel)
//   transfers ──▶  organizations   (shared kernel)
//   surveillance ▶ organizations   (shared kernel)
//   events    ──▶  surveillance    (trigger enqueue side-effect)
//   welfare      ──▶ cases         (shared kernel — the OpenedReason union)
//   transfers    ──▶ cases         (shared kernel)
//   surveillance ──▶ cases         (shared kernel)
//
// REMOVED 2026-07-18 (Tren 2b hardening):
//   events──▶pets was chipImplantSiteFromLocation — neither module owned it
//   more than the other (both write petIdentifications from the same raw
//   value), so it moved to lib/domain/microchip-implant-site.ts, outside the
//   module graph. See lib/domain/microchip-implant-site.ts.
//   pets──▶adoption was NewNotification/UseCaseResult imported from
//   set-adoption-eligibility.ts. pets now declares its own local copies in
//   src/modules/pets/domain/types.ts — the same "mirror the shape, don't
//   import the module" convention already used by foster/transfers/welfare/
//   surveillance/organizations/events/decomiso.
// ---------------------------------------------------------------------------
export const ALLOWED_EDGES = new Set<string>([
  "adoption:organizations",
  "foster:organizations",
  "transfers:organizations",
  "surveillance:organizations",
  "events:surveillance",
  // Edges surfaced by the strangler migration (2026-06-30) — real dependencies
  // that previously lived in app/actions/ (un-checked) and became visible when
  // the logic moved into src/modules/. All intentional:
  "alerts:surveillance", // alert-firings triage opens an outbreak investigation (openOutbreakInvestigationAction)
  "pets:custody", // pet-claim dispute flow opens a custody dispute (openDisputeFromEvent)
  "search:organizations", // omnibox logs a PII read (logPiiQueryForAuthority) + checks org capabilities (getGrantedCapabilities)

  // Edges surfaced by the structured-open-reason change (2026-07-16). `cases`
  // is a shared kernel in the same sense `organizations` is: many modules open
  // cases, and `cases` imports from none of them — the graph stays acyclic.
  //
  // These are NOT new dependencies. Every one of these modules already called
  // CasesRepository.openCase; the coupling was simply invisible, because each
  // declared its own port with `openedReason: string` and a primitive hides
  // where it came from. `openedReason` is now the closed OpenedReason union, so
  // the port has to name the type and the edge became visible to this guard.
  //
  // That visibility is the point of the change, not a side effect of it: a
  // `string` that anyone could construct is exactly how transfer-custody.ts
  // shipped "direct custody handoff to_role=owner" to funcionarios for months.
  //
  // Only these three appear because only they declare their own openCase port
  // types. adoption/foster/decomiso/pets/events reach the repository directly
  // and infer the type, so they need no import.
  "welfare:cases", // create-welfare-report + create-org-welfare-report port types
  "transfers:cases", // openHandshakeCase port (transfer-custody, propose-cross-org-transfer)
  "surveillance:cases", // report-bite, report-bite-from-org, outbreak-investigation ports

  // rehome-by-titular (2026-08). The sponsorship lifecycle spans cases,
  // ownerships and adoption and belongs to none of them, so it is its own
  // module — and it DEPENDS on adoption, never the reverse. The accept
  // transaction reuses AdoptionRepository's eligibility + listing writers
  // inside its own tx (design ADR-1 steps 6-7), and the REQ-16 gate keys on
  // the unmatched `rehome_sponsorship_started` predicate that lives next to
  // the `rehome_sponsorship_ended` writer in adoption/infrastructure. That
  // writer stays in adoption precisely so this edge has no return edge: moving
  // it here would close the cycle adoption -> rehome -> adoption.
  "rehome:adoption",
  // Shared kernel, same as adoption/foster/transfers/surveillance above: the
  // org accept/decline action authorizes with requireCapabilityForOrgToken.
  "rehome:organizations",
  // A cross-org transfer must refuse to hand off a custody row that a titular's
  // consent opened (spec REQ-15) — the predicate for "is this row an open
  // sponsorship" is `findOpenSponsorship`, which lives beside the
  // `rehome_sponsorship_ended` writer in adoption/infrastructure, and it is
  // read from there rather than copied (one definition of the spine match).
  // adoption imports nothing from transfers, so the graph stays acyclic.
  "transfers:adoption",
  // THE ORG GATE OVER NOTES (PO decision 2026-08-26). `createNoteAction` now
  // refuses an org-path caller without `event.write`, and the vocabulary for
  // that question — `getGrantedCapabilities` — lives in `organizations`, the
  // same shared kernel adoption/foster/transfers/surveillance/rehome/search
  // already read it from. Not a new KIND of coupling: `lib/infra/pet-access.ts`
  // has asked organizations the same question for every clinical writer since
  // requireAlivePetAccess existed; the note is the one writer that skipped it,
  // and closing that made the existing dependency visible to this fence.
  // organizations imports from no module, so the graph stays acyclic.
  "events:organizations",

  // SUBJECT-RIGHTS ERASE RELEASES THE MICROCHIP (2026-08-28, PO/Claude decision).
  // When a person erases their account, the suppressed pet's microchip must be
  // RELEASED so whoever finds the animal can re-register it — the same
  // reunification-ceases-to-exist posture PO-4 already chose for the physical
  // chapa. `erase-subject-data.ts` is a cross-cutting privacy saga that already
  // tears down caretaker grants, attachments and pet-contact data; it invokes
  // the pets domain's own `replaceMicrochipForUser` revoke use-case (event-backed)
  // rather than raw-SQL flipping the canonical row — a bare status flip with no
  // retraction event would false-positive the drift detector on every erased pet.
  // `pets` imports nothing from `auth`, so the graph stays acyclic.
  "auth:pets",
  // organizations → auth (added 2026-09-18, pilot contract T1-P3): the
  // institutional account writers (create-institutional-account.ts,
  // reset-institutional-credentials.ts) mark a new or reset account as
  // "must set its password on first access" and send the invite to that page.
  // The marker and the path are auth's own domain (auth/domain/first-access.ts),
  // imported read-only — duplicating them in organizations would let the invite
  // and the guard that enforces it drift apart. `auth` imports nothing from
  // `organizations`, so the graph stays acyclic.
  "organizations:auth",
]);

// All module names (directory names under src/modules/).
export const ALL_MODULES = [
  "adoption",
  // custodia-temporal. ZERO new ALLOWED_EDGES by design: the module mirrors
  // NewNotification/UseCaseResult locally instead of importing `pets`, and the
  // owner cockpit reads caretaker state via a PAGE-level import (app/** is
  // outside the module graph) rather than through a `pets` use-case — that
  // import is the one edge that would invert this fence.
  "caretakers",
  "cases",
  "events",
  "foster",
  "lost",
  "organizations",
  "panorama",
  "pets",
  // rehome-by-titular: the titular's consent request + the org's accept/decline.
  "rehome",
  "surveillance",
  "transfers",
  "welfare",
] as const;

// Regex to extract a module import target from an import statement.
// Matches @/src/modules/<moduleName> in both static and dynamic import forms.
const MODULE_IMPORT_RE = /@\/src\/modules\/([a-z]+)/g;

export type EdgeViolation = {
  file: string;
  line: number;
  fromModule: string;
  toModule: string;
  importPath: string;
};

// Derive which module a source file belongs to from its path.
// Returns undefined if the path is not under src/modules/<module>/.
export function moduleFromPath(filePath: string): string | undefined {
  const normalized = filePath.replaceAll("\\", "/");
  const m = normalized.match(/src\/modules\/([a-z]+)\//);
  return m ? m[1] : undefined;
}

// Scan a single file for cross-module imports that violate the allowed edges.
export function findViolations(filePath: string, src: string): EdgeViolation[] {
  const fromModule = moduleFromPath(filePath);
  if (!fromModule) return [];

  const violations: EdgeViolation[] = [];
  const lines = src.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Reset lastIndex before each exec loop.
    MODULE_IMPORT_RE.lastIndex = 0;
    for (let m = MODULE_IMPORT_RE.exec(line); m !== null; m = MODULE_IMPORT_RE.exec(line)) {
      const toModule = m[1];
      if (toModule === fromModule) continue; // self-import, fine
      const edge = `${fromModule}:${toModule}`;
      if (!ALLOWED_EDGES.has(edge)) {
        violations.push({
          file: filePath.replaceAll("\\", "/"),
          line: i + 1,
          fromModule,
          toModule,
          importPath: m[0],
        });
      }
    }
  }

  return violations;
}

// All TypeScript/TSX files under src/modules/ (excluding test files so the
// check reflects production import edges, not test-fixture coupling).
export function listModuleFiles(): string[] {
  return globSync("src/modules/**/*.{ts,tsx}")
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
    .sort();
}

function runScan(): void {
  const files = listModuleFiles();
  if (files.length === 0) {
    console.error("✗ check-dependency-direction: no files found under src/modules/.");
    process.exit(1);
  }

  const allViolations: EdgeViolation[] = [];
  for (const file of files) {
    allViolations.push(...findViolations(file, readFileSync(file, "utf8")));
  }

  if (allViolations.length > 0) {
    for (const v of allViolations) {
      console.error(
        `${v.file}:${v.line} — forbidden cross-module import: ${v.fromModule} → ${v.toModule} ("${v.importPath}"). Add the edge to ALLOWED_EDGES in scripts/check-dependency-direction.ts with a justification comment if this edge is intentional.`,
      );
    }
    console.error(
      `\n✗ ${allViolations.length} forbidden cross-module import(s). ` +
        `Allowed edges: ${[...ALLOWED_EDGES].join(", ")}.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ Dependency direction clean — ${files.length} module files scanned; ` +
      `all cross-module edges are within the allowed set (${ALLOWED_EDGES.size} edges).`,
  );
}

// Guard: only scan when run directly; importing from tests exposes helpers
// without triggering the filesystem scan.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-dependency-direction.ts") ||
    process.argv[1].endsWith("check-dependency-direction.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
