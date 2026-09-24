// RFC 6238 TOTP (HMAC-SHA1/256/512), for TEST HARNESSES ONLY — the e2e sign-in
// helper and the QA scripts that sign in as an institutional seed account, which
// since T2-S6 must answer a second-factor challenge. Production never computes a
// code: GoTrue verifies them.
//
// A dozen lines of node:crypto rather than a dependency: the algorithm is small,
// fixed by the RFC, and pinned below by the RFC's own test vectors
// (__tests__/mfa-institutional.test.ts).

import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 → bytes. Case-insensitive; padding and spaces ignored. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error(`base32Decode: invalid character ${JSON.stringify(char)}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export type TotpOptions = {
  /** Unix time in SECONDS. Default: now. */
  time?: number;
  /** Step in seconds (RFC default and GoTrue's: 30). */
  period?: number;
  /** Code length (GoTrue: 6). */
  digits?: number;
  algorithm?: "sha1" | "sha256" | "sha512";
};

/** The TOTP code for a raw key (bytes). */
export function totpFromKey(key: Buffer, opts: TotpOptions = {}): string {
  const { time = Date.now() / 1000, period = 30, digits = 6, algorithm = "sha1" } = opts;
  const counter = Math.floor(time / period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm, key).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The TOTP code for a base32 secret, as authenticator apps (and GoTrue) use. */
export function totp(secretBase32: string, opts: TotpOptions = {}): string {
  return totpFromKey(base32Decode(secretBase32), opts);
}

/** Seconds until the current step ends — to wait for a fresh code. */
export function secondsLeftInStep(period = 30, time = Date.now() / 1000): number {
  return period - (time % period);
}
