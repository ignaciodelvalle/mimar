// HEIC/HEIF is refused, not transcoded — PO decision D4 (2026-09-18).
//
// "Para no guardar datos de ciudadanos que no nos dieron conscientemente."
// HEIC is the iPhone camera's default format, and its metadata carries the GPS
// position where the photo was taken: for an anonymous denuncia that is very
// often the reporter's own home. We do not decode it on the server (sharp's
// prebuilt libvips cannot read HEVC, and a server-side transcode was ruled out
// by D4), so the only way not to keep that position is not to take the file.
//
// The refusal must tell the person what to do instead, because a bare "tipo de
// archivo no soportado" leaves an iPhone owner with no idea why their ordinary
// photo is wrong. iOS Safari already converts HEIC to JPEG when the page does
// not ask for HEIC explicitly (`accept="image/*"`), so on the web this message
// is reached mostly by a file picked from Files/Finder or a desktop browser.
//
// This module has no server-only import on purpose: the denuncia forms use the
// same sentence client-side, before anything is sent.

/**
 * ISO-BMFF brands that mark a HEIF-family still image or image sequence. `mif1`
 * and `msf1` are the generic HEIF brands — a Samsung or a converted iPhone file
 * often carries `mif1` as the MAJOR brand and `heic` only as a compatible one,
 * so the compatible list is scanned too. `avif`/`avis` are HEIF containers as
 * well and carry the same metadata boxes.
 */
const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "hevm",
  "hevs",
  "mif1",
  "mif2",
  "msf1",
  "avif",
  "avis",
]);

/** The most bytes the brand scan ever reads; callers may pass just this much. */
export const HEIF_SNIFF_BYTES = 64;

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

/**
 * Do these bytes open a HEIF-family file (HEIC, HEIF, AVIF)?
 *
 * Decided by the leading `ftyp` box, never by the declared type or the file
 * name — both are the client's to set. Layout: a 4-byte big-endian box size,
 * `ftyp`, the major brand, a 4-byte minor version, then compatible brands.
 */
export function isHeifContainer(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || fourcc(bytes, 4) !== "ftyp") return false;
  if (HEIF_BRANDS.has(fourcc(bytes, 8))) return true;
  const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(boxSize, bytes.length, HEIF_SNIFF_BYTES);
  for (let at = 16; at + 4 <= end; at += 4) {
    if (HEIF_BRANDS.has(fourcc(bytes, at))) return true;
  }
  return false;
}

/** Declared as HEIC/HEIF by type or by extension — the cheap check a form can make. */
export function isDeclaredHeic(file: { name?: string | null; type?: string | null }): boolean {
  const type = (file.type ?? "").toLowerCase();
  if (type === "image/heic" || type === "image/heif") return true;
  return /\.(heic|heif)$/i.test(file.name ?? "");
}

/** The es-AR refusal for a HEIC/HEIF photo, naming the file when there is one. */
export function heicRefusalMessage(filename?: string | null): string {
  const subject = filename ? `La foto "${filename}"` : "Esta foto";
  const why = "ese formato puede guardar el lugar exacto donde la sacaste";
  const how =
    'sacale una captura de pantalla a la foto, o en el iPhone andá a Ajustes > Cámara > Formatos y elegí "Más compatible"';
  return `${subject} está en formato HEIC (el de las fotos del iPhone) y no la podemos aceptar: ${why}. Mandala como JPG: ${how}.`;
}

/**
 * The es-AR refusal when a photo's hidden data could not be removed. Nothing is
 * kept when this is shown — the caller has already rolled back what it stored.
 */
export function metadataStripRefusalMessage(filename?: string | null): string {
  const subject = filename ? `la foto "${filename}"` : "la foto";
  const what = "los datos que guarda la cámara, como el lugar donde se sacó";
  return `No pudimos quitarle a ${subject} ${what}, así que no guardamos nada. Probá de nuevo con una captura de pantalla de la foto.`;
}
