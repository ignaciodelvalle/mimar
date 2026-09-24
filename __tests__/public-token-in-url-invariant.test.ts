// An internal id must never travel in a route segment that declares a public one.
//
// THE GAP THIS CLOSES, AND WHY link-integrity.test.ts COULD NOT
// ---------------------------------------------------------------------------
// That file answers one question: does this link resolve to a route that
// exists? The four dead buttons found in the 2026-08-20 sweep all resolved.
// `/gob/casos/[publicCode]` is a real route, and `/gob/casos/${c.id}` matches
// its pattern perfectly. What was wrong was the VALUE — a UUID interpolated
// where the page looks up by public code, so the query finds nothing and the
// handler calls notFound(). One of them printed the correct code on screen two
// lines above the button that went nowhere.
//
// A resolver cannot see that. But the mismatch is still static: the route
// declares the NAME of what it expects (`[publicCode]`, `[publicToken]`) and
// the call site declares the name of what it passes (`c.id`, `row.caseId`). An
// `id` flowing into a `public*` slot is the shape of every one of those bugs.
//
// AND IT IS AN INVARIANT, NOT JUST A LINK CONCERN. Public-facing URLs carry
// public tokens precisely so internal UUIDs never leave the database. A UUID in
// a shareable URL is a leak whether or not the page happens to render.
//
// DERIVED, NOT LISTED. Parameter names come from walking app/; interpolations
// come from the source. A new route with a `[publicX]` segment is covered with
// no edit here — which is the difference between this and the guard that
// "covered the place the last bug was found in, not the concept".

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(REPO_ROOT, "app");
const SCAN_DIRS = ["app", "components", "lib", "src"];

function walkDir(dir: string, collect: (filePath: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, collect);
    else collect(full);
  }
}

/** The route's segments, with the dynamic parameter's NAME kept, not erased. */
function routeSegments(absolutePath: string): (string | null)[] {
  let rel = path.relative(APP_DIR, absolutePath).replace(/\\/g, "/");
  rel = rel === "page.tsx" || rel === "route.ts" ? "" : rel.replace(/\/(page\.tsx|route\.ts)$/, "");
  return rel
    .split("/")
    .filter((seg) => seg !== "" && !/^\([^)]+\)$/.test(seg))
    .map((seg) => {
      const dynamic = /^\[\.{0,3}([^\]]+)\]$/.exec(seg);
      // A dynamic segment yields its parameter name; a literal yields null so
      // the two can never be confused when matching below.
      return dynamic ? (dynamic[1] as string) : null;
    })
    .map((name, _i, _all) => (name === null ? null : name)) as (string | null)[];
}

/** Literal text of each segment, for prefix matching. */
function routeLiterals(absolutePath: string): string[] {
  let rel = path.relative(APP_DIR, absolutePath).replace(/\\/g, "/");
  rel = rel === "page.tsx" || rel === "route.ts" ? "" : rel.replace(/\/(page\.tsx|route\.ts)$/, "");
  return rel.split("/").filter((seg) => seg !== "" && !/^\([^)]+\)$/.test(seg));
}

type Route = { literals: string[]; params: (string | null)[] };

const ROUTES: Route[] = [];
walkDir(APP_DIR, (filePath) => {
  const base = path.basename(filePath);
  if (base !== "page.tsx" && base !== "route.ts") return;
  ROUTES.push({ literals: routeLiterals(filePath), params: routeSegments(filePath) });
});

/** A slot meant to hold a PUBLIC identifier, by the name the route gave it. */
function isPublicSlot(paramName: string | null): boolean {
  if (paramName === null) return false;
  return /^public/i.test(paramName) || /(Token|Code)$/.test(paramName);
}

/**
 * Does this interpolated expression name an INTERNAL id?
 *
 * Deliberately narrow: it reads the tail of the expression — `c.id`,
 * `row.caseId`, a bare `petId` — and nothing else. A guard that flagged every
 * expression it could not prove correct would be noise, and noise is how a
 * fence earns an allowlist and then gets ignored.
 */
function namesAnInternalId(expr: string): boolean {
  const tail =
    expr
      .trim()
      .split(/[.?[\]]/)
      .filter(Boolean)
      .pop() ?? "";
  return /^id$/i.test(tail) || /[a-z]Id$/.test(tail) || /^uuid$/i.test(tail);
}

type Link = { where: string; raw: string; segments: string[] };

function collectInterpolatedLinks(): Link[] {
  const found: Link[] = [];
  // A template literal that starts with "/" and interpolates at least once.
  // Not restricted to href= or ctaUrl: a destination assembled in a lib module
  // and rendered generically is exactly how the last batch escaped notice.
  const LINK_RE = /`(\/[^`]*\$\{[^`]*)`/g;
  for (const dir of SCAN_DIRS) {
    walkDir(path.join(REPO_ROOT, dir), (filePath) => {
      if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) return;
      if (filePath.includes(".test.")) return;
      const src = fs.readFileSync(filePath, "utf8");
      src.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(LINK_RE)) {
          const raw = m[1] as string;
          found.push({
            where: `${path.relative(REPO_ROOT, filePath).replaceAll("\\", "/")}:${i + 1}`,
            raw,
            segments: raw
              .split("?")[0]
              .split("/")
              .filter((s) => s !== ""),
          });
        }
      });
    });
  }
  return found;
}

/** The route whose shape agrees with this link, longest literal prefix first. */
function matchRoute(segments: string[]): Route | null {
  const candidates = ROUTES.filter((r) => {
    if (r.literals.length !== segments.length) return false;
    return r.literals.every((lit, i) => {
      const seg = segments[i] as string;
      if (r.params[i] !== null) return true; // dynamic slot accepts anything
      return lit === seg;
    });
  });
  // Prefer the route with the most literal (non-dynamic) segments: a concrete
  // path beats one that only matched because everything was a parameter.
  return (
    candidates.sort(
      (a, b) =>
        b.params.filter((p) => p === null).length - a.params.filter((p) => p === null).length,
    )[0] ?? null
  );
}

const LINKS = collectInterpolatedLinks();

describe("public-token URL invariant", () => {
  // NON-VACUITY, both halves. A broken link regex or a broken route walk would
  // make the rule below pass over an empty set — the exact way the guards in
  // this repo have failed before.
  it("finds interpolated links to inspect", () => {
    // 932 on 2026-08-21. The floor sits well under it with room for churn and
    // far above zero — a regex that stopped matching would otherwise leave the
    // rule below grading an empty set and reporting success.
    expect(LINKS.length).toBeGreaterThan(500);
  });

  it("knows the parameter name behind the dynamic segments", () => {
    const named = ROUTES.flatMap((r) => r.params).filter((p): p is string => p !== null);
    expect(named.length).toBeGreaterThan(20);
    expect(named).toContain("publicToken");
    expect(named.some(isPublicSlot)).toBe(true);
  });

  it("recognises an internal id by name", () => {
    // The predicate itself, pinned. Too loose and the guard becomes noise; too
    // tight and it stops catching the shape it exists for.
    expect(namesAnInternalId("c.id")).toBe(true);
    expect(namesAnInternalId("row.caseId")).toBe(true);
    expect(namesAnInternalId("petId")).toBe(true);
    expect(namesAnInternalId("pet.publicToken")).toBe(false);
    expect(namesAnInternalId("c.publicCode")).toBe(false);
    expect(namesAnInternalId("token")).toBe(false);
  });

  it("never passes an internal id where the route declares a public one", () => {
    const offenders: string[] = [];

    for (const link of LINKS) {
      const route = matchRoute(link.segments);
      if (route === null) continue; // resolution is link-integrity.test.ts's job

      link.segments.forEach((seg, idx) => {
        const expr = /^\$\{([^}]*)\}$/.exec(seg)?.[1];
        if (expr === undefined) return;
        if (!isPublicSlot(route.params[idx] ?? null)) return;
        if (!namesAnInternalId(expr)) return;
        offenders.push(`${link.where} — "${link.raw}" pasa \`${expr}\` a [${route.params[idx]}]`);
      });
    }

    expect(
      offenders,
      `Un identificador interno viajando en un segmento que espera uno público:\n${offenders
        .map((o) => `  • ${o}`)
        .join(
          "\n",
        )}\n\nLa ruta resuelve, así que ninguna otra guarda lo ve: la página no encuentra nada y devuelve 404. Y un UUID en una URL compartible es una fuga aparte.`,
    ).toEqual([]);
  });
});
