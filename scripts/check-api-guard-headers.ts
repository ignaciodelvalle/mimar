// check-api-guard-headers — no /api route may authorize on a middleware-stamped
// header (B51, native-readiness RN-8 #2).
//
// THE DEFECT THIS EXISTS FOR
// ---------------------------------------------------------------------------
// middleware.ts stamps request headers that server code reads back: `x-nonce`,
// `x-pathname`, `x-full-path`, `x-portal-base`. They are convenient and they are
// NOT a security input. Two reasons:
//
//   1. THEY DEFAULT SILENTLY. lib/ui/portal-base.ts is the live example RN-8
//      found: `headers().get("x-portal-base")` with `value === "/admin" ? … :
//      "/gob"`. A MISSING header does not error — it resolves to /gob. On a link
//      builder that is a cosmetic bug. On a guard it is an authorization
//      decision made by the absence of a header.
//   2. THE STAMP IS NOT GUARANTEED. middleware.ts carries a `matcher`, and the
//      headers are set on the REQUEST. Anything that reaches a handler outside
//      that matcher — a rewrite, an internal invocation, a future runtime
//      change — arrives with none of them, and a caller can send their own
//      `x-portal-base` freely.
//
// The repo's authorization invariant is that authority is 100% DB-resolved
// (zero `auth.jwt()` across 276 RLS policies). A header-derived default is the
// same class of mistake as a claim-derived one: a value the request influences,
// deciding what the caller may do.
//
// WHAT IS BANNED, AND WHY IT IS THE SUBJECT AND NOT A SPELLING
// ---------------------------------------------------------------------------
// In any Route Handler, READING a middleware-stamped header at all — directly, or
// through a module whose job is to read one. Not "reading it with `??`", not
// "reading it with a ternary": banning the FORMS is how a fence ends up
// enumerating three of the four ways to write a default. Banning the read is
// unambiguous, and an /api route that genuinely needs the path has `request.url`
// and its own route params, which are not spoofable-by-omission.
//
// The header NAMES are derived from middleware.ts at scan time, never listed
// here. Add a `request.headers.set("x-whatever", …)` to the middleware and this
// fence covers it on the next run with no edit.
//
// The WRAPPER form is derived too: any module under lib/ or components/ that
// reads a stamped header becomes a "reader module", and a handler file that
// IMPORTS one is flagged. That is what catches `portalBase()` without this file
// ever naming it.
//
// STATUS AT INTRODUCTION: zero offenders. This fence is preventive — it lands
// green and stays honest because of the floors below, not because nothing is
// wrong today.
//
// Run: pnpm tsx scripts/check-api-guard-headers.ts   (or: pnpm lint:api-headers)

import { globSync, readFileSync } from "node:fs";

import { stripComments } from "./lib/strip-comments.mjs";

export const MIDDLEWARE_PATH = "middleware.ts";

// Non-vacuity floors. A fence that scans nothing reports success; these make a
// broken glob or a moved middleware fail LOUDLY instead of silently passing.
// Measured 2026-08-21: 5 stamped headers, 49 scannable files — 36 under
// app/api plus 13 route.ts elsewhere. Floors sit below the measurement with
// room for churn, and above zero.
export const MIN_STAMPED_HEADERS = 3;
export const MIN_API_FILES_SCANNED = 30;

// THE FLOOR THAT PROTECTS THE WIDENING, and the reason it is separate from the
// one above. This fence used to glob app/api/** alone, which left 13 route
// handlers — both auth callbacks among them — outside a guard whose whole
// subject is route handlers. A single total-count floor does NOT catch a
// regression to that scope: dropping the 13 takes the total from 49 to 36,
// still comfortably over 30, and the fence goes back to reporting success
// while covering less. Counting the out-of-/api handlers separately is the
// only floor that fails when the glob narrows again.
export const MIN_NON_API_HANDLERS = 8;

// Documented exceptions: `"<relPath>"` → reason. Use ONLY when the value is
// provably not an authorization input AND cannot be obtained from the request
// itself. Empty is the goal, and it is empty.
export const ALLOWLIST: Record<string, string> = {};

/**
 * Per-module, PER-HEADER exemptions for the wrapper form.
 *
 * Scoped to one header name in one module on purpose. Exempting the whole
 * module would mean a future stamped-header read added to the same file
 * inherits the pass — which is how an exemption quietly becomes a hole. Any
 * OTHER stamped header read in an exempt module still flags.
 *
 * The bar is the one this file's header sets: the value must be provably not an
 * authorization input, and unobtainable from the request itself. A Server
 * Component guard has no request object, so `headers()` is the only door.
 */
export const READER_MODULE_HEADER_EXEMPT: Record<string, readonly string[]> = {
  // `x-full-path` here feeds ONE thing: the `returnTo` hint on a login bounce,
  // so an operator whose session expired mid-triage lands back on the deep link
  // instead of bare /login. It is a DESTINATION, never a permission — every
  // authorization fact in this module comes from getProfileCached (role,
  // accountType, deactivatedAt), all DB-resolved. Absence degrades to bare
  // /login, which is the cosmetic case this file's header explicitly separates
  // from "an authorization decision made by the absence of a header".
  //
  // The open-redirect question is closed on the consuming side, not assumed:
  // safeReturnTo (lib/infra/role-landing.ts:204) rejects anything that does not
  // start with a single "/" and anything containing a backslash, so a caller
  // who forges x-full-path cannot steer the post-login redirect off-origin.
  "lib/infra/auth-guards.ts": ["x-full-path"],
};

/**
 * Every header middleware.ts stamps on the REQUEST.
 *
 * Derived, not listed. `response.headers.set(...)` is deliberately excluded —
 * those go out to the browser and are never read back by server code.
 */
export function stampedRequestHeaders(middlewareSource: string): string[] {
  const code = stripComments(middlewareSource);
  const names = [...code.matchAll(/request\.headers\.set\(\s*["'`]([^"'`]+)["'`]/g)].map((m) =>
    m[1].toLowerCase(),
  );
  return [...new Set(names)].sort();
}

/** A `.get("<name>")` read of any of `headerNames`, ignoring comments. */
export function readsStampedHeader(source: string, headerNames: readonly string[]): string[] {
  const code = stripComments(source);
  const hits = new Set<string>();
  for (const name of headerNames) {
    // `.get(` with the header name as a string literal, any quoting, any casing
    // — HTTP header names are case-insensitive and Next's Headers.get() is too.
    const re = new RegExp(`\\.get\\s*\\(\\s*["'\`]${name.replace(/-/g, "-")}["'\`]`, "i");
    if (re.test(code)) hits.add(name);
  }
  return [...hits].sort();
}

/** Files whose PURPOSE includes reading a stamped header — the wrapper form. */
export function listReaderModules(headerNames: readonly string[]): string[] {
  const candidates = ["lib/**/*.ts", "lib/**/*.tsx", "components/**/*.ts", "components/**/*.tsx"];
  const out: string[] = [];
  for (const pattern of candidates) {
    for (const file of globSync(pattern)) {
      const relPath = file.replaceAll("\\", "/");
      if (!isScannable(relPath)) continue;
      const exempt = READER_MODULE_HEADER_EXEMPT[relPath] ?? [];
      const hits = readsStampedHeader(readFileSync(file, "utf8"), headerNames).filter(
        (h) => !exempt.includes(h),
      );
      if (hits.length > 0) out.push(relPath);
    }
  }
  return out.sort();
}

/** Import specifiers a source pulls in, normalized from the `@/` alias. */
export function importedModulePaths(source: string): string[] {
  const code = stripComments(source);
  return [...code.matchAll(/from\s+["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((spec) => spec.startsWith("@/"))
    .map((spec) => spec.slice(2));
}

function isScannable(relPath: string): boolean {
  if (relPath.includes("__tests__")) return false;
  if (/\.test\.[jt]sx?$/.test(relPath)) return false;
  return !relPath.endsWith(".d.ts");
}

/**
 * EVERY route handler, not every file under one URL prefix.
 *
 * This used to glob `app/api/**` alone, and that scope was the same mistake the
 * header of this file argues against one paragraph up: it fenced a SPELLING of
 * "endpoint" rather than the subject. A Route Handler is a `route.ts`, wherever
 * the App Router finds it, and 13 of them live outside /api — including
 * `app/auth/callback/route.ts` and `app/auth/miarg/callback/route.ts`, the two
 * places where a spoofable authorization input would matter most.
 *
 * Still globs all of app/api/** on top, because the helpers there (_guard.ts and
 * friends) are reachable from handlers and were already covered.
 */
export function listApiFiles(): string[] {
  const files = new Set<string>([...globSync("app/api/**/*.ts"), ...globSync("app/**/route.ts")]);
  return [...files]
    .map((f) => f.replaceAll("\\", "/"))
    .filter(isScannable)
    .sort();
}

/**
 * Offender lines for one /api file. `readerModules` are the extension-less
 * module paths (relative to root) whose import counts as an indirect read.
 */
export function findOffenders(
  relPath: string,
  source: string,
  headerNames: readonly string[],
  readerModules: readonly string[],
): string[] {
  if (ALLOWLIST[relPath] !== undefined) return [];

  const offenders: string[] = [];

  const direct = readsStampedHeader(source, headerNames);
  if (direct.length > 0) {
    offenders.push(
      `${relPath} — reads middleware-stamped header(s) ${direct.join(", ")}. A missing stamp resolves to whatever default the expression carries, so the ABSENCE of a header becomes the decision (RN-8: x-portal-base defaults to /gob). An /api handler must derive path/portal from request.url or its own route params, and must fail closed on anything it cannot derive.`,
    );
  }

  const imported = new Set(importedModulePaths(source));
  for (const reader of readerModules) {
    const withoutExt = reader.replace(/\.(ts|tsx)$/, "");
    if (imported.has(withoutExt) || imported.has(reader)) {
      offenders.push(
        `${relPath} — imports ${reader}, whose job is reading a middleware-stamped header with a default. Indirect is the same defect: the /api handler still ends up deciding on a value the request can omit.`,
      );
    }
  }

  return offenders;
}

function runScan(): void {
  const middlewareSource = readFileSync(MIDDLEWARE_PATH, "utf8");
  const headerNames = stampedRequestHeaders(middlewareSource);

  if (headerNames.length < MIN_STAMPED_HEADERS) {
    console.error(
      `✗ check-api-guard-headers: found only ${headerNames.length} stamped request header(s) in ${MIDDLEWARE_PATH} (floor ${MIN_STAMPED_HEADERS}). Either the middleware moved or the extraction broke — a fence that finds nothing to look for is a fence that always passes.`,
    );
    process.exit(1);
  }

  const apiFiles = listApiFiles();
  if (apiFiles.length < MIN_API_FILES_SCANNED) {
    console.error(
      `✗ check-api-guard-headers: scanned only ${apiFiles.length} route handler file(s) (floor ${MIN_API_FILES_SCANNED}). The glob is broken.`,
    );
    process.exit(1);
  }

  const nonApiHandlers = apiFiles.filter((f) => !f.startsWith("app/api/"));
  if (nonApiHandlers.length < MIN_NON_API_HANDLERS) {
    console.error(
      `✗ check-api-guard-headers: only ${nonApiHandlers.length} route handler(s) outside app/api were scanned (floor ${MIN_NON_API_HANDLERS}). The glob narrowed back to the /api prefix — see MIN_NON_API_HANDLERS.`,
    );
    process.exit(1);
  }

  const readerModules = listReaderModules(headerNames);

  const offenders: string[] = [];
  for (const file of apiFiles) {
    offenders.push(...findOffenders(file, readFileSync(file, "utf8"), headerNames, readerModules));
  }

  if (offenders.length > 0) {
    console.error(offenders.join("\n"));
    console.error(
      `\n✗ ${offenders.length} /api file(s) authorizing on a middleware-stamped header.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ api-guard-headers clean — ${apiFiles.length} route handler files (${nonApiHandlers.length} of them outside app/api, including both auth callbacks), none reading any of the ${headerNames.length} middleware-stamped headers (${headerNames.join(", ")}) directly or through the ${readerModules.length} reader module(s).`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-api-guard-headers.ts") ||
    process.argv[1].endsWith("check-api-guard-headers.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
