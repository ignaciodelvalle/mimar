/**
 * The nine use-cases that dropped `import "server-only"` (native-readiness
 * T1.3) must still be unimportable from a Client Component.
 *
 * WHY THIS TEST EXISTS
 * ---------------------------------------------------------------------------
 * The marker was never the protection — it was A protection, and a redundant
 * one. Each of these files reaches an infrastructure module that declares
 * `server-only` itself (db/index.ts, the events repository, the notification
 * service), so a "use client" file importing any of them still fails the build
 * with the same error, from the same mechanism, one hop further in.
 *
 * That argument is the entire justification for removing the marker, and an
 * argument that lives only in a commit message is an argument nobody re-checks.
 * If a future refactor cuts the last infrastructure edge out of one of these
 * modules, the marker's absence stops being free — and this test is what says
 * so, instead of a Client Component pulling the Postgres driver into a browser
 * bundle and nobody noticing until the bundle analyzer.
 *
 * The fence in biome.json forbids putting the marker back (it belongs in
 * infrastructure or actions, ADR 2026-07-18), so "just re-add it" is not the
 * fix if this fails: give the module an infrastructure edge, or move the work.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The nine de-marked use-cases. */
const DE_MARKED = [
  "src/modules/cases/application/reactivate-lost-search.ts",
  "src/modules/events/application/clinical/record-disease-diagnosis-use-case.ts",
  "src/modules/events/application/clinical/route-outbreak-signal-notifications.ts",
  "src/modules/events/application/lifecycle/death-record-use-case.ts",
  "src/modules/events/application/lifecycle/set-pet-found-use-case.ts",
  "src/modules/events/application/lifecycle/set-pet-lost-use-case.ts",
  "src/modules/events/application/lifecycle/update-lost-last-seen-use-case.ts",
  "src/modules/events/application/surveillance/symptom-observed-use-case.ts",
  "src/modules/events/application/writers.ts",
] as const;

const REPO_ROOT = resolve(__dirname, "..");

const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Resolve an app-alias or relative specifier to a file on disk, or null. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = resolve(REPO_ROOT, specifier.slice(2));
  else if (specifier.startsWith("./") || specifier.startsWith("../"))
    base = resolve(dirname(fromFile), specifier);
  else return null; // bare package — not our graph

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    base,
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The first module reachable from `entry` (excluding `entry` itself) that
 * declares `server-only`, or null.
 */
function serverOnlyAncestor(entry: string): string | null {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const src = readFileSync(file, "utf8");
    if (file !== entry && /^\s*import\s+["']server-only["']/m.test(src)) {
      return file.replace(/\\/g, "/").slice(REPO_ROOT.length + 1);
    }
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((m = IMPORT_RE.exec(src))) {
      const specifier = m[1] ?? m[2];
      if (!specifier) continue;
      const target = resolveSpecifier(specifier, file);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return null;
}

describe("de-marked application use-cases keep their client-bundle protection", () => {
  it.each(DE_MARKED)("%s still reaches a server-only module", (file) => {
    const abs = resolve(REPO_ROOT, file);
    expect(existsSync(abs)).toBe(true);
    expect(serverOnlyAncestor(abs)).not.toBeNull();
  });

  it("none of them carries the marker any more", () => {
    // The other half of the claim: if the import came back, the fence would be
    // failing too, and this list would be silently testing nothing.
    const stillMarked = DE_MARKED.filter((f) =>
      /^\s*import\s+["']server-only["']/m.test(readFileSync(resolve(REPO_ROOT, f), "utf8")),
    );
    expect(stillMarked).toEqual([]);
  });
});
