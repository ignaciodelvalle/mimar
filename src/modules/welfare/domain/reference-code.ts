// Short reference code for anonymous welfare denuncias.
// Format: DEN-XXXX-XXXX using an unambiguous alphabet (no 0/O, no 1/I/l).
// Entropy ~8.5e11 combinations — generation does collision-check + retry at
// the repository layer (insertReportWithRetry handles 23505 loops).
//
// Uses Web Crypto (globalThis.crypto.getRandomValues) instead of node:crypto
// so this module can also be imported by client components (the
// /denuncias/buscar form imports the normalize + format-validate helpers).
// Web Crypto is available in Node 20+ and all modern browsers.
//
// Extracted verbatim from lib/welfare-codes.ts; lib/welfare-codes.ts becomes
// a re-export shim of this file.

/** Unambiguous alphabet: uppercase, no 0/O, no 1/I/l. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 chars

// Largest multiple of ALPHABET.length that fits in a single byte (0..255).
// Naïve `byte % 31` biases the distribution because 256 is not divisible by 31
// (residues 0..7 would be ~0.4% more likely than 8..30). Bytes >= this
// threshold are rejected and re-rolled, leaving a uniform draw over [0, 247]
// that maps cleanly to 31 values × 8 buckets. Mirrors lib/infra/publicToken.ts.
const REJECTION_THRESHOLD = 256 - (256 % ALPHABET.length); // 248

/**
 * Generate a candidate reference code of the shape DEN-XXXX-XXXX.
 * Uniqueness is NOT guaranteed here — the repository layer handles the
 * collision-retry loop (ON CONFLICT / pg 23505).
 *
 * Uses Web Crypto (getRandomValues) so this stays importable by client
 * components, with the same rejection-sampling bias guard as publicToken.ts.
 */
export function generateReferenceCode(): string {
  let code = "DEN-";
  let produced = 0;
  // Over-allocate the pool to amortize re-rolls; each character needs ~1.032
  // bytes on average (256 / 248). Refill almost never fires for 8 characters.
  let pool = new Uint8Array(16);
  crypto.getRandomValues(pool);
  let cursor = 0;
  while (produced < 8) {
    if (cursor >= pool.length) {
      pool = new Uint8Array(pool.length);
      crypto.getRandomValues(pool);
      cursor = 0;
    }
    const byte = pool[cursor++];
    if (byte >= REJECTION_THRESHOLD) continue; // bias guard
    code += ALPHABET[byte % ALPHABET.length];
    produced++;
    if (produced === 4) code += "-";
  }
  return code;
}

/** Regex for the canonical DEN-XXXX-XXXX format. Only uppercase allowed. */
const FORMAT_RE = /^DEN-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

/**
 * Normalize user input to the canonical code shape:
 *  - trim whitespace
 *  - uppercase
 *  - collapse internal whitespace (handles "DEN - ABCD - EFGH" → "DEN-ABCD-EFGH")
 */
export function normalizeReferenceCode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}

/**
 * Returns true if `input` matches the DEN-XXXX-XXXX format with the
 * unambiguous alphabet (uppercase, no 0/O, no 1/I/l).
 */
export function isValidReferenceCodeFormat(input: string): boolean {
  return FORMAT_RE.test(input);
}
