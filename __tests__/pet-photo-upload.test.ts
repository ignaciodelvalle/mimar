// `lib/infra/pet-photo-upload.ts` — the half of the pet-photo door that decides
// what the BYTES are, tested against the real validator.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE ROUTE TEST
// ---------------------------------------------------------------------------
// `api-v1-pet-photo-route.test.ts` mocks this module, because what it proves is
// "an unauthorised caller never gets a ticket" and that is only observable if
// the primitive is a spy. The rules HERE — the path guard, the magic-byte check,
// the fail-closed re-encode — would be proved by nothing if they were tested
// through a mock of themselves.
//
// WHAT THIS FILE HAS TO PROVE
//   1. THE PATH GUARD IS A PREFIX EQUALITY against a server-resolved pet id, not
//      a pattern match. Another pet's staged key is refused even when it is
//      perfectly well-formed.
//   2. THE CONTENT CHECK IS THE BYTES. An SVG, an HTML document and a ZIP are
//      refused; the content type the ticket declared decides nothing.
//   3. THE RE-ENCODE FAILS CLOSED. sharp throwing means the photo is refused —
//      never a fallback to the original bytes, because the destination is a
//      PUBLIC bucket.
//   4. THE STAGED OBJECT IS DISCARDED on every path out, refusal included.
//   5. THE STORED KEY IS DERIVED FROM WHAT THE BYTES ARE, not what was declared.
//   6. THE TWO WHITELISTS AGREE — `@dim/contract/input`'s (which a phone reads)
//      and `lib/media/validate.ts`'s (which the server enforces). They are two
//      copies on purpose (the contract may not import the web app's lib), so
//      something has to hold them equal, and that something is this assertion
//      rather than anyone remembering.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { PET_PHOTO_CONTENT_TYPES } from "@dim/contract/input";

const PET_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PET_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const STAGED = `${PET_ID}/33333333-3333-4333-8333-333333333333.jpg`;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x41, 0x42]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', "utf8");
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>", "utf8");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);

const control = vi.hoisted(() => ({
  /** What `download` answers with. `null` is "no such object". */
  staged: null as Buffer | null,
  downloadError: false,
  /**
   * The `status` on the RETURNED download error, which is the whole of what
   * `isMissingObjectError` reads.
   *
   * 404 IS THE DEFAULT because that is what storage-api answers for a key that
   * is not there. `undefined` models a `StorageUnknownError` — a refused
   * connection, a DNS failure, a timeout — which is exactly the case that used
   * to be misread as "missing" and delete somebody's photo.
   */
  downloadStatus: 404 as number | undefined,
  uploadError: null as string | null,
  /** A failed cleanup, so the logging path has something to observe. */
  removeError: null as string | null,
  sharpThrows: false,
  /**
   * What sharp hands back. Overridden to drive the arm where a re-encode GROWS
   * past the bucket limit — an indexed-palette PNG re-encoded non-palettised.
   */
  sharpBytes: null as Buffer | null,
  /** The pet's current primary photo id, for the `replacedPrevious` arm. */
  primaryPhotoId: null as string | null,
  /** `false` makes the soft-delete-filtered select return no row at all. */
  petIsLive: true,
  /** The READ COMMITTED race: SELECT saw a live pet, the UPDATE matches zero rows. */
  erasedMidTransaction: false,
  txThrows: false,
  removed: [] as Array<{ bucket: string; paths: string[] }>,
  uploaded: [] as Array<{ bucket: string; path: string; contentType: string; bytes: number }>,
  inserted: [] as Array<Record<string, unknown>>,
}));

vi.mock("sharp", () => ({
  default: () => ({
    rotate: () => ({
      toBuffer: async () => {
        if (control.sharpThrows) throw new Error("unsupported image format");
        if (control.sharpBytes !== null) return control.sharpBytes;
        // Deliberately a DIFFERENT byte length from every input above, so an
        // assertion on the stored size cannot pass by coincidence.
        return Buffer.from("normalised-bytes-xyz");
      },
    }),
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUploadUrl: async (path: string) => ({
          data: { signedUrl: `https://storage.test/upload/${path}?token=tok`, token: "tok", path },
          error: null,
        }),
        download: async () =>
          control.downloadError || control.staged === null
            ? {
                data: null,
                // THE `status` IS PART OF THE ANSWER, because one consumer of
                // this mock branches on it. storage-js returns its errors
                // rather than throwing them, so a test that omitted the status
                // could not tell a missing key from a dead service — which is
                // precisely the confusion the code under test had.
                error: { message: "Object not found", status: control.downloadStatus },
              }
            : { data: { arrayBuffer: async () => control.staged as Buffer }, error: null },
        upload: async (path: string, body: Buffer, opts: { contentType: string }) => {
          if (control.uploadError) return { error: { message: control.uploadError } };
          control.uploaded.push({
            bucket,
            path,
            contentType: opts.contentType,
            bytes: body.byteLength,
          });
          return { error: null };
        },
        remove: async (paths: string[]) => {
          control.removed.push({ bucket, paths });
          // RESOLVES WITH AN ERROR, NEVER THROWS — the storage-js contract, and
          // the reason a `try/catch` around this call observes nothing.
          return { error: control.removeError ? { message: control.removeError } : null };
        },
      }),
    },
  }),
}));

vi.mock("@/db", () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (control.txThrows) throw new Error("deadlock detected");
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              // A soft-deleted pet does not match `isNull(pets.deletedAt)`, so
              // the real query returns ZERO rows rather than a row with a flag
              // on it. The mock has to model the absence, not a boolean.
              limit: async () =>
                control.petIsLive ? [{ primaryPhotoId: control.primaryPhotoId }] : [],
            }),
          }),
        }),
        insert: () => ({
          values: (row: Record<string, unknown>) => {
            control.inserted.push(row);
            return { returning: async () => [{ id: "att-1" }] };
          },
        }),
        // The pointer UPDATE now REPORTS its affected rows, and the mock has to
        // model that: `erasedMidTransaction` is the READ COMMITTED race where
        // the SELECT saw a live pet and the UPDATE's predicate matches nothing
        // because an erasure committed in between.
        update: () => ({
          set: () => ({
            where: () => ({
              returning: async () => (control.erasedMidTransaction ? [] : [{ id: PET_ID }]),
            }),
          }),
        }),
      };
      // THE FAKE ACTUALLY ROLLS BACK, and it has to. A drizzle transaction
      // undoes everything the callback did when the callback throws; a fake that
      // just pushed rows into an array would keep them, and the assertion "no
      // attachments row survived the erasure race" would be checking the mock's
      // sloppiness rather than the code's correctness. Snapshot, run, truncate
      // on throw.
      const inserted = control.inserted.length;
      try {
        return await fn(tx);
      } catch (err) {
        control.inserted.length = inserted;
        throw err;
      }
    },
  },
}));

// NO MOCK FOR `@/db/schema`, deliberately. The real module is pure drizzle table
// definitions — no connection, no side effect — and the fake `tx` below ignores
// the column objects it is handed anyway, so stubbing it bought nothing and made
// this the only file in the repo that replaced the shared schema module.

vi.mock("@/lib/infra/storage", () => ({
  petPhotoUrl: (path: string | null) =>
    path ? `https://s.test/storage/v1/object/public/pet-photos/${path}` : null,
}));

import {
  STAGING_BUCKET,
  confirmPetPhoto,
  mintPetPhotoTicket,
  stagedPathBelongsToPet,
} from "@/lib/infra/pet-photo-upload";
import {
  EVENT_ATTACHMENT_BUCKET,
  claimStagedEventAttachment,
  isMissingObjectError,
} from "@/lib/infra/staged-event-attachment";
import { MAX_IMAGE_BYTES, RASTER_IMAGE_TYPES, detectRasterMime } from "@/lib/media/validate";

beforeEach(() => {
  control.staged = JPEG;
  control.downloadError = false;
  control.downloadStatus = 404;
  control.uploadError = null;
  control.removeError = null;
  control.sharpThrows = false;
  control.sharpBytes = null;
  control.primaryPhotoId = null;
  control.petIsLive = true;
  control.erasedMidTransaction = false;
  control.txThrows = false;
  control.removed = [];
  control.uploaded = [];
  control.inserted = [];
});

describe("the two whitelists agree", () => {
  it("declares the same content types on the wire as the server enforces", () => {
    // Two copies exist on purpose — `packages/contract` may not import the web
    // app's `lib/`. This is what keeps them from drifting apart, in BOTH
    // directions, so neither adding a format to one nor removing it from one
    // can pass unnoticed.
    expect([...PET_PHOTO_CONTENT_TYPES].sort()).toEqual(Object.keys(RASTER_IMAGE_TYPES).sort());
  });

  it("has no SVG in either, which is the reason the list is a whitelist", () => {
    expect(PET_PHOTO_CONTENT_TYPES as readonly string[]).not.toContain("image/svg+xml");
    expect(Object.keys(RASTER_IMAGE_TYPES)).not.toContain("image/svg+xml");
  });
});

describe("the staged path guard", () => {
  it("accepts only a key prefixed with THIS pet's id", () => {
    expect(stagedPathBelongsToPet(STAGED, PET_ID)).toBe(true);
    // Well-formed, mintable, and somebody else's. This is the case a shape
    // regex alone cannot catch, which is why the guard is a prefix EQUALITY.
    expect(
      stagedPathBelongsToPet(`${OTHER_PET_ID}/33333333-3333-4333-8333-333333333333.jpg`, PET_ID),
    ).toBe(false);
  });

  it("refuses traversal, a bare key, a leading slash and a nested key", () => {
    for (const path of [
      `${PET_ID}/../${OTHER_PET_ID}/x.jpg`,
      `${PET_ID}/..`,
      "x.jpg",
      `/${PET_ID}/x.jpg`,
      `${PET_ID}/a/b.jpg`,
      `${PET_ID}/`,
      "",
    ]) {
      expect(stagedPathBelongsToPet(path, PET_ID), path).toBe(false);
    }
  });

  it("is not fooled by a pet id that merely starts the same", () => {
    // `slice(0, slash)` compared for EQUALITY, not `startsWith`. A prefix check
    // written as startsWith would admit `{petId}extra/…`.
    expect(stagedPathBelongsToPet(`${PET_ID}extra/x.jpg`, PET_ID)).toBe(false);
  });
});

describe("minting a ticket", () => {
  it("puts the pet id in the key and never a caller string", async () => {
    const result = await mintPetPhotoTicket(PET_ID, "image/webp");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ticket.bucket).toBe(STAGING_BUCKET);
    expect(result.ticket.stagedPath.startsWith(`${PET_ID}/`)).toBe(true);
    expect(result.ticket.stagedPath.endsWith(".webp")).toBe(true);
    // The key it minted is one the guard accepts. A ticket whose own path the
    // confirm step would reject is a door that cannot be walked through.
    expect(stagedPathBelongsToPet(result.ticket.stagedPath, PET_ID)).toBe(true);
  });

  it("mints a different key every time, so a retry cannot overwrite the first", async () => {
    const a = await mintPetPhotoTicket(PET_ID, "image/jpeg");
    const b = await mintPetPhotoTicket(PET_ID, "image/jpeg");
    expect(a.ok && b.ok && a.ticket.stagedPath !== b.ticket.stagedPath).toBe(true);
  });
});

describe("confirming — the bytes decide, not the declaration", () => {
  it("refuses another pet's staged key without touching Storage", async () => {
    const result = await confirmPetPhoto({
      petId: PET_ID,
      userId: USER_ID,
      stagedPath: `${OTHER_PET_ID}/33333333-3333-4333-8333-333333333333.jpg`,
    });
    expect(result).toEqual({ ok: false, code: "photo_not_an_image" });
    // Not even a remove: a refused path is not ours to delete, and a Storage
    // call here would make confirm an oracle for which staged keys exist.
    expect(control.removed).toEqual([]);
    expect(control.uploaded).toEqual([]);
  });

  it("refuses an SVG, an HTML document and a ZIP, and discards each", async () => {
    for (const [name, bytes] of [
      ["svg", SVG],
      ["html", HTML],
      ["zip", ZIP],
    ] as const) {
      control.removed = [];
      control.uploaded = [];
      control.staged = bytes;
      const result = await confirmPetPhoto({ petId: PET_ID, userId: USER_ID, stagedPath: STAGED });
      expect(result, name).toEqual({ ok: false, code: "photo_not_an_image" });
      expect(control.uploaded, name).toEqual([]);
      expect(control.removed, name).toEqual([{ bucket: STAGING_BUCKET, paths: [STAGED] }]);
    }
  });

  it("refuses an empty object and one past the size ceiling", async () => {
    control.staged = Buffer.alloc(0);
    expect(await confirmPetPhoto({ petId: PET_ID, userId: USER_ID, stagedPath: STAGED })).toEqual({
      ok: false,
      code: "photo_not_an_image",
    });

    // The bucket's own `file_size_limit` should have refused the PUT. This is
    // the second check, because a bucket limit is remote configuration and
    // configuration drifts.
    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    huge.set([0xff, 0xd8, 0xff], 0);
    control.staged = huge;
    expect(await confirmPetPhoto({ petId: PET_ID, userId: USER_ID, stagedPath: STAGED })).toEqual({
      ok: false,
      code: "photo_not_an_image",
    });
    expect(control.uploaded).toEqual([]);
  });

  it("refuses a missing staged object with the SAME code as a bad one", async () => {
    control.downloadError = true;
    expect(await confirmPetPhoto({ petId: PET_ID, userId: USER_ID, stagedPath: STAGED })).toEqual({
      ok: false,
      code: "photo_not_an_image",
    });
  });

  it("FAILS CLOSED when sharp throws — never the original bytes", async () => {
    control.sharpThrows = true;
    const result = await confirmPetPhoto({ petId: PET_ID, userId: USER_ID, stagedPath: STAGED });
    expect(result).toEqual({ ok: false, code: "photo_not_an_image" });
    // The destination is a PUBLIC bucket. `uploads.ts` has the same rule for
    // the same bucket, and this is what stops a fallback arm being added here.
    expect(control.uploaded).toEqual([]);
  });

  it("stores the RE-ENCODED bytes under a key derived from what they actually are", async () => {
    // Ticketed as a jpg (see STAGED) and the bytes are a PNG. The stored key
    // and the recorded mime must follow the BYTES.
    control.staged = PNG;
    const result = await confirmPetPhoto({ petId: PET_ID, userId: USER_ID, stagedPath: STAGED });
    expect(result.ok).toBe(true);
    expect(control.uploaded).toHaveLength(1);
    const written = control.uploaded[0];
    expect(written.bucket).toBe("pet-photos");
    expect(written.contentType).toBe("image/png");
    expect(written.path.endsWith(".png")).toBe(true);
    expect(written.path.startsWith(`${PET_ID}/`)).toBe(true);
    // The bytes that landed are sharp's output, not the input.
    expect(written.bytes).toBe(Buffer.from("normalised-bytes-xyz").byteLength);
    expect(detectRasterMime(PNG)).toBe("image/png");

    expect(control.inserted).toHaveLength(1);
    expect(control.inserted[0]).toMatchObject({
      petId: PET_ID,
      uploadedByUserId: USER_ID,
      mimeType: "image/png",
      fileSize: Buffer.from("normalised-bytes-xyz").byteLength,
    });
    // The row's storage_path is the key that was actually written. Erasure
    // finds the object through this string and nothing else.
    expect(control.inserted[0].storagePath).toBe(written.path);
  });

  it("discards the staged object on the SUCCESS path too", async () => {
    await confirmPetPhoto({ petId: PET_ID, userId: USER_ID, stagedPath: STAGED });
    expect(control.removed).toContainEqual({ bucket: STAGING_BUCKET, paths: [STAGED] });
  });

  it("reports whether it displaced an earlier photo", async () => {
    const fresh = await confirmPetPhoto({ petId: PET_ID, userId: USER_ID, stagedPath: STAGED });
    expect(fresh.ok && fresh.photo.replacedPrevious).toBe(false);

    control.primaryPhotoId = "att-0";
    const replaced = await confirmPetPhoto({ petId: PET_ID, userId: USER_ID, stagedPath: STAGED });
    expect(replaced.ok && replaced.photo.replacedPrevious).toBe(true);
  });

  it("refuses a SOFT-DELETED pet and takes back the object it wrote", async () => {
    // `erase_subject_data` soft-deletes the PET and leaves the `ownerships` row
    // standing. `resolvePetHolderAccess` now filters `deleted_at` on both paths
    // (closed 2026-08-28), so an erased animal no longer reaches this function
    // through the front door — but a ticket lives for two hours and the erasure
    // can land between mint and confirm, and THAT caller arrives with its
    // access check already passed. A photo of an erased pet is exactly what
    // art. 16 removed.
    //
    // WHAT THIS ASSERTION DOES AND DOES NOT PROVE, said plainly. It proves the
    // BRANCH: when the filtered read finds nothing, nothing is inserted and the
    // written object is taken back. It does NOT prove the predicate is
    // `isNull(pets.deletedAt)` — the `db` mock models the absence of a row, not
    // the SQL that produced it, so deleting the filter from the query would not
    // move this test. The predicate is held by
    // `__tests__/public-soft-delete-resolution.test.ts`, which scans every
    // module reachable from `app/api/v1/**` for a `.from(pets)` without the
    // guard and is the fence that found this hole in the first place. Two
    // mechanisms, each covering what the other cannot; neither one alone.
    control.petIsLive = false;
    const result = await confirmPetPhoto({ petId: PET_ID, userId: USER_ID, stagedPath: STAGED });
    expect(result).toEqual({ ok: false, code: "pet_gone" });
    // Nothing was recorded…
    expect(control.inserted).toEqual([]);
    // …and the object that had already been written is taken back.
    expect(control.removed.map((r) => r.bucket).sort()).toEqual(
      ["pet-photos", STAGING_BUCKET].sort(),
    );
  });

  it("refuses an erasure that lands BETWEEN the select and the pointer update", async () => {
    // The READ COMMITTED race. The SELECT sees a live pet; an erasure commits;
    // the UPDATE's `isNull(deletedAt)` predicate then matches zero rows.
    //
    // Before the affected-row count was checked, this returned SUCCESS with the
    // attachments row committed and the public object written — after
    // `purgeOwnedPetAttachments` had already run — leaving a re-encoded photo of
    // an erased animal that nothing in the repo would ever collect. Milliseconds
    // wide, and art. 16 has no width exemption.
    control.petIsLive = true;
    control.erasedMidTransaction = true;

    const result = await confirmPetPhoto({ petId: PET_ID, userId: USER_ID, stagedPath: STAGED });
    expect(result).toEqual({ ok: false, code: "pet_gone" });

    // ROLLED BACK, not merely unreported: the insert must not survive. This is
    // why the transaction fake truncates on throw — a `return null` here would
    // have COMMITTED the row.
    expect(control.inserted).toEqual([]);

    // And both objects are taken back, so the public bucket keeps nothing.
    expect(control.removed.map((r) => r.bucket).sort()).toEqual(
      ["pet-photos", STAGING_BUCKET].sort(),
    );
  });

  it("removes the object it just wrote when the row fails, leaving no orphan", async () => {
    control.txThrows = true;
    const result = await confirmPetPhoto({ petId: PET_ID, userId: USER_ID, stagedPath: STAGED });
    expect(result).toEqual({ ok: false, code: "photo_failed" });
    const buckets = control.removed.map((r) => r.bucket).sort();
    expect(buckets).toEqual(["pet-photos", STAGING_BUCKET].sort());
  });

  it("answers with the public URL of the key it wrote", async () => {
    const result = await confirmPetPhoto({ petId: PET_ID, userId: USER_ID, stagedPath: STAGED });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.photo.photoUrl).toBe(
      `https://s.test/storage/v1/object/public/pet-photos/${control.uploaded[0].path}`,
    );
  });
});

// ---------------------------------------------------------------------------
// `lib/infra/staged-event-attachment.ts` — the SAME primitive family, one
// bucket over, tested against the same real validator.
// ---------------------------------------------------------------------------
//
// IN THIS FILE AND NOT ITS OWN, because it shares the whole harness above:
// sharp, the admin client, the staged bytes, the removal log. It also shares
// the reason the harness exists — `api-v1-record-event-route.test.ts` mocks
// this module WHOLE, so until these cases existed the size cap, the magic-byte
// gate, both EXIF arms and all five cleanup paths were proved by nothing.
//
// WHAT IT HAS TO PROVE, and each line answers a way somebody's photo or
// somebody's home address gets lost:
//   1. AN ERROR THAT IS NOT A DEFINITE 404 DOES NOT DELETE. storage-js RETURNS
//      its transport failures rather than throwing them, so this is the
//      difference between "the object is gone" and "the service is down".
//   2. A GENUINE 404 DOES delete, so a dead key is not left behind forever.
//   3. THE EXIF STRIP FAILS CLOSED ON BOTH ARMS — sharp throwing, and a
//      re-encode that GREW past the bucket limit. The second is not an error
//      path: it is a healthy request with an indexed-palette PNG.
//   4. THE CONTENT CHECK IS THE BYTES, on this door as on the pet photo's.
//   5. WHAT IS STORED IS THE STRIPPED BODY, in the private bucket, under a key
//      derived from what the bytes turned out to be.
describe("claimStagedEventAttachment — the path guard", () => {
  it("refuses another pet's perfectly well-formed staged key", async () => {
    const result = await claimStagedEventAttachment({
      petId: PET_ID,
      stagedPath: `${OTHER_PET_ID}/33333333-3333-4333-8333-333333333333.jpg`,
    });
    expect(result).toEqual({ ok: false, code: "photo_not_an_image" });
    // REFUSED BEFORE ANY STORAGE CALL: a probe costs the caller a 400 and us
    // nothing, and nothing was downloaded, uploaded or removed.
    expect(control.uploaded).toEqual([]);
    expect(control.removed).toEqual([]);
  });
});

describe("claimStagedEventAttachment — a read failure must not delete the photo", () => {
  it("KEEPS the staged object when the error is not a definite 404", async () => {
    // THE DEFECT THIS CASE EXISTS FOR. `@supabase/storage-js` wraps a refused
    // connection, a DNS failure, a timeout and every 5xx in a
    // `StorageUnknownError` whose `status` is undefined, and RETURNS it. The
    // first version of this module read only thrown errors, so a degraded
    // storage-api landed in the missing-object arm and deleted the owner's
    // tattoo photo while telling them the file was not an image.
    control.downloadError = true;
    control.downloadStatus = undefined;

    const result = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });

    expect(result).toEqual({ ok: false, code: "photo_failed" });
    expect(control.removed).toEqual([]);
  });

  it("keeps it on a 500 too — only 404 means gone", async () => {
    control.downloadError = true;
    control.downloadStatus = 500;

    const result = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });

    expect(result).toEqual({ ok: false, code: "photo_failed" });
    expect(control.removed).toEqual([]);
  });

  it("DISCARDS it on a genuine 404, and says the file is the problem", async () => {
    control.downloadError = true;
    control.downloadStatus = 404;

    const result = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });

    expect(result).toEqual({ ok: false, code: "photo_not_an_image" });
    expect(control.removed).toEqual([{ bucket: STAGING_BUCKET, paths: [STAGED] }]);
  });

  it("answers the two cases with DIFFERENT codes, which is what a client switches on", async () => {
    // `photo_failed` promises a retry is safe; `photo_not_an_image` says the
    // file is the problem. Collapsing them would send somebody to pick a new
    // photo because a service was briefly down.
    control.downloadError = true;
    control.downloadStatus = undefined;
    const outage = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });
    control.removed = [];
    control.downloadStatus = 404;
    const missing = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });

    expect(outage).not.toEqual(missing);
  });
});

describe("isMissingObjectError — the only question whose answer deletes a photo", () => {
  it("says yes to a 404 and NOTHING else", () => {
    expect(isMissingObjectError({ message: "Object not found", status: 404 })).toBe(true);
    expect(isMissingObjectError({ message: "Internal", status: 500 })).toBe(false);
    expect(isMissingObjectError({ message: "Forbidden", status: 403 })).toBe(false);
    expect(isMissingObjectError({ message: "Bad request", status: 400 })).toBe(false);
  });

  it("says NO when there is no status at all — a StorageUnknownError", () => {
    // `fetch failed` from a refused connection arrives exactly like this.
    expect(isMissingObjectError({ message: "fetch failed" })).toBe(false);
    expect(isMissingObjectError({ message: "timeout", status: undefined })).toBe(false);
  });

  it("says NO to anything that is not an error object", () => {
    expect(isMissingObjectError(null)).toBe(false);
    expect(isMissingObjectError(undefined)).toBe(false);
    expect(isMissingObjectError("Object not found")).toBe(false);
    expect(isMissingObjectError(404)).toBe(false);
  });
});

describe("claimStagedEventAttachment — the content check is the bytes", () => {
  it("refuses an SVG, an HTML document and a ZIP", async () => {
    for (const payload of [SVG, HTML, ZIP]) {
      control.staged = payload;
      control.removed = [];
      const result = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });
      expect(result).toEqual({ ok: false, code: "photo_not_an_image" });
      expect(control.uploaded).toEqual([]);
      // A refused payload is taken out of staging: it is definitively not
      // usable, and nothing in this repo collects abandoned staged objects.
      expect(control.removed).toEqual([{ bucket: STAGING_BUCKET, paths: [STAGED] }]);
    }
  });

  it("refuses an empty object", async () => {
    control.staged = Buffer.alloc(0);
    const result = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });
    expect(result).toEqual({ ok: false, code: "photo_not_an_image" });
    expect(control.uploaded).toEqual([]);
  });

  it("REFUSES A PAYLOAD OVER THE SIZE CAP, re-checking what the bucket should have refused", async () => {
    // The bucket's `file_size_limit` (migration 0213) should have refused the
    // PUT. This is the same ceiling applied on the way OUT, because a bucket
    // limit is configuration on a remote service and configuration drifts.
    control.staged = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    const result = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });
    expect(result).toEqual({ ok: false, code: "photo_not_an_image" });
    expect(control.uploaded).toEqual([]);
    expect(control.removed).toEqual([{ bucket: STAGING_BUCKET, paths: [STAGED] }]);
  });
});

describe("claimStagedEventAttachment — the EXIF strip fails closed on BOTH arms", () => {
  it("refuses rather than storing the original when sharp throws", async () => {
    // NOT a fallback. These bytes are a phone photo of an animal taken at home,
    // and the attachment is reachable by any org member with `event.write`
    // through a signed URL — so storing the un-stripped original publishes
    // somebody's coordinates to a shelter.
    control.sharpThrows = true;

    const result = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });

    expect(result).toEqual({ ok: false, code: "photo_not_an_image" });
    expect(control.uploaded).toEqual([]);
    expect(control.removed).toEqual([{ bucket: STAGING_BUCKET, paths: [STAGED] }]);
  });

  it("REFUSES WHEN THE STRIPPED BODY GREW PAST THE LIMIT — a healthy request, not an error", async () => {
    // The worse of the two arms, because nothing failed: an indexed-palette PNG
    // re-encoded non-palettised simply comes back bigger. The old line reverted
    // to `bytes` — the EXIF-bearing original — silently, on a request where
    // every other check passed.
    control.staged = PNG;
    control.sharpBytes = Buffer.alloc(MAX_IMAGE_BYTES + 1);

    const result = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });

    expect(result).toEqual({ ok: false, code: "photo_not_an_image" });
    expect(control.uploaded).toEqual([]);
    expect(control.removed).toEqual([{ bucket: STAGING_BUCKET, paths: [STAGED] }]);
  });

  it("never uploads a body equal to the bytes that arrived", async () => {
    // The property both arms above protect, stated positively: whatever reaches
    // the bucket has been through sharp. If a fallback is ever reintroduced,
    // the stored length starts matching the input length and this fails.
    control.staged = JPEG;
    const result = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });
    expect(result.ok).toBe(true);
    expect(control.uploaded).toHaveLength(1);
    expect(control.uploaded[0]?.bytes).not.toBe(JPEG.byteLength);
    expect(control.uploaded[0]?.bytes).toBe(Buffer.from("normalised-bytes-xyz").byteLength);
  });
});

describe("claimStagedEventAttachment — what it stores, and where", () => {
  it("writes the STRIPPED body into the private bucket and hands back its three facts", async () => {
    control.staged = JPEG;

    const result = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });

    if (!result.ok) throw new Error(`expected the claim to succeed, got ${result.code}`);
    expect(control.uploaded).toHaveLength(1);
    expect(control.uploaded[0]?.bucket).toBe(EVENT_ATTACHMENT_BUCKET);
    expect(result.attachment.path).toBe(control.uploaded[0]?.path);
    expect(result.attachment.mimeType).toBe("image/jpeg");
    expect(result.attachment.size).toBe(control.uploaded[0]?.bytes);
  });

  it("derives the key from what the BYTES are, under this pet's prefix", async () => {
    // A caller that staged a `.jpg` key holding PNG bytes gets a `.png`
    // attachment, because that is what is true. The prefix is the pet id the
    // server resolved, never anything the caller sent.
    control.staged = PNG;

    const result = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });

    if (!result.ok) throw new Error("expected the claim to succeed");
    expect(detectRasterMime(PNG)).toBe("image/png");
    expect(result.attachment.mimeType).toBe("image/png");
    expect(result.attachment.path.startsWith(`${PET_ID}/`)).toBe(true);
    expect(result.attachment.path.endsWith(".png")).toBe(true);
  });

  it("DISCARDS THE STAGED OBJECT on the happy path too", async () => {
    control.staged = JPEG;
    await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });
    expect(control.removed).toEqual([{ bucket: STAGING_BUCKET, paths: [STAGED] }]);
  });

  it("takes the staged object back when the destination write fails", async () => {
    control.staged = JPEG;
    control.uploadError = "bucket unavailable";

    const result = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });

    expect(result).toEqual({ ok: false, code: "photo_failed" });
    expect(control.removed).toEqual([{ bucket: STAGING_BUCKET, paths: [STAGED] }]);
  });

  it("still succeeds when the cleanup itself fails — a leaked staged object is not a failed write", async () => {
    // `remove()` RESOLVES with an error rather than throwing, which is why the
    // module reads `error` instead of wrapping the call in a bare try/catch.
    // The claim is done by then; turning a tidy-up into a refusal would discard
    // an attachment that is already written.
    control.staged = JPEG;
    control.removeError = "storage unavailable";

    const result = await claimStagedEventAttachment({ petId: PET_ID, stagedPath: STAGED });

    expect(result.ok).toBe(true);
    expect(control.removed).toEqual([{ bucket: STAGING_BUCKET, paths: [STAGED] }]);
  });
});
