// Unit tests for the DEN-XXXX-XXXX reference-code generator (id 924).
//
// Focus: the rejection-sampling bias guard. The previous implementation used
// `byte % 31`, which biases the alphabet because 256 is not a multiple of 31.
// These tests prove bytes in [248, 255] are rejected (never mapped) and that
// the output shape and alphabet remain correct.

import { afterEach, describe, expect, it, vi } from "vitest";
import { generateReferenceCode, isValidReferenceCodeFormat } from "../reference-code";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 chars

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateReferenceCode", () => {
  it("always produces the canonical DEN-XXXX-XXXX format", () => {
    for (let i = 0; i < 2000; i++) {
      expect(isValidReferenceCodeFormat(generateReferenceCode())).toBe(true);
    }
  });

  it("only emits characters from the unambiguous alphabet", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      for (const ch of generateReferenceCode().replace(/^DEN-|-/g, "")) {
        seen.add(ch);
      }
    }
    for (const ch of seen) {
      expect(ALPHABET).toContain(ch);
    }
    // Sanity: over 24k characters every alphabet symbol should appear.
    expect(seen.size).toBe(ALPHABET.length);
  });

  it("rejection-samples: bytes >= 248 are skipped, never mapped (no modulo bias)", () => {
    // Deterministic pool: a leading rejected byte (248) followed by 0..7, then
    // another rejected byte, then 8..14. Every 248/249/250... byte must be
    // discarded rather than folded via `% 31`.
    const scripted = [248, 0, 1, 2, 3, 4, 5, 6, 249, 7, 250, 8, 9, 10, 11, 12];
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = scripted[i] ?? 0;
        return arr;
      }) as typeof globalThis.crypto.getRandomValues,
    );

    const code = generateReferenceCode();
    // Accepted bytes in order: 0,1,2,3,4,5,6,7 → A,B,C,D,E,F,G,H
    // (248, 249, 250 are all rejected before reaching 8 accepted values).
    expect(code).toBe("DEN-ABCD-EFGH");
  });

  it("boundary: byte 247 is accepted, byte 248 is rejected", () => {
    // 247 % 31 === 30 → last alphabet char 'Z'... verify 247 maps, 248 skipped.
    const scripted = [247, 248, 0, 1, 2, 3, 4, 5, 6];
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = scripted[i] ?? 0;
        return arr;
      }) as typeof globalThis.crypto.getRandomValues,
    );

    const code = generateReferenceCode();
    // First accepted byte 247 → ALPHABET[247 % 31] = ALPHABET[30] = last char.
    expect(code[4]).toBe(ALPHABET[247 % 31]);
    // 248 was skipped, so the second char comes from byte 0 → 'A'.
    expect(code[5]).toBe(ALPHABET[0]);
  });
});
