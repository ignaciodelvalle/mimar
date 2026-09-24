// Extract the visible text of a pdf-lib document, for tests.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The exported PDFs are legal instruments — the Ley 14.346 denuncia goes to
// the Unidad Fiscal de Maltrato Animal — and until now nothing asserted what
// they actually SAY. Tests reached the pure builders that produce the strings
// and stopped there, so the wiring between a builder and the page was
// unverified: a renderer could quietly stop calling a formatter and every test
// would stay green. (Found exactly that way — a mutation that reverted the
// coordinate formatting in the renderer survived the whole suite.)
//
// No text-extraction dependency is needed. pdf-lib writes page content as
// Flate-compressed streams containing `<hex> Tj` show-text operators, so
// inflating the streams and hex-decoding the operands recovers the drawn text
// exactly. This is deliberately NOT a general PDF parser — it understands only
// the output pdf-lib produces, which is all these tests render.
//
// Encoding: pdf-lib's StandardFonts are WinAnsi (CP1252), so an em dash is one
// byte 0x97, not UTF-8. Decoding as CP1252 is what turns it back into "—".

import { inflateSync } from "node:zlib";

const HEX_SHOW_TEXT = /<([0-9A-Fa-f]*)>\s*Tj/g;

/** CP1252 decoder — the 0x80-0x9F range is where it differs from latin1. */
const cp1252 = new TextDecoder("windows-1252");

function inflateContentStreams(buf: Buffer): string {
  let out = "";
  let cursor = 0;
  while (true) {
    const start = buf.indexOf("stream", cursor);
    if (start === -1) break;
    let body = start + "stream".length;
    if (buf[body] === 0x0d) body++;
    if (buf[body] === 0x0a) body++;
    const end = buf.indexOf("endstream", body);
    if (end === -1) break;
    const raw = buf.subarray(body, end);
    try {
      out += `${inflateSync(raw).toString("latin1")}\n`;
    } catch {
      // Not Flate-encoded (or not a stream we can read) — fall back to raw so
      // an uncompressed document still yields its operators.
      out += `${raw.toString("latin1")}\n`;
    }
    cursor = end + "endstream".length;
  }
  return out;
}

/**
 * All text drawn on the document, one drawText call per line, in draw order.
 *
 * Returned as a single newline-joined string so a test can assert with
 * `toContain` on a phrase, or split it when the line structure matters.
 */
export function extractPdfText(bytes: Uint8Array): string {
  const operators = inflateContentStreams(Buffer.from(bytes));
  const lines: string[] = [];
  for (const match of operators.matchAll(HEX_SHOW_TEXT)) {
    const hex = match[1];
    if (hex.length === 0) continue;
    const octets = new Uint8Array(hex.length / 2);
    for (let i = 0; i < octets.length; i++) {
      octets[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    lines.push(cp1252.decode(octets));
  }
  return lines.join("\n");
}
