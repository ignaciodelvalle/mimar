// `contactLink` — the phone-or-email decision `ContactRow` renders around —
// and `contactLinks`, which is that decision applied to a field carrying two.

import { describe, expect, it } from "@jest/globals";

import { contactLink, contactLinks, contactParts } from "./contact-link";

describe("email", () => {
  it("routes through mailto:, never tel: — an '@' value read as a phone used to open a dead tel: link", () => {
    expect(contactLink("juan@example.com")).toEqual({
      href: "mailto:juan@example.com",
      label: "Escribir a juan@example.com",
      kind: "email",
    });
  });
});

describe("phone", () => {
  it("sanitizes spaces/dashes for the href but keeps the original spacing in the label", () => {
    expect(contactLink("+54 294 412-3456")).toEqual({
      href: "tel:+542944123456",
      label: "Llamar al +54 294 412-3456",
      kind: "phone",
    });
  });

  it("keeps a plain local number without a leading +", () => {
    expect(contactLink("11 4123-4567")).toEqual({
      href: "tel:1141234567",
      label: "Llamar al 11 4123-4567",
      kind: "phone",
    });
  });
});

describe("unlinkable", () => {
  it("returns null for text with no '@' and fewer than 6 digits", () => {
    expect(contactLink("abc")).toBeNull();
  });

  it("returns null right at the boundary — 5 digits is too short", () => {
    expect(contactLink("12345")).toBeNull();
  });

  it("links at the boundary — 6 digits is enough", () => {
    expect(contactLink("123456")?.kind).toBe("phone");
  });
});

describe("contactLinks — one field, two contacts", () => {
  it("splits the phone-and-email value the web writes, instead of mailto:-ing the whole string", () => {
    // The exact shape of encontre/action.ts:218-219 when a finder leaves both.
    // Read as ONE value this used to become
    // "mailto:11 4123-4567 / ana@example.com" — unsendable, with the phone
    // number buried inside the address.
    expect(contactLinks("11 4123-4567 / ana@example.com")).toEqual([
      { href: "tel:1141234567", label: "Llamar al 11 4123-4567", kind: "phone" },
      { href: "mailto:ana@example.com", label: "Escribir a ana@example.com", kind: "email" },
    ]);
  });

  it("leaves a single phone exactly as contactLink does — no separator, no split", () => {
    expect(contactLinks("11 4123-4567")).toEqual([
      { href: "tel:1141234567", label: "Llamar al 11 4123-4567", kind: "phone" },
    ]);
  });

  it("leaves a single email exactly as contactLink does", () => {
    expect(contactLinks("ana@example.com")).toEqual([
      { href: "mailto:ana@example.com", label: "Escribir a ana@example.com", kind: "email" },
    ]);
  });

  it("returns [] when no half can become a link — the caller falls back to plain text", () => {
    expect(contactLinks("abc / def")).toEqual([]);
  });

  it("drops only the half that cannot link, and keeps the one that can", () => {
    expect(contactLinks("abc / ana@example.com").map((l) => l.href)).toEqual([
      "mailto:ana@example.com",
    ]);
  });
});

describe("contactParts", () => {
  it("trims each half — the separator is written with spaces around it", () => {
    expect(contactParts("11 4123-4567 / ana@example.com")).toEqual([
      "11 4123-4567",
      "ana@example.com",
    ]);
  });

  it("does not split on a slash that is not the separator", () => {
    // A slash inside one contact ("Av. Corrientes 1234 1/2") is not a boundary:
    // only the exact " / " the producer writes is.
    expect(contactParts("11/4123-4567")).toEqual(["11/4123-4567"]);
  });

  it("drops an empty half — a trailing separator is not a second contact", () => {
    expect(contactParts("ana@example.com / ")).toEqual(["ana@example.com"]);
  });

  it("collapses the same contact written twice into one row's worth", () => {
    expect(contactParts("11 4123-4567 / 11 4123-4567")).toEqual(["11 4123-4567"]);
  });
});
