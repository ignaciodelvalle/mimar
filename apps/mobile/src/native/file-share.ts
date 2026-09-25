// Real files, handed to the OS share sheet — the poster PDF and the art. 14
// export (M13).
//
// WHY THESE THREE MODULES, AND WHY `expo-file-system` IS NOT THE RISK IT WAS
// ---------------------------------------------------------------------------
// `expo-print` renders HTML to a PDF on the device; `expo-sharing` hands a
// file:// URI to the share sheet (WhatsApp, Drive, the printer app, "Guardar
// en Archivos"); `expo-file-system` writes the JSON export to that file and
// gives the PDF a readable name.
//
// The memory of this project says `expo-file-system` once orphaned the OTA
// channel. What orphaned it was ADDING a native module to a binary already in
// the field, which moves the runtime fingerprint so the installed build stops
// accepting updates. Two facts make that moot here, and both were measured on
// 2026-09-24 rather than assumed:
//
//   · this change ships in a NATIVE build (2026-10-01), not over the air —
//     `expo-print` and `expo-sharing` move the fingerprint anyway, and so does
//     the date picker (M18) in the same build;
//   · `expo-file-system` was ALREADY in the binary: it is a dependency of
//     `expo` itself, and `expo-modules-autolinking resolve` listed
//     `expo-file-system@57.0.6` among the linked modules before this change.
//     Declaring it here (at the ~57.0.7 the SDK install chose, with `expo`'s own
//     copy re-resolved to the same version so the tree holds ONE) adds no new
//     native module — it makes an import legal that would otherwise work only
//     by accident of pnpm's layout (the babel-preset-expo lesson).
//
// WHAT "SHARED" CAN AND CANNOT MEAN. `Sharing.shareAsync` resolves when the
// sheet closes and says nothing about what happened in it: on Android a person
// who picked WhatsApp and one who backed out are indistinguishable. So the
// outcome here is `closed`, never "sent", and the screens word it that way —
// the file is kept and one tap re-opens the sheet.

import * as FileSystem from "expo-file-system";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

export type ShareFileOutcome =
  /** The sheet opened and has been closed. Whether something was sent is unknowable. */
  | { outcome: "closed" }
  /** This device has no share target (or the module is missing). */
  | { outcome: "unavailable" }
  /** Writing, rendering or opening the sheet threw. */
  | { outcome: "failed"; detail: string };

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A file name a person can recognise in WhatsApp or Drive: lowercase ASCII,
 * digits and hyphens, never empty. Accents are folded, not dropped.
 */
export function safeFileName(base: string, extension: string): string {
  const slug = base
    // NFD splits "ñ" into "n" + a combining tilde; dropping every non-ASCII
    // code unit then keeps the letter and loses the mark. Deliberately not a
    // Unicode property escape: one regex Hermes cannot compile would take the
    // two screens importing this module down at load time.
    .normalize("NFD")
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug.length > 0 ? slug : "archivo"}.${extension}`;
}

async function openSheet(
  uri: string,
  options: { mimeType: string; UTI: string; dialogTitle: string },
): Promise<ShareFileOutcome> {
  let available = false;
  try {
    available = await Sharing.isAvailableAsync();
  } catch {
    available = false;
  }
  if (!available) return { outcome: "unavailable" };
  try {
    await Sharing.shareAsync(uri, options);
    return { outcome: "closed" };
  } catch (err) {
    return { outcome: "failed", detail: detailOf(err) };
  }
}

/**
 * Write `text` to a named file in the cache and share it. Overwrites a previous
 * file of the same name — the cache holds the latest export, not a history.
 */
export async function shareTextFile(
  text: string,
  fileName: string,
  options: { mimeType: string; UTI: string; dialogTitle: string },
): Promise<ShareFileOutcome> {
  let uri: string;
  try {
    const file = new FileSystem.File(FileSystem.Paths.cache, fileName);
    file.create({ overwrite: true });
    file.write(text);
    uri = file.uri;
  } catch (err) {
    return { outcome: "failed", detail: detailOf(err) };
  }
  return openSheet(uri, options);
}

/**
 * Render `html` to a PDF of the given page size and share it under `fileName`.
 *
 * The rename is best-effort: `printToFileAsync` writes a random name, and a
 * failure to copy it to a readable one still shares the PDF rather than
 * failing the whole act over a file name.
 */
export async function sharePdfFromHtml(
  html: string,
  page: { width: number; height: number },
  fileName: string,
  dialogTitle: string,
): Promise<ShareFileOutcome> {
  let uri: string;
  try {
    ({ uri } = await Print.printToFileAsync({ html, width: page.width, height: page.height }));
  } catch (err) {
    return { outcome: "failed", detail: detailOf(err) };
  }
  try {
    const named = new FileSystem.File(FileSystem.Paths.cache, fileName);
    if (named.exists) named.delete();
    await new FileSystem.File(uri).copy(named);
    uri = named.uri;
  } catch {
    // Keep the random name; the PDF itself is fine.
  }
  return openSheet(uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle });
}
