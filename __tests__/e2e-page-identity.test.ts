// Unit tests for e2e/_page-identity.ts — the two predicates that decide
// whether a smoke gate is allowed to report green.
//
// WHY A UNIT TEST FOR E2E LOGIC. Playwright specs do not run under Vitest, so
// anything defined inside a `.spec.ts` is logic nobody can exercise without a
// server. Both bugs this module fixes (P2.3, P2.4) were assertions that COULD
// NOT FAIL, and neither would have been caught by running the suite — they were
// green. They are caught here, cheaply, on every `pnpm test`.
//
// The not-found block is a PARITY test in the shape of
// __tests__/seed-case-guards.test.ts: it parses the REAL app/**/not-found.tsx
// files rather than restating their copy, so adding a boundary with new wording
// (or editing an existing one) turns this red instead of silently disarming
// every e2e gate that calls assertRealPage().

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BRANDED_NOT_FOUND_TESTID,
  BRANDED_NOT_FOUND_TITLES,
  CRASH_BOUNDARY,
  FRAMEWORK_NOT_FOUND_TITLE,
  NOT_FOUND_HEADING,
  describePiiLeaks,
  findPiiLeaks,
} from "../e2e/_page-identity";

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Discover every not-found boundary in the app tree
// ---------------------------------------------------------------------------

function findNotFoundFiles(dir: string, acc: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".next") continue;
      findNotFoundFiles(full, acc);
    } else if (ent.name === "not-found.tsx") {
      acc.push(full);
    }
  }
  return acc;
}

/** The `title=` prop each boundary passes to BrandedNotFound. */
function titleOf(source: string): string | null {
  return source.match(/title="([^"]+)"/)?.[1] ?? null;
}

const NOT_FOUND_FILES = findNotFoundFiles(join(ROOT, "app"));
const BRANDED_NOT_FOUND_SRC = readFileSync(join(ROOT, "components", "BrandedNotFound.tsx"), "utf8");

describe("NOT_FOUND_HEADING matches every boundary in app/**", () => {
  it("finds the boundaries at all (a zero-file sweep would pass vacuously)", () => {
    // The precise failure class this whole module exists to kill: a check whose
    // input set is empty reports success. Five boundaries exist today — root,
    // (app), (public), admin, gob.
    expect(NOT_FOUND_FILES.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of NOT_FOUND_FILES) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
    it(`${rel} — its heading is recognised as a not-found boundary`, () => {
      const title = titleOf(readFileSync(file, "utf8"));
      // A boundary with no explicit title inherits BrandedNotFound's default,
      // which is itself in the list.
      const effective = title ?? "No encontramos esta página";
      expect(
        NOT_FOUND_HEADING.test(effective),
        `"${effective}" is a real 404 heading that assertRealPage() would NOT recognise. Add it to BRANDED_NOT_FOUND_TITLES in e2e/_page-identity.ts — otherwise every gate that calls assertRealPage() will happily measure this 404 and report green.`,
      ).toBe(true);
    });
  }

  it("covers the (public) credential boundary specifically — the one A7 missed", () => {
    // Regression pin for the actual defect: A7's private assertRealPage matched
    // only /no encontramos esta página/i, so on /p/[token] — a (public) route —
    // it did not recognise the boundary it was written to catch.
    const publicNotFound = NOT_FOUND_FILES.find((f) =>
      f.replace(/\\/g, "/").includes("app/(public)/not-found.tsx"),
    );
    expect(publicNotFound, "app/(public)/not-found.tsx exists").toBeTruthy();
    const title = titleOf(readFileSync(publicNotFound as string, "utf8"));
    expect(title).toBe("No encontramos esa credencial");
    expect(NOT_FOUND_HEADING.test(title as string)).toBe(true);
    expect(/no encontramos esta página/i.test(title as string), "A7's pattern misses it").toBe(
      false,
    );
  });

  it("declares BrandedNotFound's own default", () => {
    const fallback = BRANDED_NOT_FOUND_SRC.match(/title = "([^"]+)"/)?.[1];
    expect(fallback, "BrandedNotFound has a default title").toBeTruthy();
    expect(NOT_FOUND_HEADING.test(fallback as string)).toBe(true);
  });

  it("BrandedNotFound carries the copy-independent testid the guard keys on", () => {
    expect(BRANDED_NOT_FOUND_SRC).toContain(`data-testid="${BRANDED_NOT_FOUND_TESTID}"`);
  });

  it("still matches Next.js's untranslated default", () => {
    expect(NOT_FOUND_HEADING.test(FRAMEWORK_NOT_FOUND_TITLE)).toBe(true);
  });
});

describe("NOT_FOUND_HEADING does not fire on real pages", () => {
  // A guard that flags real pages is as useless as one that flags nothing — it
  // gets deleted the first time it blocks a green run.
  const REAL_HEADINGS = [
    "Adoptar en miMAR",
    "Mascotas perdidas",
    "Refugios y redes de rescate",
    "Credencial pública",
    "Centro de Situación Nacional",
    // The /perdidas EMPTY STATE, which contains "No encontramos" but is a
    // legitimate render of a legitimate page.
    "No encontramos mascotas perdidas con esos filtros.",
  ];

  for (const heading of REAL_HEADINGS) {
    it(`"${heading}" is not treated as a 404`, () => {
      expect(NOT_FOUND_HEADING.test(heading)).toBe(false);
    });
  }

  it("BRANDED_NOT_FOUND_TITLES has no empty entry", () => {
    // An empty needle would make the regex match everything.
    for (const t of BRANDED_NOT_FOUND_TITLES) expect(t.trim()).not.toBe("");
  });
});

describe("CRASH_BOUNDARY", () => {
  it("matches the error copy the app and Next.js render", () => {
    expect(CRASH_BOUNDARY.test("Application error: a client-side exception has occurred")).toBe(
      true,
    );
    expect(CRASH_BOUNDARY.test("Algo salió mal")).toBe(true);
  });

  it("does not match ordinary page copy", () => {
    expect(CRASH_BOUNDARY.test("Credencial pública de Pampa, verificable por QR.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findPiiLeaks
// ---------------------------------------------------------------------------

const OWNER = {
  displayName: "Lucía Tester",
  email: "owner@dim.test",
  phone: "+54 9 11 5555-1001",
} as const;

const CLEAN_CREDENTIAL =
  "<html><head><title>Pampa | Credencial miMAR</title></head><body>" +
  "<h1>Pampa</h1><p>Credencial pública</p><p>Perro · Buenos Aires · La Plata</p>" +
  "<p>DIM-PAMP-0001</p></body></html>";

describe("findPiiLeaks — the assertion that has to be able to fail", () => {
  it("reports nothing on a credential that leaks nothing", () => {
    expect(findPiiLeaks(CLEAN_CREDENTIAL, OWNER)).toEqual([]);
  });

  it("CATCHES a leaked display name", () => {
    const leaked = CLEAN_CREDENTIAL.replace("<h1>Pampa</h1>", "<h1>Pampa — Lucía Tester</h1>");
    const leaks = findPiiLeaks(leaked, OWNER);
    expect(leaks).toEqual([{ field: "displayName", needle: "Lucía Tester", match: "literal" }]);
  });

  it("CATCHES a leaked email", () => {
    const leaked = CLEAN_CREDENTIAL.replace("</body>", "<a>owner@dim.test</a></body>");
    expect(findPiiLeaks(leaked, OWNER).map((l) => l.field)).toEqual(["email"]);
  });

  it("CATCHES a leaked phone in the profile's own formatting", () => {
    const leaked = CLEAN_CREDENTIAL.replace("</body>", "<p>+54 9 11 5555-1001</p></body>");
    expect(findPiiLeaks(leaked, OWNER)).toEqual([
      { field: "phone", needle: "+54 9 11 5555-1001", match: "literal" },
    ]);
  });

  it("CATCHES a leaked phone that was reformatted — a tel: href", () => {
    // The real leak shape: app/(public)/p/[publicToken]/page.tsx builds
    // `tel:${normalizePhoneForTel(phone)}`, which strips the spaces and dash. A
    // literal substring check would miss it entirely.
    const leaked = CLEAN_CREDENTIAL.replace(
      "</body>",
      '<a href="tel:+5491155551001">Llamar</a></body>',
    );
    expect(findPiiLeaks(leaked, OWNER)).toEqual([
      { field: "phone", needle: "5491155551001", match: "digits" },
    ]);
  });

  it("is case-insensitive on names and emails", () => {
    const leaked = CLEAN_CREDENTIAL.replace("</body>", "<p>LUCÍA TESTER</p></body>");
    expect(findPiiLeaks(leaked, OWNER).map((l) => l.field)).toEqual(["displayName"]);
  });

  it("reports every field that leaked, not just the first", () => {
    const leaked = CLEAN_CREDENTIAL.replace(
      "</body>",
      "<p>Lucía Tester · owner@dim.test · +54 9 11 5555-1001</p></body>",
    );
    expect(findPiiLeaks(leaked, OWNER).map((l) => l.field)).toEqual([
      "displayName",
      "email",
      "phone",
    ]);
  });

  it("THE ORIGINAL BUG: a hardcoded persona name cannot fail", () => {
    // e2e/synthetic-monitor.spec.ts asserted the page did not contain
    // "Ignacio del Valle" while the account under test was "Lucía Tester". This
    // reproduces that: with the wrong owner, the page below leaks in full and
    // the check still comes back clean.
    const fullyLeaking = CLEAN_CREDENTIAL.replace(
      "</body>",
      "<p>Lucía Tester · owner@dim.test · +54 9 11 5555-1001</p></body>",
    );
    const wrongOwner = {
      displayName: "Ignacio del Valle",
      email: "ignacio@example.com",
      phone: null,
    };
    expect(findPiiLeaks(fullyLeaking, wrongOwner)).toEqual([]);
    // …and the same page, checked against the REAL owner, trips all three.
    expect(findPiiLeaks(fullyLeaking, OWNER)).toHaveLength(3);
  });

  it("skips the phone when the account has none, instead of matching everything", () => {
    // `body.includes("")` is true for every page. A null phone must be skipped,
    // not searched for — otherwise the monitor fails permanently and gets muted.
    expect(findPiiLeaks(CLEAN_CREDENTIAL, { ...OWNER, phone: null })).toEqual([]);
    expect(findPiiLeaks(CLEAN_CREDENTIAL, { ...OWNER, phone: "   " })).toEqual([]);
  });

  it("ignores a phone too short to be distinguishable from an id", () => {
    expect(findPiiLeaks("<p>order 1001</p>", { ...OWNER, phone: "1001" })).toEqual([]);
  });

  it("THROWS on a blank display name or email rather than degrading silently", () => {
    expect(() => findPiiLeaks(CLEAN_CREDENTIAL, { ...OWNER, displayName: "" })).toThrow(
      /displayName is blank/,
    );
    expect(() => findPiiLeaks(CLEAN_CREDENTIAL, { ...OWNER, email: "  " })).toThrow(
      /email is blank/,
    );
  });

  it("describePiiLeaks names the field and the value", () => {
    const leaked = CLEAN_CREDENTIAL.replace("</body>", "<p>Lucía Tester</p></body>");
    expect(describePiiLeaks(findPiiLeaks(leaked, OWNER))).toBe(
      "displayName (literal): Lucía Tester",
    );
  });
});
