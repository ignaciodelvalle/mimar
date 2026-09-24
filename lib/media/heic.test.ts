import { describe, expect, it } from "vitest";

import { heicRefusalMessage, isDeclaredHeic, isHeifContainer } from "./heic";

const enc = (s: string) => Array.from(new TextEncoder().encode(s));

/** size (1 byte is enough here), "ftyp", major, minor version 0, compatible brands. */
function ftyp(major: string, compatible: string[] = [], sizeOverride?: number): Uint8Array {
  const body = [...enc(major), 0, 0, 0, 0, ...compatible.flatMap(enc)];
  const size = sizeOverride ?? 8 + body.length;
  return new Uint8Array([0, 0, 0, size, ...enc("ftyp"), ...body]);
}

describe("isHeifContainer", () => {
  it.each(["heic", "heix", "mif1", "msf1", "avif"])("recognises the %s major brand", (brand) => {
    expect(isHeifContainer(ftyp(brand))).toBe(true);
  });

  it("recognises heic listed only as a compatible brand", () => {
    expect(isHeifContainer(ftyp("abcd", ["isom", "heic"]))).toBe(true);
  });

  it("does not read compatible brands past the box's own size", () => {
    // Box declares 16 bytes (no compatible brands); a "heic" after it belongs to the next box.
    expect(isHeifContainer(ftyp("abcd", ["heic"], 16))).toBe(false);
  });

  it.each([
    ["an MP4", ftyp("isom", ["iso2", "avc1", "mp41"])],
    ["a QuickTime MOV", ftyp("qt  ", ["qt  "])],
    ["a JPEG", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])],
    ["a truncated header", new Uint8Array([0, 0, 0, 0x18, ...enc("ftyp")])],
  ])("rejects %s", (_label, bytes) => {
    expect(isHeifContainer(bytes)).toBe(false);
  });
});

describe("isDeclaredHeic", () => {
  it.each([
    [{ name: "a.jpg", type: "image/heic" }, true],
    [{ name: "a.jpg", type: "IMAGE/HEIF" }, true],
    [{ name: "IMG_1.HEIC", type: "" }, true],
    [{ name: "IMG_1.heif", type: null }, true],
    [{ name: "heic.jpg", type: "image/jpeg" }, false],
  ])("%o → %s", (file, expected) => {
    expect(isDeclaredHeic(file)).toBe(expected);
  });
});

describe("heicRefusalMessage", () => {
  it("names the file and says how to send a JPG", () => {
    const msg = heicRefusalMessage("IMG_1.HEIC");
    expect(msg.startsWith('La foto "IMG_1.HEIC" está en formato HEIC')).toBe(true);
    expect(msg).toContain("captura de pantalla");
    expect(msg).toContain('"Más compatible"');
  });

  it("reads naturally without a file name", () => {
    expect(heicRefusalMessage().startsWith("Esta foto está en formato HEIC")).toBe(true);
  });
});
