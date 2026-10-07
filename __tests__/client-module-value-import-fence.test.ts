// No App Router entry file may import a non-component VALUE from a "use client"
// module.
//
// THE DEFECT. A server component that imports from a "use client" module does
// not receive the module's exports: it receives CLIENT REFERENCES. A component
// reference renders fine; a function or a constant does not exist on the
// server, and calling it throws at request time — "Attempted to call X() from
// the server but X is on the client". tsc, biome, every lint and `next build`
// were all green over exactly that on 2026-10-07: /viaje's page.tsx called
// `isShortcutCorridor` from the "use client" TripForm.tsx, and only an e2e run
// against `pnpm start` saw the production error screen (commit 93e7b8605).
//
// THE RULE, as narrow as the defect. The scanned importers are the App Router
// ENTRY files (page, layout, template, default, not-found, loading, route) and
// "use server" action files — files that are server code by construction, so a
// hit is never a client-only helper that merely lacks the directive. A named
// import from a "use client" module must be PascalCase (a component); anything
// else — a camelCase function, an ALL_CAPS constant — is a violation. Type-only
// imports are erased and always fine.
//
// The cure for a hit: move the value to a module WITHOUT "use client" and
// import it from there on both sides (see viaje/trip-form-options.ts).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const ROOTS = ["app", "components", "src", "lib"];

const ENTRY = /(?:^|[\\/])(?:page|layout|template|default|not-found|loading|route)\.tsx?$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
    const parent = entry.parentPath ?? dir;
    if (parent.includes("node_modules")) continue;
    out.push(join(parent, entry.name));
  }
  return out;
}

/** The file's first statement is a directive: "use client" / "use server". */
function directiveOf(source: string): "client" | "server" | null {
  const head = source.replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  if (/^["']use client["']/.test(head)) return "client";
  if (/^["']use server["']/.test(head)) return "server";
  return null;
}

/** Resolves an import specifier to a repo file, or null (a package, a miss). */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(fromFile, "..", spec);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every `import { a, b as c, type T } from "x"` value name, per specifier. */
function namedValueImports(source: string): { spec: string; names: string[] }[] {
  const out: { spec: string; names: string[] }[] = [];
  const re = /import\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    if (!m[1]) {
      const names = m[2]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("type "))
        .map((s) => s.split(/\s+as\s+/)[0].trim());
      out.push({ spec: m[3], names });
    }
    m = re.exec(source);
  }
  return out;
}

/** A component name: PascalCase with at least one lowercase letter. */
function isComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name);
}

type Violation = { file: string; spec: string; name: string };

function scan(): { violations: Violation[]; entries: number; clientModules: number } {
  const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
  const directive = new Map<string, "client" | "server" | null>();
  const sourceOf = new Map<string, string>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    sourceOf.set(f, src);
    directive.set(f, directiveOf(src));
  }
  const importers = files.filter((f) => ENTRY.test(f) || directive.get(f) === "server");
  const violations: Violation[] = [];
  let entries = 0;
  for (const file of importers) {
    if (directive.get(file) === "client") continue; // a client entry (rare) imports freely
    entries++;
    for (const { spec, names } of namedValueImports(sourceOf.get(file) ?? "")) {
      const target = resolveSpecifier(file, spec);
      if (!target || directive.get(target) !== "client") continue;
      for (const name of names) {
        if (!isComponentName(name)) violations.push({ file, spec, name });
      }
    }
  }
  const clientModules = [...directive.values()].filter((d) => d === "client").length;
  return { violations, entries, clientModules };
}

describe("server entry files never import a non-component value from a 'use client' module", () => {
  it("finds none", () => {
    const { violations, entries, clientModules } = scan();
    // Non-vacuity: the scan saw the tree it is about.
    expect(entries).toBeGreaterThan(200);
    expect(clientModules).toBeGreaterThan(200);
    expect(
      violations.map((v) => `${v.file.slice(ROOT.length + 1)}: ${v.name} from "${v.spec}"`),
    ).toEqual([]);
  });
});

describe("the detector itself", () => {
  it("reads the directive past comments", () => {
    expect(directiveOf('// header\n/* more */\n"use client";\nimport x')).toBe("client");
    expect(directiveOf("'use server';")).toBe("server");
    expect(directiveOf('import "x";\n"use client";')).toBe(null);
  });

  it("collects value names and skips type-only ones", () => {
    expect(
      namedValueImports(
        'import { TripForm, isShortcutCorridor as ok, type Props } from "./TripForm";\nimport type { T } from "./x";',
      ),
    ).toEqual([{ spec: "./TripForm", names: ["TripForm", "isShortcutCorridor"] }]);
  });

  it("calls a component a component, and nothing else", () => {
    expect(isComponentName("TripForm")).toBe(true);
    expect(isComponentName("isShortcutCorridor")).toBe(false);
    expect(isComponentName("OTHER_COUNTRY")).toBe(false);
    expect(isComponentName("URL")).toBe(false);
  });
});
