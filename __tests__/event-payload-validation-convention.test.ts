// §4.4 — convention enforcement.
//
// `validateEventPayload(eventType, payload)` returns a PARSED payload with
// `payload_version: 1` filled in when missing. Callers MUST use the return
// value — discarding it and re-inserting the original `payload` writes a row
// without the version field, defeating the upcaster contract.
//
// This test greps every `app/actions/*.ts` and `lib/**/*.ts` file (excluding
// tests and the validator itself) for lines that call `validateEventPayload`
// at the start of a statement, with no `=` or `return` before the call —
// i.e. the return value is discarded.
//
// Allowed patterns (return is captured or forwarded):
//   const x = validateEventPayload(...)
//   return validateEventPayload(...)
//   somefn(validateEventPayload(...))
//
// Flagged pattern (return discarded):
//   validateEventPayload(...)    // bare expression statement
//
// This is a regex-based linter, not a real AST analyzer — same approach as
// the §4.1 server-actions-auth-coverage convention test. Trade-off: it can
// be fooled by a multi-line call where the assignment lives several lines
// up, but in this codebase every call fits on the same line as its
// assignment (the writers pass an inline object literal as the second arg).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

// Files that contain `validateEventPayload(...)` and are excluded from the
// convention check:
//   - lib/event-schemas.ts itself defines the function.
//   - Test files are out of scope (they intentionally exercise the validator).
const EXCLUDE_FILES = new Set<string>([join("lib", "event-schemas.ts")]);

function isExcluded(relPath: string): boolean {
  if (EXCLUDE_FILES.has(relPath)) return true;
  if (relPath.endsWith(".test.ts")) return true;
  if (relPath.endsWith(".d.ts")) return true;
  return false;
}

// Recursively list every `.ts` file under the given directory (relative to repo root).
function listTsFiles(dirRel: string): string[] {
  const abs = join(REPO_ROOT, dirRel);
  const out: string[] = [];
  const stack: string[] = [abs];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    const entries = readdirSync(cur);
    for (const entry of entries) {
      const full = join(cur, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      const rel = relative(REPO_ROOT, full).replaceAll("\\", "/");
      if (isExcluded(rel.replaceAll("/", "\\"))) continue;
      if (isExcluded(rel)) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

// A discarded call is a line whose first non-whitespace token is the function
// name followed by `(`. Lines that are part of a larger expression (with `=`,
// `return`, `,`, or `(` before the name) all have something other than
// whitespace at the start.
const DISCARDED_CALL_RE = /^\s*validateEventPayload\s*\(/;

// Lines that mention validateEventPayload but should NOT be flagged. (Imports
// and type-only references.)
const IMPORT_RE = /^\s*import\b/;

describe("§4.4 — validateEventPayload return value is captured at every callsite", () => {
  const files = [...listTsFiles("app/actions"), ...listTsFiles("lib")].filter((rel) =>
    readFileSync(join(REPO_ROOT, rel), "utf8").includes("validateEventPayload"),
  );

  it("finds at least one source file that calls validateEventPayload", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const rel of files) {
    it(`${rel}: no discarded validateEventPayload() return values`, () => {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      const lines = src.split("\n");
      const offenders: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (IMPORT_RE.test(line)) continue;
        if (!DISCARDED_CALL_RE.test(line)) continue;
        offenders.push(
          `${rel}:${i + 1} — validateEventPayload(...) return value is discarded. Assign it: \`const eventPayload = validateEventPayload(...)\` — the parsed payload fills in payload_version: 1, which the row insert MUST use.`,
        );
      }

      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }
});
