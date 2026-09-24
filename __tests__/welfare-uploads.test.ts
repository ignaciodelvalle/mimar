// Unit tests for uploadWelfareEvidence validation and upload logic.
// Supabase storage is mocked so no real bucket is required.
//
// The helper takes NO client argument since RA-8 R2 / migration 0164: the
// `welfare-evidence` bucket has no anon/authenticated policy, so both upload
// and cleanup run through the service-role client that the helper resolves
// itself. These tests therefore mock `@/lib/supabase/admin` rather than
// handing in a fake client.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkWelfareEvidence,
  prepareWelfareEvidence,
  removeWelfareEvidence,
  uploadPreparedWelfareEvidence,
  uploadWelfareEvidence,
} from "@/lib/infra/welfare-uploads";

// ---------------------------------------------------------------------------
// Mock: sharp (dynamic import inside welfare-uploads.ts)
// ---------------------------------------------------------------------------

const mockToBuffer = vi.fn();
const mockRotate = vi.fn(() => ({ toBuffer: mockToBuffer }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSharpFn = vi.fn((_arg: any) => ({ rotate: mockRotate }));

vi.mock("sharp", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (arg: any) => mockSharpFn(arg),
}));

// ---------------------------------------------------------------------------
// Mock: the service-role storage client
// ---------------------------------------------------------------------------

const uploadMock = vi.fn(async () => ({ error: null }) as { error: { message: string } | null });
const removeMock = vi.fn(async () => ({ error: null }));
// When set, createAdminClient() throws — the "service-role key is missing"
// deployment state.
let adminClientError: Error | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminClientError) throw adminClientError;
    return { storage: { from: () => ({ upload: uploadMock, remove: removeMock }) } };
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(name: string, type: string, sizeBytes = 1024): File {
  const bytes = new Uint8Array(sizeBytes);
  return new File([bytes], name, { type });
}

/**
 * The first bytes of an ISO-BMFF file: box size, `ftyp`, major brand, minor
 * version, compatible brands. An iPhone HEIC opens `ftypheic`; many converted
 * or Android files open `ftypmif1` and list `heic` only as compatible.
 */
function ftypHeader(major: string, compatible: string[]): Uint8Array {
  const brands = [major, "\0\0\0\0", ...compatible].join("");
  const size = 8 + brands.length;
  return new Uint8Array([
    0,
    0,
    0,
    size,
    ...new TextEncoder().encode("ftyp"),
    ...new TextEncoder().encode(brands),
  ]);
}

function makeBytesFile(head: Uint8Array, name: string, type: string): File {
  return new File([new Uint8Array(head), new Uint8Array(256)], name, { type });
}

/** The (path, body, options) tuple of the nth storage.upload call. */
function uploadCall(n = 0): [string, unknown, unknown] {
  return uploadMock.mock.calls[n] as unknown as [string, unknown, unknown];
}

// Real magic numbers (FIX B fixtures) — enough leading bytes for
// `detectRasterMime` to recognise the format regardless of what the file
// DECLARES itself to be.
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_MAGIC = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Module-level reset: `beforeEach` inside one `describe` does NOT reach a
// SIBLING `describe`'s tests, and this file has several. Without this, mock
// call counts (sharp, storage.upload) leak across describe blocks.
beforeEach(() => {
  vi.clearAllMocks();
  adminClientError = null;
  uploadMock.mockImplementation(async () => ({ error: null }));
  mockToBuffer.mockResolvedValue(Buffer.from("sharp-processed"));
});

describe("uploadWelfareEvidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminClientError = null;
    uploadMock.mockImplementation(async () => ({ error: null }));
    // Default: sharp returns a distinguishable processed buffer.
    mockToBuffer.mockResolvedValue(Buffer.from("sharp-processed"));
  });

  it("returns empty result when files array is empty", async () => {
    const result = await uploadWelfareEvidence("report-id-1", []);
    expect(result.error).toBeNull();
    expect(result.uploaded).toHaveLength(0);
    expect(result.uploadedPaths).toHaveLength(0);
  });

  it("returns an error when more than 5 files are supplied", async () => {
    const files = Array.from({ length: 6 }, (_, i) => makeFile(`photo${i}.jpg`, "image/jpeg"));
    const result = await uploadWelfareEvidence("report-id-2", files);
    expect(result.error).toMatch(/5/);
    expect(result.uploaded).toHaveLength(0);
  });

  it("returns an error for disallowed MIME type", async () => {
    const result = await uploadWelfareEvidence("report-id-3", [
      makeFile("doc.pdf", "application/pdf"),
    ]);
    expect(result.error).toBeTruthy();
    expect(result.uploaded).toHaveLength(0);
  });

  it("returns an error when a file exceeds 25 MB", async () => {
    const tooBig = makeFile("big.jpg", "image/jpeg", 26 * 1024 * 1024);
    const result = await uploadWelfareEvidence("report-id-4", [tooBig]);
    expect(result.error).toMatch(/25 MB/);
    expect(result.uploaded).toHaveLength(0);
  });

  it("uploads a valid image and returns its storage path", async () => {
    const file = makeFile("evidence.jpg", "image/jpeg", 2048);
    const result = await uploadWelfareEvidence("report-id-5", [file]);
    expect(result.error).toBeNull();
    expect(result.uploaded).toHaveLength(1);
    expect(result.uploadedPaths).toHaveLength(1);
    const u = result.uploaded[0];
    expect(u.storagePath).toMatch(/^report-id-5\//);
    expect(u.storagePath).toMatch(/\.jpg$/);
    expect(u.mimeType).toBe("image/jpeg");
    // fileSize reflects the processed (EXIF-stripped) buffer, not the original.
    expect(u.fileSize).toBe(Buffer.from("sharp-processed").length);
    expect(u.originalFilename).toBe("evidence.jpg");
  });

  it("uploads multiple valid files and returns all paths", async () => {
    const files = [
      makeFile("a.jpg", "image/jpeg"),
      makeFile("b.png", "image/png"),
      makeFile("c.mp4", "video/mp4"),
    ];
    const result = await uploadWelfareEvidence("report-id-6", files);
    expect(result.error).toBeNull();
    expect(result.uploaded).toHaveLength(3);
    expect(result.uploadedPaths).toHaveLength(3);
  });

  it("rolls back already-uploaded files and returns an error when Supabase upload fails", async () => {
    let callCount = 0;
    uploadMock.mockImplementation(async () => {
      callCount++;
      if (callCount > 1) return { error: { message: "storage quota exceeded" } };
      return { error: null };
    });
    const result = await uploadWelfareEvidence("report-id-7", [
      makeFile("ok.jpg", "image/jpeg"),
      makeFile("fail.jpg", "image/jpeg"),
    ]);
    expect(result.error).toMatch(/storage quota exceeded/);
    expect(result.uploaded).toHaveLength(0);
    expect(removeMock).toHaveBeenCalledOnce();
  });

  it("filters out zero-byte File entries silently", async () => {
    const empty = new File([], "empty.jpg", { type: "image/jpeg" });
    const real = makeFile("real.jpg", "image/jpeg");
    const result = await uploadWelfareEvidence("report-id-8", [empty, real]);
    expect(result.error).toBeNull();
    expect(result.uploaded).toHaveLength(1);
    expect(result.uploaded[0].originalFilename).toBe("real.jpg");
  });

  // -------------------------------------------------------------------------
  // Service-role storage identity (RA-8 R2)
  // -------------------------------------------------------------------------

  it("uploads through the SERVICE-ROLE client, never a caller-supplied one", async () => {
    await uploadWelfareEvidence("report-id-svc", [makeFile("e.jpg", "image/jpeg")]);
    // The only storage handle in play is the mocked admin client's. If the
    // helper ever accepts a caller client again, this mock stops being the one
    // that receives the write and the assertion fails.
    expect(uploadMock).toHaveBeenCalledOnce();
    expect(uploadCall()[0]).toMatch(/^report-id-svc\//);
  });

  it("fails closed with a user-facing error when the service-role client is unavailable", async () => {
    adminClientError = new Error("Supabase admin client not configured: missing env vars.");
    const result = await uploadWelfareEvidence("report-id-nokey", [
      makeFile("e.jpg", "image/jpeg"),
    ]);
    // Not a silent success: a denuncia must never be recorded as "submitted
    // with evidence" when the evidence went nowhere.
    expect(result.error).toBeTruthy();
    expect(result.uploaded).toHaveLength(0);
    expect(result.uploadedPaths).toHaveLength(0);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // EXIF-stripping behaviour
  // -------------------------------------------------------------------------

  it("raster image (jpeg/png/webp) routes through sharp and uploads the processed buffer", async () => {
    const file = makeFile("photo.jpg", "image/jpeg", 4096);
    const result = await uploadWelfareEvidence("report-id-exif-1", [file]);

    expect(result.error).toBeNull();
    // sharp was invoked.
    expect(mockSharpFn).toHaveBeenCalledOnce();
    expect(mockRotate).toHaveBeenCalledOnce();
    expect(mockToBuffer).toHaveBeenCalledOnce();
    // The body passed to storage.upload is the processed Buffer, not the original File.
    const uploadedBody = uploadCall()[1];
    expect(Buffer.isBuffer(uploadedBody)).toBe(true);
    expect(uploadedBody).toEqual(Buffer.from("sharp-processed"));
    // fileSize reflects the processed buffer length.
    expect(result.uploaded[0].fileSize).toBe(Buffer.from("sharp-processed").length);
  });

  it("non-image evidence (video/mp4) bypasses sharp and is uploaded as-is", async () => {
    const file = makeFile("clip.mp4", "video/mp4", 1024);
    const result = await uploadWelfareEvidence("report-id-exif-2", [file]);

    expect(result.error).toBeNull();
    // sharp must NOT have been called for non-raster types.
    expect(mockSharpFn).not.toHaveBeenCalled();
    // Uploaded body is the original File.
    expect(uploadCall()[1]).toBe(file);
    // fileSize is the original file size.
    expect(result.uploaded[0].fileSize).toBe(1024);
  });

  // -------------------------------------------------------------------------
  // D4: the strip FAILS CLOSED. It used to fall back to the original bytes —
  // the GPS-bearing ones — whenever sharp threw.
  // -------------------------------------------------------------------------

  it("a strip failure refuses the submission and stores nothing", async () => {
    mockToBuffer.mockRejectedValue(new Error("sharp: unsupported format"));

    const file = makeFile("corrupt.jpg", "image/jpeg", 512);
    const result = await uploadWelfareEvidence("report-id-exif-3", [file]);

    expect(result.error).toContain('"corrupt.jpg"');
    expect(result.error).toMatch(/lugar donde se sacó/);
    expect(result.error).toMatch(/no guardamos nada/);
    expect(result.uploaded).toEqual([]);
    expect(result.uploadedPaths).toEqual([]);
    // The original File never reached storage.
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("a strip failure on a later file blocks the WHOLE set — nothing is ever stored (Fix A)", async () => {
    // First JPEG strips fine, the second one does not.
    mockToBuffer
      .mockResolvedValueOnce(Buffer.from("sharp-processed"))
      .mockRejectedValueOnce(new Error("sharp: corrupt"));

    const result = await uploadWelfareEvidence("report-id-exif-4", [
      makeFile("ok.jpg", "image/jpeg"),
      makeFile("bad.jpg", "image/jpeg"),
    ]);

    expect(result.error).toContain('"bad.jpg"');
    expect(result.uploaded).toEqual([]);
    expect(result.uploadedPaths).toEqual([]);
    // Fix A (2026-09-18): uploadWelfareEvidence now runs prepareWelfareEvidence
    // FIRST — every file's strip must succeed before ANY of them reaches
    // storage. Before this, "ok.jpg" was uploaded and then rolled back once
    // "bad.jpg" failed; now it is never uploaded in the first place, so there
    // is nothing to roll back — no storage round trip for a set that was
    // always going to be refused.
    expect(uploadMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // D4: HEIC/HEIF is refused, whatever the file claims to be.
  // -------------------------------------------------------------------------

  it("refuses an iPhone HEIC (ftypheic) with the D4 message and uploads nothing", async () => {
    const heic = makeBytesFile(ftypHeader("heic", ["mif1", "heic"]), "IMG_0001.HEIC", "image/heic");

    const result = await uploadWelfareEvidence("report-id-heic-1", [heic]);

    expect(result.error).toContain('"IMG_0001.HEIC"');
    expect(result.error).toMatch(/formato HEIC/);
    expect(result.error).toMatch(/lugar exacto/);
    expect(result.error).toMatch(/captura de pantalla/);
    expect(result.error).toMatch(/Más compatible/);
    expect(result.uploaded).toEqual([]);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(mockSharpFn).not.toHaveBeenCalled();
  });

  it("refuses HEIF bytes (ftypmif1) even when the file is labelled image/jpeg", async () => {
    // The declared type is the client's to choose; the bytes are not.
    const disguised = makeBytesFile(ftypHeader("mif1", ["heic"]), "foto.jpg", "image/jpeg");

    const result = await uploadWelfareEvidence("report-id-heic-2", [disguised]);

    expect(result.error).toMatch(/formato HEIC/);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(mockSharpFn).not.toHaveBeenCalled();
  });

  it("refuses a .heic file the browser sent with no type at all", async () => {
    const untyped = makeFile("IMG_0002.heic", "", 2048);

    const result = await uploadWelfareEvidence("report-id-heic-3", [untyped]);

    expect(result.error).toMatch(/formato HEIC/);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("one HEIC among valid files refuses the whole set before anything is stored", async () => {
    const result = await uploadWelfareEvidence("report-id-heic-4", [
      makeFile("ok.jpg", "image/jpeg"),
      makeBytesFile(ftypHeader("heic", []), "IMG_0003.HEIC", "image/heic"),
    ]);

    expect(result.error).toMatch(/formato HEIC/);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("an MP4 or MOV is not mistaken for HEIF (its ftyp brands are video brands)", async () => {
    const mp4 = makeBytesFile(ftypHeader("isom", ["iso2", "mp41"]), "clip.mp4", "video/mp4");
    const mov = makeBytesFile(ftypHeader("qt  ", ["qt  "]), "clip.mov", "video/quicktime");

    const result = await uploadWelfareEvidence("report-id-video", [mp4, mov]);

    expect(result.error).toBeNull();
    expect(result.uploaded.map((u) => u.mimeType)).toEqual(["video/mp4", "video/quicktime"]);
  });
});

describe("FIX B — the strip decision is byte-driven, not declared-type-driven", () => {
  it("a real JPEG declared video/mp4 still gets stripped and stored as image/jpeg", async () => {
    const disguised = makeBytesFile(JPEG_MAGIC, "clip.mp4", "video/mp4");
    const result = await uploadWelfareEvidence("report-fixb-1", [disguised]);

    expect(result.error).toBeNull();
    expect(mockSharpFn).toHaveBeenCalledOnce();
    expect(result.uploaded[0].mimeType).toBe("image/jpeg");
    const uploadedBody = uploadCall()[1];
    expect(Buffer.isBuffer(uploadedBody)).toBe(true);
    // The storage object also carries the CORRECTED content-type, not the
    // declared one — a caller downloading it must not be lied to either.
    const opts = uploadCall()[2] as { contentType: string };
    expect(opts.contentType).toBe("image/jpeg");
  });

  it("a real PNG declared image/gif still gets stripped and stored as image/png", async () => {
    const disguised = makeBytesFile(PNG_MAGIC, "foto.gif", "image/gif");
    const result = await uploadWelfareEvidence("report-fixb-2", [disguised]);

    expect(result.error).toBeNull();
    expect(mockSharpFn).toHaveBeenCalledOnce();
    expect(result.uploaded[0].mimeType).toBe("image/png");
  });

  it("a real WEBP declared video/webm still gets stripped and stored as image/webp", async () => {
    const disguised = makeBytesFile(WEBP_MAGIC, "clip.webm", "video/webm");
    const result = await uploadWelfareEvidence("report-fixb-3", [disguised]);

    expect(result.error).toBeNull();
    expect(mockSharpFn).toHaveBeenCalledOnce();
    expect(result.uploaded[0].mimeType).toBe("image/webp");
  });

  it("a genuine GIF (bytes don't sniff as raster) declared image/gif is NOT stripped", async () => {
    const gif89a = new TextEncoder().encode("GIF89a");
    const genuine = makeBytesFile(gif89a, "real.gif", "image/gif");
    const result = await uploadWelfareEvidence("report-fixb-4", [genuine]);

    expect(result.error).toBeNull();
    expect(mockSharpFn).not.toHaveBeenCalled();
    expect(result.uploaded[0].mimeType).toBe("image/gif");
  });

  it("a strip failure on a byte-sniffed (not declared) raster still fails closed", async () => {
    mockToBuffer.mockRejectedValueOnce(new Error("sharp: unsupported format"));
    const disguised = makeBytesFile(JPEG_MAGIC, "clip.mp4", "video/mp4");
    const result = await uploadWelfareEvidence("report-fixb-5", [disguised]);

    expect(result.error).toMatch(/no guardamos nada/);
    expect(result.uploaded).toEqual([]);
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

describe("prepareWelfareEvidence — the full pre-insert gate (Fix A)", () => {
  it("does no storage I/O at all — bucket is never touched", async () => {
    const file = makeFile("evidence.jpg", "image/jpeg", 2048);
    const result = await prepareWelfareEvidence([file]);

    expect(result.error).toBeNull();
    expect(result.prepared).toHaveLength(1);
    expect(result.prepared[0].mimeType).toBe("image/jpeg");
    expect(Buffer.isBuffer(result.prepared[0].uploadBody)).toBe(true);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("a strip failure refuses with no prepared files and no storage call", async () => {
    mockToBuffer.mockRejectedValueOnce(new Error("sharp: unsupported format"));
    const file = makeFile("corrupt.jpg", "image/jpeg", 512);
    const result = await prepareWelfareEvidence([file]);

    expect(result.error).toContain('"corrupt.jpg"');
    expect(result.error).toMatch(/no guardamos nada/);
    expect(result.prepared).toEqual([]);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("a HEIC refusal happens before any strip attempt", async () => {
    const heic = makeBytesFile(ftypHeader("heic", []), "IMG.HEIC", "image/heic");
    const result = await prepareWelfareEvidence([heic]);

    expect(result.error).toMatch(/formato HEIC/);
    expect(result.prepared).toEqual([]);
    expect(mockSharpFn).not.toHaveBeenCalled();
  });

  it("prepared bodies feed uploadPreparedWelfareEvidence WITHOUT re-stripping", async () => {
    const file = makeFile("evidence.jpg", "image/jpeg", 2048);
    const prep = await prepareWelfareEvidence([file]);
    expect(prep.error).toBeNull();

    mockSharpFn.mockClear();
    mockToBuffer.mockClear();

    const result = await uploadPreparedWelfareEvidence("report-prepared-1", prep.prepared);

    expect(result.error).toBeNull();
    expect(result.uploaded).toHaveLength(1);
    // The strip already happened inside prepareWelfareEvidence — uploading the
    // prepared body must not touch sharp a second time.
    expect(mockSharpFn).not.toHaveBeenCalled();
    expect(mockToBuffer).not.toHaveBeenCalled();
    const uploadedBody = uploadCall()[1];
    expect(Buffer.isBuffer(uploadedBody)).toBe(true);
  });
});

describe("checkWelfareEvidence — the storage-free checks callers run before inserting", () => {
  it("passes a valid set", async () => {
    expect(await checkWelfareEvidence([makeFile("a.jpg", "image/jpeg")])).toBeNull();
  });

  it("refuses HEIC by its bytes", async () => {
    const heic = makeBytesFile(ftypHeader("heic", []), "x.bin", "application/octet-stream");
    expect(await checkWelfareEvidence([heic])).toMatch(/formato HEIC/);
  });

  it("refuses an unsupported type with the generic message", async () => {
    expect(await checkWelfareEvidence([makeFile("doc.pdf", "application/pdf")])).toMatch(
      /Tipo de archivo no soportado: application\/pdf/,
    );
  });
});

describe("removeWelfareEvidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminClientError = null;
  });

  it("removes through the service-role client (the bucket has no DELETE policy)", async () => {
    await removeWelfareEvidence(["r/1.jpg", "r/2.jpg"]);
    expect(removeMock).toHaveBeenCalledWith(["r/1.jpg", "r/2.jpg"]);
  });

  it("is a no-op for an empty path list", async () => {
    await removeWelfareEvidence([]);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("never throws when the service-role client is unavailable", async () => {
    adminClientError = new Error("Supabase admin client not configured: missing env vars.");
    await expect(removeWelfareEvidence(["r/1.jpg"])).resolves.toBeUndefined();
  });
});
