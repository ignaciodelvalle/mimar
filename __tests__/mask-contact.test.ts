// Unit tests for lib/mask-contact — pure functions, no DB needed.

import { describe, expect, it } from "vitest";

import { maskEmail, maskPhone } from "@/lib/utils/mask-contact";

describe("maskEmail", () => {
  it("keeps first char and full domain", () => {
    expect(maskEmail("juan.perez@gmail.com")).toBe("j•••@gmail.com");
    expect(maskEmail("maria@hotmail.com")).toBe("m•••@hotmail.com");
  });

  it("works for single-char local parts", () => {
    expect(maskEmail("a@example.com")).toBe("a•••@example.com");
  });

  it("preserves subdomains and TLDs", () => {
    expect(maskEmail("test@sub.domain.org")).toBe("t•••@sub.domain.org");
  });

  it("handles missing @ defensively", () => {
    expect(maskEmail("noemail")).toBe("n•••");
    expect(maskEmail("x")).toBe("x•••");
  });

  it("returns empty string for empty input", () => {
    expect(maskEmail("")).toBe("");
  });
});

describe("maskPhone", () => {
  it("shows last 4 digits for a normal-length number", () => {
    expect(maskPhone("+54 9 11 1234-5678")).toBe("•••• 5678");
    expect(maskPhone("0800 123 4321")).toBe("•••• 4321");
  });

  it("shows last 4 digits regardless of formatting characters", () => {
    expect(maskPhone("(011) 4567-8901")).toBe("•••• 8901");
  });

  it("shows last 3 digits for mid-length numbers", () => {
    expect(maskPhone("123456")).toBe("•••• 456");
    expect(maskPhone("1234567")).toBe("•••• 567");
  });

  it("shows all digits for very short numbers", () => {
    expect(maskPhone("12")).toBe("•••• 12");
  });

  it("returns empty string for empty input", () => {
    expect(maskPhone("")).toBe("");
  });
});
