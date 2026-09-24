// Unit tests for helpers in app/r/invite/[token]/helpers.ts.

import { describe, expect, it } from "vitest";

import { maskEmail } from "@/app/r/invite/[token]/helpers";

describe("maskEmail", () => {
  it("masks a standard email", () => {
    expect(maskEmail("juan@refugio.org")).toBe("j***@refugio.org");
  });

  it("masks when local part is a single character", () => {
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
  });

  it("masks a longer local part — only first char shown", () => {
    expect(maskEmail("johndoe@example.com")).toBe("j***@example.com");
  });

  it("returns *** when there is no @ sign", () => {
    expect(maskEmail("notanemail")).toBe("***");
  });

  it("returns *** when @ is the first character (empty local part)", () => {
    expect(maskEmail("@example.com")).toBe("***");
  });

  it("preserves the full domain including subdomains", () => {
    expect(maskEmail("user@mail.sub.example.ar")).toBe("u***@mail.sub.example.ar");
  });
});
