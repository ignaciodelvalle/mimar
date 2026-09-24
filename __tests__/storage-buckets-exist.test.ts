/**
 * Every storage bucket the code writes to must be a bucket the SQL creates.
 *
 * WHY THIS EXISTS. On 2026-08-10 an adversarial review found that
 * `ATTACHMENT_BUCKET` — the destination for ALL decomiso evidence — was
 * `"pet-attachments"`, a bucket that exists in neither the local database nor
 * staging. Evidence is a hard server-side requirement (`validateAttachments`
 * demands >= 2 files) and the upload runs before the transaction opens, so
 * every decomiso in the product's history would have died on its first step
 * with `Bucket not found`. Nobody noticed: the 408 seeded `custody_episode`
 * rows were written by script, skipping the action entirely.
 *
 * The string appeared in exactly ONE place in the whole repo — the constant
 * itself. Nothing could have caught it: not typecheck (it is a string), not a
 * unit test (none exercised the upload), not the fences (none look at storage).
 * The only thing that would have is what this test does — cross the names the
 * code uses against the names the schema creates.
 *
 * The bucket list is PARSED from db/**.sql, not typed here. A test that
 * restates the answer cannot detect the answer changing.
 */

import { globSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DECOMISO_EVIDENCE_BUCKET,
  decomisoEvidenceRowPath,
  eventAttachmentLocation,
} from "@/lib/infra/attachment-location";
import { DECOMISO_EVIDENCE_MIME_LIST, MAX_DECOMISO_EVIDENCE_BYTES } from "@/lib/media/limits";
import { DECOMISO_EVIDENCE_TYPES } from "@/lib/media/validate";
import { ATTACHMENT_BUCKET, MAX_ATTACHMENT_BYTES } from "@/src/modules/decomiso/domain/types";

/** Bucket ids created by the schema, parsed from the storage migrations. */
function declaredBuckets(): Set<string> {
  const files = [...globSync("db/*storage*.sql"), ...globSync("db/migrations/*.sql")];
  const out = new Set<string>();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/storage\.buckets[\s\S]{0,400}?values\s*\(\s*'([a-z0-9-]+)'/gi)) {
      out.add(m[1]);
    }
  }
  return out;
}

/**
 * Bucket names written as literals at a `storage.from(...)` call site.
 * Extracted from source so a new hardcoded upload target is covered without
 * anyone remembering to add it here.
 */
function literalBucketsInCode(): Map<string, string[]> {
  const files = [
    ...globSync("app/**/*.{ts,tsx}"),
    ...globSync("lib/**/*.{ts,tsx}"),
    ...globSync("src/**/*.{ts,tsx}"),
  ].filter((f) => !f.includes("node_modules") && !/\.(test|spec)\./.test(f));

  const out = new Map<string, string[]>();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/storage\s*\.from\(\s*"([a-z0-9-]+)"\s*\)/g)) {
      const list = out.get(m[1]) ?? [];
      list.push(file.replace(/\\/g, "/"));
      out.set(m[1], list);
    }
  }
  return out;
}

const DECLARED = declaredBuckets();

describe("storage buckets", () => {
  it("parses a non-empty set of buckets from the SQL (or this test proves nothing)", () => {
    expect(DECLARED.size).toBeGreaterThan(0);
    expect(DECLARED.has("event-attachments")).toBe(true);
  });

  // The regression itself.
  it("decomiso evidence uploads to a bucket that exists", () => {
    expect(DECLARED.has(ATTACHMENT_BUCKET)).toBe(true);
  });

  // The bucket the upload targets must also be the one the signer reads, or the
  // rows land in `attachments` and no surface can ever render them.
  // Since D10 (PO 2026-09-18) the evidence bucket is not event-attachments: the
  // signer routes by the row path's prefix (lib/infra/attachment-location.ts),
  // so the pin is that the path the action records resolves back to the bucket
  // it uploaded to — and that the signer actually routes through the resolver.
  it("decomiso evidence lands in the bucket lib/infra/storage.ts signs", () => {
    expect(ATTACHMENT_BUCKET).toBe(DECOMISO_EVIDENCE_BUCKET);
    expect(eventAttachmentLocation(decomisoEvidenceRowPath("dir/acta.pdf"))).toEqual({
      bucket: ATTACHMENT_BUCKET,
      objectPath: "dir/acta.pdf",
    });
    // Legacy evidence (before 0234) still resolves to event-attachments.
    expect(eventAttachmentLocation("decomiso/dir/foto.jpg")).toEqual({
      bucket: "event-attachments",
      objectPath: "decomiso/dir/foto.jpg",
    });
    const signer = readFileSync("lib/infra/storage.ts", "utf8");
    expect(signer).toContain("eventAttachmentLocation(storagePath)");
  });

  // The places that state the evidence ceiling and type list must agree with
  // the bucket 0234 declares: a client limit that disagrees with the bucket
  // moves the failure to after the officer filled the whole form.
  it("decomiso-evidence bounds agree across the migration, the server and the form", () => {
    const sql = readFileSync("db/migrations/0234_decomiso_evidence_bucket.sql", "utf8");
    expect(DECLARED.has(DECOMISO_EVIDENCE_BUCKET)).toBe(true);
    expect(MAX_ATTACHMENT_BYTES).toBe(MAX_DECOMISO_EVIDENCE_BYTES);
    expect(sql).toContain(`  ${MAX_DECOMISO_EVIDENCE_BYTES},`);
    const mimeArray = DECOMISO_EVIDENCE_MIME_LIST.map((m) => `'${m}'`).join(", ");
    expect(sql).toContain(`array[${mimeArray}]`);
    // The server's byte-detected whitelist is the same list the form offers.
    expect(Object.keys(DECOMISO_EVIDENCE_TYPES)).toEqual([...DECOMISO_EVIDENCE_MIME_LIST]);
  });

  it("every hardcoded storage.from(...) target exists", () => {
    const missing: string[] = [];
    for (const [bucket, files] of literalBucketsInCode()) {
      if (!DECLARED.has(bucket)) missing.push(`${bucket} (${files.join(", ")})`);
    }
    expect(
      missing,
      `These buckets are written to in code but created nowhere in db/**.sql:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("scans a non-empty corpus", () => {
    expect(literalBucketsInCode().size).toBeGreaterThan(0);
  });
});
