// Generates short, human-friendly prefixed tokens used in QR tags and public
// URLs. Format: "PREFIX-XXXX-XXXX" where X is from an alphabet that excludes
// visually ambiguous characters (no 0/O, 1/I/l).
//
// Total entropy per chunk: 31^4. Two chunks: 31^8 ≈ 8.5e11 combinations.
// Collision probability is negligible until we have a *lot* of records; add
// a uniqueness check + retry per table when adoption justifies it.
//
// Uniformity: bytes are drawn from `crypto.randomBytes`, then mapped to
// alphabet indices via rejection sampling. Naïve `byte % 31` would bias the
// distribution because 256 is not divisible by 31 (the first 256 % 31 = 8
// alphabet values would be ~0.4% more likely than the last 23). Rejection
// sampling discards bytes in `[248, 255]` (the 8 trailing values) and
// re-rolls, leaving a uniform draw over `[0, 247]` that maps cleanly to
// 31 values × 8 buckets.
//
// Known prefixes:
//   DIM  — pet credential public token (pets.public_token)
//   LBR  — libreta share token (libreta_share_tokens.share_token)
//   APR  — approval request public token (approval_requests.public_token)
//   OFR  — service offering public token (service_offerings.public_token)
//   APT  — appointment public token (appointments.public_token)
//   INV  — organization invitation token (organization_invitations.invitation_token)
//   TAG  — physical tag serial (pet_tags.serial)

import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 chars
// Largest multiple of ALPHABET.length that fits in a single byte (0..255).
// Bytes >= REJECTION_THRESHOLD are rejected and re-rolled to keep the draw
// uniform.
const REJECTION_THRESHOLD = 256 - (256 % ALPHABET.length); // 248

function randomChunk(len: number): string {
  let out = "";
  // Over-allocate the pool to amortize re-rolls; each requested character
  // needs ~1.032 bytes on average (256 / 248). The inner loop drains the
  // pool first; if exhausted, we refill. With len <= 4 the refill almost
  // never fires.
  let pool = randomBytes(Math.max(len * 2, 32));
  let cursor = 0;
  while (out.length < len) {
    if (cursor >= pool.length) {
      pool = randomBytes(pool.length);
      cursor = 0;
    }
    const byte = pool[cursor++];
    if (byte >= REJECTION_THRESHOLD) continue; // bias guard
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

/**
 * Generate a prefixed, URL-safe identifier in the format `PREFIX-XXXX-XXXX`.
 * Each prefix has its own uniqueness scope (its own table's unique index).
 */
export function generatePrefixedToken(prefix: string): string {
  return `${prefix}-${randomChunk(4)}-${randomChunk(4)}`;
}

/** Backward-compat wrapper — generates a DIM-XXXX-XXXX pet public token. */
export function generatePublicToken(): string {
  // dim-codename-ok: the token prefix, at its single point of definition. Every
  // value this returns is hyphenated (DIM-XXXX-XXXX) and public by design; this
  // bare literal is the one place the prefix exists without its hyphen, and the
  // reason check-brand-casing.ts Rule 2 keys on the hyphen at all.
  return generatePrefixedToken("DIM");
}

/** Generates a LBR-XXXX-XXXX libreta share token. */
export function generateLibretaShareToken(): string {
  return generatePrefixedToken("LBR");
}

/** Generates an APR-XXXX-XXXX approval request public token. */
export function generateApprovalRequestToken(): string {
  return generatePrefixedToken("APR");
}

/** Generates an OFR-XXXX-XXXX service offering public token. */
export function generateOfferingToken(): string {
  return generatePrefixedToken("OFR");
}

/** Generates an APT-XXXX-XXXX appointment public token. */
export function generateAppointmentToken(): string {
  return generatePrefixedToken("APT");
}

/** Generates an INV-XXXX-XXXX organization invitation token. */
export function generateInvitationToken(): string {
  return generatePrefixedToken("INV");
}

/** Generates a TAG-XXXX-XXXX physical tag serial (pet_tags.serial). */
export function generateTagSerial(): string {
  return generatePrefixedToken("TAG");
}

/**
 * Generates an UNPREFIXED `XXXX-XXXX` physical-tag activation code (same
 * 31-char alphabet and uniform rejection sampler as the prefixed tokens).
 *
 * Deliberately prefix-free: the code is printed on the tag's WRAPPER as the
 * proof-of-possession secret for activation, distinct from the serial/QR on
 * the tag itself. It is stored ONLY as a peppered HMAC hash
 * (lib/utils/tag-code-hash.ts) — never persisted in plaintext.
 */
export function generateTagActivationCode(): string {
  return `${randomChunk(4)}-${randomChunk(4)}`;
}
