// Every case writer stores the catalogue row of the place it names
// (localidades CABA + Córdoba, 2026-10, change C2).
//
// With `scope` and `routing` on the id path, a case that carries a locality
// NAME but no `locality_id` is unresolved: only whole-province holders see it,
// and no municipal or comuna holder does. The lost writer's home fallback kept
// the home name and dropped its id, which hid 15 CABA lost cases from the
// Palermo holder on staging; several other writers never passed an id at all.
//
// So every `openCase(` call either names `localityId` in the input it builds,
// or sits in a file allowlisted below with an exact call count, a reason, and
// a SHAPE the scan checks:
//   - "place-less": the case carries no jurisdiction pair at all, so it has no
//     id to carry — and the call must indeed name no `jurisdictionLocality`;
//   - "forwarder": a composition root or the helper that forwards a use
//     case's input unchanged — the call must not build an object literal (the
//     use case's own call, which does, is scanned on its own).
//
// Scanned: app, lib, src, scripts (TypeScript, not tests); comments stripped.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CALL_RE = /\b(?:openCase|libOpenCase)\(/g;

type Allowed = { calls: number; shape: "place-less" | "forwarder"; reason: string };

const WITHOUT_ID: Readonly<Record<string, Allowed>> = {
  "src/modules/adoption/infrastructure/adoption-repository.ts": {
    calls: 2,
    shape: "place-less",
    reason: "adoption_listing / adoption_application cases carry no jurisdiction pair at all",
  },
  "lib/infra/case-helpers.ts": {
    calls: 1,
    shape: "forwarder",
    reason: "the helper itself: forwards (...args) to CasesRepository.openCase",
  },
  "src/modules/welfare/actions.ts": {
    calls: 2,
    shape: "forwarder",
    reason: "composition root: forwards create(-org)-welfare-report's input unchanged",
  },
  "src/modules/surveillance/actions.ts": {
    calls: 3,
    shape: "forwarder",
    reason: "composition root: forwards report-bite(-from-org) and outbreak input unchanged",
  },
  "app/api/v1/welfare-reports/commands.ts": {
    calls: 1,
    shape: "forwarder",
    reason: "composition root: forwards create-welfare-report's input unchanged",
  },
  "app/api/v1/pets/[publicToken]/events/append-special-kinds.ts": {
    calls: 1,
    shape: "forwarder",
    reason: "composition root: forwards report-bite's input unchanged",
  },
};

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__") walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
}

/** The text of the call's FIRST argument (up to its top-level comma or the closing paren). */
function firstArg(src: string, start: number): string {
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    const ch = src[i] as string;
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) break;
  }
  return src.slice(start, i);
}

type Call = { file: string; arg: string };

function scan(): Call[] {
  const files: string[] = [];
  for (const d of ["app", "lib", "src", "scripts"]) walk(join(ROOT, d), files);
  const calls: Call[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, "");
    const rel = relative(ROOT, f).split(sep).join("/");
    for (const m of src.matchAll(CALL_RE)) {
      const at = m.index ?? 0;
      // The method definition (`async openCase(input: …)`), not a call.
      if (/(?:async|function)\s+$/.test(src.slice(Math.max(0, at - 16), at))) continue;
      calls.push({ file: rel, arg: firstArg(src, at + m[0].length) });
    }
  }
  return calls;
}

/** Why an allowlisted call breaks its declared shape, or null when it keeps it. */
function shapeViolation(allowed: Allowed, c: Call): string | null {
  if (allowed.shape === "place-less" && /\bjurisdictionLocality\b/.test(c.arg)) {
    return `${c.file}: allowlisted as place-less but names jurisdictionLocality`;
  }
  if (allowed.shape === "forwarder" && c.arg.includes("{")) {
    return `${c.file}: allowlisted as a forwarder but builds its own input`;
  }
  return null;
}

function violations(calls: Call[]): string[] {
  const bad: string[] = [];
  const withoutId: Record<string, Call[]> = {};
  for (const c of calls) {
    if (!/\blocalityId\b/.test(c.arg)) withoutId[c.file] = [...(withoutId[c.file] ?? []), c];
  }
  for (const [file, list] of Object.entries(withoutId)) {
    const allowed = WITHOUT_ID[file];
    if (!allowed || allowed.calls !== list.length) {
      bad.push(`${file}: ${list.length} openCase call(s) without localityId`);
      continue;
    }
    for (const c of list) {
      const why = shapeViolation(allowed, c);
      if (why) bad.push(why);
    }
  }
  for (const [file, a] of Object.entries(WITHOUT_ID)) {
    const found = withoutId[file]?.length ?? 0;
    if (found !== a.calls) bad.push(`${file}: allowlist says ${a.calls}, found ${found}`);
  }
  return bad;
}

describe("every case writer stores the place's catalogue id", () => {
  const calls = scan();

  it("every openCase call passes localityId, or is allowlisted with a reason", () => {
    expect(violations(calls)).toEqual([]);
  });

  it("is not vacuous: it sees the writers it was written for", () => {
    // 27 calls, 17 of them naming localityId, on 2026-10-02.
    expect(calls.length).toBeGreaterThanOrEqual(25);
    expect(calls.filter((c) => /\blocalityId\b/.test(c.arg)).length).toBeGreaterThanOrEqual(17);
    const files = new Set(calls.map((c) => c.file));
    for (const writer of [
      "src/modules/events/application/lifecycle/set-pet-lost-use-case.ts",
      "src/modules/surveillance/application/report-bite.ts",
      "src/modules/surveillance/application/outbreak-investigation.ts",
      "src/modules/foster/infrastructure/foster-repository.ts",
    ]) {
      expect(files.has(writer), writer).toBe(true);
    }
  });
});
