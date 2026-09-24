// Every org page that asks for a capability must USE the answer.
//
// The hole this fence closes (reviewer, 2026-08-22): `mensajes/page.tsx`
// called `requireCapability("member.invite", …)` and threw the result away.
// The resolver returns a failure, it never throws, so the call was decoration:
// any member of the org — any role, no grant — could open the inbox and read a
// third party's name, email and free text. The file's own header asserted the
// opposite. `lint:authz` reads action files and route handlers, not pages, so
// nothing saw it.
//
// The subject, not the spelling: a page that calls `requireCapability(` binds
// the result (`const auth = await requireCapability(`) and checks
// `auth.error !== null` before rendering anything. Discarding the await,
// binding without checking, or checking a different name all fail here.
//
// Blind spots, stated: a check that exists but sits AFTER the data fetch is
// not detected (order is not modelled); a page that delegates the gate to a
// helper that itself discards the result is not detected (one hop only).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const ORG_APP_DIR = join(ROOT, "app", "org");

/** Pages known to gate on a capability today. A new page is covered
 *  automatically; removing one from this list is a deliberate edit. */
const KNOWN_GATED_PAGES = [
  "app/org/[orgToken]/adopciones/[appEventId]/page.tsx",
  "app/org/[orgToken]/adopciones/page.tsx",
  "app/org/[orgToken]/checkins/page.tsx",
  "app/org/[orgToken]/mascotas/[publicToken]/transfer/page.tsx",
  "app/org/[orgToken]/mensajes/page.tsx",
  "app/org/[orgToken]/mordedura/nuevo/page.tsx",
  "app/org/[orgToken]/transferencias/nueva/page.tsx",
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

function walkPages(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkPages(full, acc);
    else if (entry === "page.tsx") acc.push(full);
  }
  return acc;
}

const CALL = /\brequireCapability\(/g;
const BOUND = /\bconst\s+(\w+)\s*=\s*await\s+requireCapability\(/g;

type Problem =
  | { kind: "discarded"; calls: number; bound: number }
  | { kind: "unchecked"; name: string };

/** The rule as a function, so the controls below can prove it bites. */
function capabilityGateProblems(source: string): Problem[] {
  const src = stripComments(source);
  const calls = (src.match(CALL) ?? []).length;
  const names = [...src.matchAll(BOUND)].map((m) => m[1]);
  const problems: Problem[] = [];
  if (calls !== names.length) {
    problems.push({ kind: "discarded", calls, bound: names.length });
  }
  for (const name of names) {
    const checked = new RegExp(`\\b${name}\\.error\\s*!==\\s*null`).test(src);
    if (!checked) problems.push({ kind: "unchecked", name });
  }
  return problems;
}

describe("app/org/**/page.tsx — a capability gate is bound and checked", () => {
  const gated = walkPages(ORG_APP_DIR)
    .filter((f) => /\brequireCapability\(/.test(stripComments(readFileSync(f, "utf8"))))
    .map((f) => relative(ROOT, f).split(sep).join("/"))
    .sort();

  it("covers every page known to gate on a capability (non-vacuity)", () => {
    for (const known of KNOWN_GATED_PAGES) expect(gated).toContain(known);
    expect(gated.length).toBeGreaterThanOrEqual(KNOWN_GATED_PAGES.length);
  });

  it.each(gated)("%s binds the result and checks .error before rendering", (rel) => {
    const problems = capabilityGateProblems(readFileSync(join(ROOT, rel), "utf8"));
    expect(problems).toEqual([]);
  });
});

describe("the rule itself (controls)", () => {
  it("flags a discarded await", () => {
    const page = `await requireCapability("x", organization.id, { access: "read" });`;
    expect(capabilityGateProblems(page)).toEqual([{ kind: "discarded", calls: 1, bound: 0 }]);
  });

  it("flags a bound result whose .error is never checked", () => {
    const page = `const auth = await requireCapability("x", organization.id);\nreturn auth;`;
    expect(capabilityGateProblems(page)).toEqual([{ kind: "unchecked", name: "auth" }]);
  });

  it("flags a check against a different name", () => {
    const page = `const auth = await requireCapability("x", id);\nif (other.error !== null) return null;`;
    expect(capabilityGateProblems(page)).toEqual([{ kind: "unchecked", name: "auth" }]);
  });

  it("passes the canonical shape, and ignores a comment quoting the bad one", () => {
    const page = [
      '// await requireCapability("x", id); — the old shape, quoted',
      `const auth = await requireCapability("x", organization.id, { access: "read" });`,
      "if (auth.error !== null) return null;",
    ].join("\n");
    expect(capabilityGateProblems(page)).toEqual([]);
  });
});
