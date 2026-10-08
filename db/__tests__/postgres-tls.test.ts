// TLS on every postgres.js client (security hotfix, 2026-10; db/tls.ts).
//
// Two halves:
//   1. The helper's matrix: loopback → no TLS, any other host → "require", an
//      explicit sslmode in the URL is honoured with postgres.js's own meaning,
//      and an explicit plaintext request on a remote host throws in production.
//   2. A fence over the whole repo: every `postgres(` call passes
//      `ssl: postgresTlsOption(<the same url>)` as the LAST word on `ssl` (no
//      spread after it can override it). postgres.js defaults to plaintext, so
//      a client that forgets is not an error anywhere — it just leaks. The fence
//      is non-vacuous twice over: planted violations must be caught, and the
//      scan must find at least the call sites that exist today.
//
// DB-free: nothing here opens a socket.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { isLoopbackDatabaseUrl, postgresTlsOption } from "@/db/tls";

const POOLER =
  "postgresql://postgres.abcdefghijklmnopqrst:secret@aws-1-sa-east-1.pooler.supabase.com:6543/postgres";
const DIRECT = "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres";
const DEV = { NODE_ENV: "development" };
const PROD = { NODE_ENV: "production" };
const VERCEL_PREVIEW = { NODE_ENV: "development", VERCEL_ENV: "preview" };

describe("postgresTlsOption — the matrix", () => {
  it.each([
    "postgresql://postgres:postgres@localhost:54322/postgres",
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "postgresql://postgres:postgres@[::1]:54322/postgres",
    "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
    "postgres://postgres:postgres@localhost:5432/postgres",
  ])("loopback (%s) gets no TLS, in dev and in production", (url) => {
    expect(isLoopbackDatabaseUrl(url)).toBe(true);
    expect(postgresTlsOption(url, DEV)).toBe(false);
    expect(postgresTlsOption(url, PROD)).toBe(false);
  });

  it.each([POOLER, DIRECT])("a remote host (%s) requires TLS", (url) => {
    expect(isLoopbackDatabaseUrl(url)).toBe(false);
    expect(postgresTlsOption(url, DEV)).toBe("require");
    expect(postgresTlsOption(url, PROD)).toBe("require");
  });

  it("names that only LOOK local still require TLS", () => {
    // The read-only fences treat `db` / host.docker.internal as local; TLS does not.
    for (const host of [
      "db",
      "host.docker.internal",
      "localhost.evil.example.com",
      "127.0.0.1.nip.io",
    ]) {
      expect(postgresTlsOption(`postgresql://u:p@${host}:5432/postgres`, PROD)).toBe("require");
    }
  });

  it("an unparseable URL is treated as remote", () => {
    expect(postgresTlsOption("not a url at all", PROD)).toBe("require");
  });

  it("an absent URL returns false (the never-queried missing-url pool)", () => {
    expect(postgresTlsOption(undefined, PROD)).toBe(false);
    expect(postgresTlsOption("", PROD)).toBe(false);
  });

  it("an explicit sslmode in the URL wins, with postgres.js's meaning", () => {
    expect(postgresTlsOption(`${POOLER}?sslmode=verify-full`, PROD)).toBe("verify-full");
    expect(postgresTlsOption(`${POOLER}?sslmode=require`, PROD)).toBe("require");
    expect(postgresTlsOption(`${POOLER}?sslmode=prefer`, DEV)).toBe("prefer");
    expect(postgresTlsOption(`${POOLER}?ssl=true`, DEV)).toBe("true");
    // sslmode is copied over ssl, and sslrootcert=system forces verify-full.
    expect(postgresTlsOption(`${POOLER}?ssl=false&sslmode=require`, PROD)).toBe("require");
    expect(postgresTlsOption(`${POOLER}?sslmode=require&sslrootcert=system`, PROD)).toBe(
      "verify-full",
    );
    // A local URL may ask for TLS too.
    expect(
      postgresTlsOption("postgresql://u:p@127.0.0.1:54322/postgres?sslmode=require", PROD),
    ).toBe("require");
  });

  it("sslmode=disable is honoured on loopback, and on a remote host outside production", () => {
    expect(
      postgresTlsOption("postgresql://u:p@localhost:54322/postgres?sslmode=disable", PROD),
    ).toBe(false);
    expect(postgresTlsOption(`${POOLER}?sslmode=disable`, DEV)).toBe(false);
  });

  it.each([
    ["NODE_ENV=production", PROD],
    ["any VERCEL_ENV", VERCEL_PREVIEW],
  ])("plaintext on a remote host THROWS in production (%s)", (_label, env) => {
    expect(() => postgresTlsOption(`${POOLER}?sslmode=disable`, env)).toThrow(/NO TLS/);
    expect(() => postgresTlsOption(`${DIRECT}?ssl=false`, env)).toThrow(/NO TLS/);
  });

  it("the refusal never echoes the password", () => {
    let message = "";
    try {
      postgresTlsOption(`${POOLER}?sslmode=disable`, PROD);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("pooler.supabase.com");
    expect(message).not.toContain("secret");
  });
});

// ---------------------------------------------------------------------------
// The fence.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "../..");
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAwaitExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** `import("postgres")` or `require("postgres")`, optionally awaited and `.default`-ed. */
function loadsPostgresModule(init: ts.Expression): boolean {
  let expr = unwrap(init);
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "default") {
    expr = unwrap(expr.expression);
  }
  if (!ts.isCallExpression(expr)) return false;
  const [arg] = expr.arguments;
  const loader =
    expr.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(expr.expression) && expr.expression.text === "require");
  return loader && arg !== undefined && ts.isStringLiteralLike(arg) && arg.text === "postgres";
}

/** Local names bound to postgres.js's default export in this file. */
function postgresBindings(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "postgres" &&
      node.importClause &&
      !node.importClause.isTypeOnly
    ) {
      if (node.importClause.name) names.add(node.importClause.name.text);
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if ((el.propertyName ?? el.name).text === "default") names.add(el.name.text);
        }
      }
    }
    // const postgres = (await import("postgres")).default;  /  require("postgres")
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      loadsPostgresModule(node.initializer)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

const norm = (text: string): string => text.replace(/\s+/g, "");

type Scan = { calls: number; violations: string[] };

/** Every postgres() call in `source` that does not end on `ssl: postgresTlsOption(<url>)`. */
function scanSource(fileName: string, source: string): Scan {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const names = postgresBindings(sf);
  const result: Scan = { calls: 0, violations: [] };
  if (names.size === 0) return result;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.has(node.expression.text)
    ) {
      result.calls += 1;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const [url, options] = node.arguments;
      const fail = (why: string) => result.violations.push(`${fileName}:${line} — ${why}`);
      if (!url || !options || !ts.isObjectLiteralExpression(options)) {
        fail("second argument must be an object literal carrying `ssl: postgresTlsOption(url)`");
      } else {
        const props = options.properties;
        const sslIndex = props.findIndex(
          (p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "ssl",
        );
        const ssl = props[sslIndex];
        const init = ssl && ts.isPropertyAssignment(ssl) ? ssl.initializer : undefined;
        if (
          !init ||
          !ts.isCallExpression(init) ||
          init.expression.getText(sf) !== "postgresTlsOption" ||
          init.arguments.length < 1 ||
          norm(init.arguments[0].getText(sf)) !== norm(url.getText(sf))
        ) {
          fail("missing `ssl: postgresTlsOption(<the same url>)`");
        } else if (props.slice(sslIndex + 1).some((p) => ts.isSpreadAssignment(p))) {
          fail("a spread after `ssl` could override it; put `ssl` last");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

function repoSourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => SOURCE_EXT.test(f) && !f.includes("node_modules/"));
}

describe("every postgres() client passes the TLS option", () => {
  it("the fence catches planted violations (non-vacuity)", () => {
    const planted = [
      // no options at all
      `import postgres from "postgres";\nconst a = postgres(url);`,
      // options without ssl
      `import postgres from "postgres";\nconst a = postgres(url, { max: 1 });`,
      // options built elsewhere
      `import postgres from "postgres";\nconst a = postgres(url, opts(1));`,
      // hard-coded ssl
      `import postgres from "postgres";\nconst a = postgres(url, { ssl: false });`,
      // the helper fed a DIFFERENT url
      `import postgres from "postgres";\nconst a = postgres(url, { ssl: postgresTlsOption(other) });`,
      // a spread after ssl can override it
      `import postgres from "postgres";\nconst a = postgres(url, { ssl: postgresTlsOption(url), ...o });`,
      // aliased import
      `import pg from "postgres";\nconst a = pg(url, { max: 1 });`,
      // dynamic import
      `const postgres = (await import("postgres")).default;\nconst a = postgres(url, {});`,
      // CommonJS
      `const pg = require("postgres");\nconst a = pg(url, { max: 1 });`,
    ];
    for (const source of planted) {
      const scan = scanSource("planted.ts", source);
      expect(scan.calls, source).toBe(1);
      expect(scan.violations, source).toHaveLength(1);
    }
    const good = `import postgres from "postgres";\nconst a = postgres(url, { ...o, max: 1, ssl: postgresTlsOption(url) });`;
    expect(scanSource("good.ts", good)).toEqual({ calls: 1, violations: [] });
  });

  it("no postgres() call site in the repo is missing it", () => {
    let calls = 0;
    const violations: string[] = [];
    for (const file of repoSourceFiles()) {
      let source: string;
      try {
        source = readFileSync(path.join(ROOT, file), "utf8");
      } catch {
        continue; // deleted in the working tree but still in the index
      }
      if (!source.includes("postgres")) continue;
      const scan = scanSource(file, source);
      calls += scan.calls;
      violations.push(...scan.violations);
    }
    expect(violations).toEqual([]);
    // Floor: 54 call sites when the fence was written. A scan that suddenly
    // finds far fewer is looking at the wrong tree, not a cleaner one.
    expect(calls).toBeGreaterThanOrEqual(50);
  });
});
