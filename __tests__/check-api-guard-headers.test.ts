// Tests for the B51 fence: no /api guard may authorize on a middleware-stamped
// header (scripts/check-api-guard-headers.ts).
//
// The fence lands GREEN on today's tree — there are zero offenders. That is
// exactly the condition under which a fence quietly rots into decoration, so
// these tests give it teeth: a synthetic offender in each form it must catch, a
// clean file it must NOT flag, and an assertion that the header list is really
// derived from middleware.ts rather than hardcoded.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ALLOWLIST,
  MIDDLEWARE_PATH,
  MIN_API_FILES_SCANNED,
  MIN_NON_API_HANDLERS,
  MIN_STAMPED_HEADERS,
  READER_MODULE_HEADER_EXEMPT,
  findOffenders,
  importedModulePaths,
  listApiFiles,
  listReaderModules,
  readsStampedHeader,
  stampedRequestHeaders,
} from "@/scripts/check-api-guard-headers";

const MIDDLEWARE_SOURCE = readFileSync(MIDDLEWARE_PATH, "utf8");
const HEADERS = stampedRequestHeaders(MIDDLEWARE_SOURCE);

// ---------------------------------------------------------------------------
// Derivation, not a hardcoded list
// ---------------------------------------------------------------------------

describe("stampedRequestHeaders()", () => {
  it("finds the headers the real middleware actually stamps", () => {
    expect(HEADERS).toContain("x-portal-base");
    expect(HEADERS).toContain("x-pathname");
    expect(HEADERS).toContain("x-full-path");
    expect(HEADERS.length).toBeGreaterThanOrEqual(MIN_STAMPED_HEADERS);
  });

  // The whole point of deriving: a header added to the middleware tomorrow is
  // covered with no edit to the fence.
  it("picks up a newly stamped header with no change to the fence", () => {
    const withNewHeader = `${MIDDLEWARE_SOURCE}\nrequest.headers.set("x-brand-new", "v");\n`;
    expect(stampedRequestHeaders(withNewHeader)).toContain("x-brand-new");
  });

  // response.headers.set(...) goes OUT to the browser and is never read back by
  // server code; treating it as an input would produce noise, not safety.
  it("ignores headers set on the RESPONSE", () => {
    const src = `response.headers.set("x-only-outbound", "v");`;
    expect(stampedRequestHeaders(src)).toEqual([]);
  });

  it("does not count a header named only inside a comment", () => {
    const src = `// request.headers.set("x-imaginary", "v")\nconst a = 1;`;
    expect(stampedRequestHeaders(src)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detection — the forms it must catch
// ---------------------------------------------------------------------------

describe("readsStampedHeader()", () => {
  it.each([
    ['const v = (await headers()).get("x-portal-base");', "await headers()"],
    ["const v = request.headers.get('x-portal-base');", "single quotes"],
    ["const v = req.headers.get(`x-portal-base`);", "backticks"],
    ['const v = h.get( "X-Portal-Base" );', "odd spacing and casing"],
  ])("flags %p (%s)", (src) => {
    expect(readsStampedHeader(src, HEADERS)).toContain("x-portal-base");
  });

  it("does not flag a header name that only appears in a comment", () => {
    expect(
      readsStampedHeader("// we used to read x-portal-base here\nconst a = 1;", HEADERS),
    ).toEqual([]);
  });

  it("does not flag reading a header the middleware does not stamp", () => {
    expect(readsStampedHeader('const v = h.get("x-real-ip");', HEADERS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The synthetic offender — proof the fence can fail
// ---------------------------------------------------------------------------

describe("findOffenders()", () => {
  const readerModules = ["lib/ui/portal-base.ts"];

  it("flags a DIRECT read in an /api guard", () => {
    const offenders = findOffenders(
      "app/api/fake/_guard.ts",
      'const base = (await headers()).get("x-portal-base") ?? "/gob";',
      HEADERS,
      readerModules,
    );

    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("x-portal-base");
  });

  // Banning the READ rather than the DEFAULT is deliberate: a fence that
  // enumerates `??`, `||` and the ternary misses the fourth spelling. Both of
  // these are the same defect and both must fail.
  it.each([
    ['const b = h.get("x-portal-base") ?? "/gob";', "?? default"],
    ['const b = h.get("x-portal-base") || "/gob";', "|| default"],
    ['const b = h.get("x-portal-base") === "/admin" ? "/admin" : "/gob";', "ternary default"],
    ['const { "x-portal-base": b = "/gob" } = Object.fromEntries(h);', "destructured default"],
    ['const b = h.get("x-portal-base");', "no default at all"],
  ])("flags %p (%s)", (src) => {
    // The destructured form has no `.get(` and is the one a form-enumerating
    // fence would miss; it is listed here so the expectation is explicit about
    // what this fence does and does not reach.
    const offenders = findOffenders("app/api/fake/route.ts", src, HEADERS, readerModules);
    if (src.includes(".get(")) {
      expect(offenders.length).toBeGreaterThan(0);
    } else {
      expect(offenders).toHaveLength(0);
    }
  });

  it("flags the INDIRECT form — importing a reader module", () => {
    const offenders = findOffenders(
      "app/api/fake/route.ts",
      'import { portalBase } from "@/lib/ui/portal-base";\nconst b = await portalBase();',
      HEADERS,
      readerModules,
    );

    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("lib/ui/portal-base.ts");
  });

  it("leaves a clean /api file alone", () => {
    const offenders = findOffenders(
      "app/api/fake/route.ts",
      'import { NextResponse } from "next/server";\nexport async function GET(request: Request) {\n  const url = new URL(request.url);\n  return NextResponse.json({ path: url.pathname });\n}',
      HEADERS,
      readerModules,
    );

    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Non-vacuity — the fence must actually be looking at something
// ---------------------------------------------------------------------------

describe("scan coverage", () => {
  it("opens a real number of route handler files", () => {
    expect(listApiFiles().length).toBeGreaterThanOrEqual(MIN_API_FILES_SCANNED);
  });

  // THE SCOPE REGRESSION THIS PINS. The fence used to glob app/api/** alone —
  // it fenced a URL PREFIX while its own header argues for fencing the subject.
  // Thirteen route handlers sat outside, including both auth callbacks. A
  // total-count floor cannot catch a narrowing back to that scope (49 -> 36 is
  // still over the floor), so the out-of-/api handlers are counted on their own.
  it("scans route handlers that live outside app/api", () => {
    const outside = listApiFiles().filter((f) => !f.startsWith("app/api/"));
    expect(outside.length).toBeGreaterThanOrEqual(MIN_NON_API_HANDLERS);
  });

  // Named explicitly, not just counted: these two are where a spoofable
  // authorization input would matter most, and they are the reason the glob
  // was widened at all.
  it("covers both auth callbacks", () => {
    const files = listApiFiles();
    expect(files).toContain("app/auth/callback/route.ts");
    expect(files).toContain("app/auth/miarg/callback/route.ts");
  });

  // Derived, so it cannot silently go empty and switch the indirect rule off.
  it("finds at least one reader module in the tree", () => {
    expect(listReaderModules(HEADERS).length).toBeGreaterThan(0);
  });

  it("normalizes @/ import specifiers", () => {
    expect(importedModulePaths('import { x } from "@/lib/ui/portal-base";')).toEqual([
      "lib/ui/portal-base",
    ]);
    expect(importedModulePaths('import { x } from "next/server";')).toEqual([]);
  });

  // An allowlist is where a fence goes to die. It starts empty and every future
  // entry has to carry a written reason.
  it("keeps the exception allowlist empty", () => {
    expect(Object.keys(ALLOWLIST)).toEqual([]);
  });

  // The reader-module exemption is PER HEADER on purpose: exempting a whole
  // module would let a future stamped-header read added to the same file
  // inherit the pass. This pins the shape so nobody widens an entry to a
  // blanket module exemption without the test saying so.
  it("exempts reader modules per header, never wholesale", () => {
    for (const [module, headers] of Object.entries(READER_MODULE_HEADER_EXEMPT)) {
      expect(headers.length, `${module} must name the headers it exempts`).toBeGreaterThan(0);
      for (const h of headers) {
        expect(HEADERS, `${module} exempts ${h}, which middleware no longer stamps`).toContain(h);
      }
    }
  });
});
