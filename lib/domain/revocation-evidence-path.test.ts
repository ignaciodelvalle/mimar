import { describe, expect, it } from "vitest";

import { buildRevocationEvidencePath } from "@/lib/domain/revocation-evidence-path";

describe("buildRevocationEvidencePath (C23 — target-namespaced evidence)", () => {
  const fixedNow = () => 1_700_000_000_000;
  const fixedRand = () => "abc123";

  it("namespaces the object under the TARGET id, not the actor", () => {
    const path = buildRevocationEvidencePath("target-uuid", "proof.pdf", fixedNow, fixedRand);
    expect(path.startsWith("target-uuid/")).toBe(true);
    expect(path).toBe("target-uuid/1700000000000-abc123.pdf");
  });

  it("preserves the original file extension", () => {
    expect(buildRevocationEvidencePath("t", "scan.PNG", fixedNow, fixedRand)).toBe(
      "t/1700000000000-abc123.PNG",
    );
    expect(buildRevocationEvidencePath("t", "report.jpeg", fixedNow, fixedRand)).toBe(
      "t/1700000000000-abc123.jpeg",
    );
  });

  it("falls back to 'bin' when there is no extension", () => {
    expect(buildRevocationEvidencePath("t", "noext", fixedNow, fixedRand)).toBe(
      "t/1700000000000-abc123.bin",
    );
    expect(buildRevocationEvidencePath("t", "trailingdot.", fixedNow, fixedRand)).toBe(
      "t/1700000000000-abc123.bin",
    );
  });

  it("uses only the last extension for multi-dot names", () => {
    expect(buildRevocationEvidencePath("t", "a.b.tar.gz", fixedNow, fixedRand)).toBe(
      "t/1700000000000-abc123.gz",
    );
  });

  it("produces unique paths for repeated calls (timestamp + random suffix)", () => {
    let n = 0;
    const seq = () => 1_700_000_000_000 + n++;
    let r = 0;
    const seqRand = () => `r${r++}`;
    const a = buildRevocationEvidencePath("t", "x.pdf", seq, seqRand);
    const b = buildRevocationEvidencePath("t", "x.pdf", seq, seqRand);
    expect(a).not.toBe(b);
  });
});
