// A real JPEG carrying a GPS position is stored WITHOUT it — through real sharp.
//
// welfare-uploads.test.ts and uploads-strip-metadata.test.ts mock sharp, so
// they prove the helpers route bytes through the strip and refuse when it
// throws; they cannot prove the strip actually drops a GPS block. This file
// builds a JPEG with an EXIF GPS IFD (the one a phone writes) and checks the
// bytes that reach storage.
//
// The fixture's own EXIF is asserted first. Without that, "the stored file has
// no EXIF" would also pass on a fixture that never had any.

import { deflateSync } from "node:zlib";

import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

const uploadMock = vi.fn(
  async (_path: string, _body: unknown, _opts: unknown) =>
    ({ error: null }) as { error: { message: string } | null },
);

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ upload: uploadMock, remove: vi.fn(async () => ({ error: null })) }) },
  }),
}));

import { uploadAttachmentIfPresent } from "@/lib/infra/uploads";
import { uploadWelfareEvidence } from "@/lib/infra/welfare-uploads";
import { reencodeRaster } from "@/lib/media/validate";

// Buenos Aires, as a phone would write it: degrees/minutes/seconds rationals.
const GPS = {
  GPSLatitudeRef: "S",
  GPSLatitude: "34/1 36/1 0/1",
  GPSLongitudeRef: "W",
  GPSLongitude: "58/1 22/1 0/1",
};
// Tag 0x8825 is the IFD0 pointer to the GPS IFD. sharp writes little-endian.
const GPS_IFD_POINTER_LE = Buffer.from([0x25, 0x88]);

let jpegWithGps: Buffer;

beforeAll(async () => {
  jpegWithGps = await sharp({
    create: { width: 16, height: 12, channels: 3, background: "#3a7d44" },
  })
    .jpeg()
    .withExif({ IFD0: { Make: "Apple", Model: "iPhone" }, IFD3: GPS })
    .toBuffer();
});

async function storedBody(): Promise<Buffer> {
  expect(uploadMock).toHaveBeenCalledOnce();
  const body = uploadMock.mock.calls[0][1];
  expect(Buffer.isBuffer(body)).toBe(true);
  return body as Buffer;
}

describe("the fixture really carries a GPS block", () => {
  it("has EXIF with a GPS IFD pointer", async () => {
    const meta = await sharp(jpegWithGps).metadata();
    expect(meta.exif).toBeInstanceOf(Buffer);
    expect(meta.exif?.includes(GPS_IFD_POINTER_LE)).toBe(true);
  });
});

describe("stored bytes carry no EXIF (and so no GPS)", () => {
  it("uploadWelfareEvidence — a denuncia photo", async () => {
    uploadMock.mockClear();
    const file = new File([new Uint8Array(jpegWithGps)], "denuncia.jpg", { type: "image/jpeg" });

    const result = await uploadWelfareEvidence("report-gps", [file]);

    expect(result.error).toBeNull();
    const meta = await sharp(await storedBody()).metadata();
    expect(meta.exif).toBeUndefined();
    // Still the same picture, not an empty or corrupt body.
    expect(meta).toMatchObject({ format: "jpeg", width: 16, height: 12 });
  });

  it("uploadAttachmentIfPresent with stripMetadata — a sighting or finder photo", async () => {
    uploadMock.mockClear();
    const file = new File([new Uint8Array(jpegWithGps)], "avistaje.jpg", { type: "image/jpeg" });
    const client = { storage: { from: () => ({ upload: uploadMock }) } };

    const result = await uploadAttachmentIfPresent(client, file, "event-attachments", {
      stripMetadata: true,
    });

    expect(result.error).toBeNull();
    const meta = await sharp(await storedBody()).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta).toMatchObject({ format: "jpeg", width: 16, height: 12 });
  });

  it("uploadAttachmentIfPresent with NO option — the ordinary event/medical/Atender path (D4)", async () => {
    // The ~20 call sites that never opted in stored this GPS block until
    // 2026-09-18. The strip is the default now.
    uploadMock.mockClear();
    const file = new File([new Uint8Array(jpegWithGps)], "vacuna.jpg", { type: "image/jpeg" });
    const client = { storage: { from: () => ({ upload: uploadMock }) } };

    const result = await uploadAttachmentIfPresent(client, file, "event-attachments");

    expect(result.error).toBeNull();
    const meta = await sharp(await storedBody()).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta).toMatchObject({ format: "jpeg", width: 16, height: 12 });
  });
});

// ---------------------------------------------------------------------------
// A decompression bomb is refused BEFORE it is decoded — through real sharp.
//
// Every upload door bounds the bytes that arrive (5 MB) and every raster then
// goes through `reencodeRaster` (lib/media/validate.ts). Bytes are not pixels:
// a PNG is deflate-compressed, so a single-colour image of 16000 × 16000 is a
// few tens of kilobytes on the wire and ~1 GB once decoded as RGBA. sharp's
// default `limitInputPixels` (16383 × 16383) lets that through; the explicit
// ceiling must not.
//
// The fixtures are built by hand (IHDR + one deflated IDAT) rather than with
// sharp, because making a 256 MP image with sharp would itself decode it. Each
// fixture's header is read back first — without that, "sharp refused it" would
// also pass on a PNG sharp simply could not parse.
//
// The ceiling is stated here independently of the constant: 8192 × 8192 =
// 67 108 864 pixels.
// ---------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid 1-bit greyscale PNG, all black: tiny on the wire, huge decoded. */
function blackPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // greyscale
  // 1 filter byte + ceil(width / 8) bytes per row, all zero.
  const raw = Buffer.alloc((1 + Math.ceil(width / 8)) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BOMB = blackPng(16_000, 16_000);
const JUST_OVER = blackPng(8193, 8192);

describe("the fixtures are what they claim", () => {
  it("the bomb is under the 5 MB byte ceiling and 256 000 000 pixels", async () => {
    expect(BOMB.length).toBeLessThan(5 * 1024 * 1024);
    const meta = await sharp(BOMB, { limitInputPixels: false }).metadata();
    expect(meta).toMatchObject({ format: "png", width: 16_000, height: 16_000 });
  });

  it("the just-over fixture is one column past 8192 × 8192", async () => {
    const meta = await sharp(JUST_OVER, { limitInputPixels: false }).metadata();
    expect(meta).toMatchObject({ format: "png", width: 8193, height: 8192 });
  });
});

describe("reencodeRaster refuses what would decode past 8192 × 8192 pixels", () => {
  it("throws on the bomb", async () => {
    await expect(reencodeRaster(BOMB)).rejects.toThrow(/pixel limit/i);
  });

  it("throws one column past the ceiling", async () => {
    await expect(reencodeRaster(JUST_OVER)).rejects.toThrow(/pixel limit/i);
  });

  it("still re-encodes an ordinary photo-sized image", async () => {
    const out = await reencodeRaster(blackPng(4000, 3000));
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: "png", width: 4000, height: 3000 });
  });
});

describe("the doors fail closed with their existing es-AR refusal", () => {
  const REFUSAL =
    "No pudimos quitarle a la foto los datos que guarda la cámara, como el lugar donde se sacó, así que no guardamos nada. Probá de nuevo con una captura de pantalla de la foto.";

  it("uploadAttachmentIfPresent stores nothing and says why", async () => {
    uploadMock.mockClear();
    const file = new File([new Uint8Array(BOMB)], "bomba.png", { type: "image/png" });
    const client = { storage: { from: () => ({ upload: uploadMock }) } };

    const result = await uploadAttachmentIfPresent(client, file, "event-attachments");

    expect(result).toMatchObject({ uploadedPath: null, error: REFUSAL });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("uploadWelfareEvidence stores nothing and names the file", async () => {
    uploadMock.mockClear();
    const file = new File([new Uint8Array(BOMB)], "bomba.png", { type: "image/png" });

    const result = await uploadWelfareEvidence("report-bomb", [file]);

    expect(result.error).toBe(
      'No pudimos quitarle a la foto "bomba.png" los datos que guarda la cámara, como el lugar donde se sacó, así que no guardamos nada. Probá de nuevo con una captura de pantalla de la foto.',
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
