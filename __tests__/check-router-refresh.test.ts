/**
 * Unit tests for scripts/check-router-refresh.ts (lint:nav).
 *
 * Pure fixture tests — no filesystem I/O.
 *
 * Two rules are pinned here, and the second one exists because the fence used
 * to be narrower than its own docblock: the header named router.push and
 * router.replace as the same App Router silent-drop defect, and the regex only
 * matched router.refresh(. The run printed "0 runtime router.refresh() calls"
 * over a tree holding 24 push/replace call sites.
 */

import { describe, expect, it } from "vitest";

import {
  ROUTER_REFRESH_ALLOWLIST,
  findNavCalls,
  findOffenders,
  ratchetNavCalls,
} from "@/scripts/check-router-refresh";

describe("findOffenders — router.refresh() is an absolute ban", () => {
  it("flags a runtime router.refresh() call", () => {
    const offenders = findOffenders("components/X.tsx", "  router.refresh();\n");
    expect(offenders).toHaveLength(1);
    expect(offenders[0].line).toBe(1);
  });

  it("flags the chained useRouter().refresh() form", () => {
    expect(findOffenders("components/X.tsx", "useRouter().refresh();")).toHaveLength(1);
  });

  it("ignores a comment documenting the ban", () => {
    const src = [
      "// Never call router.refresh() here — the transition can drop.",
      "doThing();",
    ].join("\n");
    expect(findOffenders("components/X.tsx", src)).toEqual([]);
  });

  it("ships with an EMPTY allowlist", () => {
    expect([...ROUTER_REFRESH_ALLOWLIST]).toEqual([]);
  });
});

describe("findNavCalls — router.push() / router.replace()", () => {
  it("flags push and replace, both direct and chained", () => {
    const src = [
      "router.push('/a');",
      "router.replace('/b');",
      "useRouter().push('/c');",
      "useRouter().replace('/d');",
    ].join("\n");
    expect(findNavCalls("components/X.tsx", src)).toHaveLength(4);
  });

  it("ignores push/replace named only in a comment", () => {
    // Verbatim shapes from components/ui/VaulSheet.tsx and
    // src/modules/events/application/quick-capture/quick-capture.ts — a raw grep
    // counts both, which is how the pre-baseline hand count came out at 25.
    const src = [
      "/**",
      " * Deep-link aware: `onClose` typically calls router.push(buildCloseSheetUrl(x)).",
      " */",
      "//   { url: string }  — caller should router.push(url)",
      "export const x = 1;",
    ].join("\n");
    expect(findNavCalls("components/X.tsx", src)).toEqual([]);
  });

  it("does NOT lose a call site to a `//` inside a string literal", () => {
    // Regression pin for the local comment-stripper this file used to carry: it
    // cut the line at the first `//` anywhere, string contents included, and
    // silently swallowed everything after it.
    const src = 'logUrl("a//b"); router.push("/x");';
    expect(findNavCalls("components/X.tsx", src)).toHaveLength(1);
  });

  it("does not confuse an unrelated .push() with a router transition", () => {
    expect(findNavCalls("components/X.tsx", "offenders.push({ file });")).toEqual([]);
  });
});

describe("ratchetNavCalls — growth fails, shrinkage does not", () => {
  const call = (file: string) => ({ file, line: 1, text: "router.push('/a');" });

  it("passes when a file stays at its baselined count", () => {
    expect(ratchetNavCalls({ "a.tsx": 1 }, { "a.tsx": [call("a.tsx")] })).toEqual([]);
  });

  it("passes when a file DROPS below its baseline (a migration landed)", () => {
    expect(ratchetNavCalls({ "a.tsx": 3 }, { "a.tsx": [call("a.tsx")] })).toEqual([]);
  });

  it("fails when a baselined file grows", () => {
    const problems = ratchetNavCalls({ "a.tsx": 1 }, { "a.tsx": [call("a.tsx"), call("a.tsx")] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("The debt grew");
  });

  it("fails when a NEW file introduces a call site", () => {
    const problems = ratchetNavCalls({}, { "new.tsx": [call("new.tsx")] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("NOT baselined");
  });
});
