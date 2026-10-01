// The web half of the finder-contact split.
//
// WHAT THIS FILE IS DEFENDING. `finderContact` is one text column carrying up to
// two contacts, joined by `CONTACT_SEPARATOR` by the finder action. Every
// consumer that read it as ONE value produced a broken link: `LostScanFeed`
// rendered `tel:11 4123-4567 / ana@example.com`, a URL no dialer accepts, on the
// one surface whose entire purpose is reaching the person holding the animal.
//
// The expected values below are written out literally rather than derived from
// the functions under test, so a broken implementation and a passing test cannot
// agree with each other.

import { describe, expect, it } from "vitest";

import {
  CONTACT_SEPARATOR,
  contactLink,
  contactPartLinks,
  contactParts,
  hasReachableContact,
} from "@/lib/utils/contact-parts";

describe("CONTACT_SEPARATOR", () => {
  it("is the exact literal the finder action joins with", () => {
    expect(CONTACT_SEPARATOR).toBe(" / ");
  });
});

describe("contactParts", () => {
  it("splits the two-contact string the finder action writes", () => {
    expect(contactParts("11 4123-4567 / ana@example.com")).toEqual([
      "11 4123-4567",
      "ana@example.com",
    ]);
  });

  it("yields one part for a single contact, unchanged", () => {
    expect(contactParts("11 4123-4567")).toEqual(["11 4123-4567"]);
    expect(contactParts("ana@example.com")).toEqual(["ana@example.com"]);
  });

  it("trims each part and drops empties", () => {
    expect(contactParts("  11 4123-4567   /    /  ana@example.com  ")).toEqual([
      "11 4123-4567",
      "ana@example.com",
    ]);
  });

  it("drops duplicates — one contact written twice is one target", () => {
    expect(contactParts("11 4123-4567 / 11 4123-4567")).toEqual(["11 4123-4567"]);
  });

  it("keeps the order the finder wrote (phone first, as the action builds it)", () => {
    expect(contactParts("ana@example.com / 11 4123-4567")).toEqual([
      "ana@example.com",
      "11 4123-4567",
    ]);
  });

  it("does not split on a bare slash — the separator is spaced", () => {
    // A finder who types "Casa/Trabajo: 11 4123-4567" leaves ONE contact.
    expect(contactParts("Casa/Trabajo: 11 4123-4567")).toEqual(["Casa/Trabajo: 11 4123-4567"]);
  });

  it("returns nothing for an empty or blank value", () => {
    expect(contactParts("")).toEqual([]);
    expect(contactParts("   ")).toEqual([]);
  });
});

describe("contactLink", () => {
  it("routes anything with an @ to mailto:", () => {
    expect(contactLink("ana@example.com")).toEqual({
      href: "mailto:ana@example.com",
      label: "Escribir a ana@example.com",
      kind: "email",
    });
  });

  it("strips spaces and dashes out of a tel: href but keeps them on screen", () => {
    // "tel:11 4123-4567" is rejected by some dialers; the LABEL keeps the shape
    // the finder typed, because that is what the owner will read aloud.
    expect(contactLink("11 4123-4567")).toEqual({
      href: "tel:1141234567",
      label: "Llamar al 11 4123-4567",
      kind: "phone",
    });
  });

  it("keeps a leading + and only a leading one", () => {
    expect(contactLink("+54 9 11 4123-4567")?.href).toBe("tel:+5491141234567");
    expect(contactLink("54+9+11 4123-4567")?.href).toBe("tel:5491141234567");
  });

  it("refuses a value too short to dial", () => {
    expect(contactLink("12345")).toBeNull();
    expect(contactLink("preguntá por Ana")).toBeNull();
  });

  it("never routes an e-mail through tel:", () => {
    // The defect in one assertion: an address turned into a tel: href reads
    // "Llamar al ana@…" to a screen reader and then fails against the dialer.
    expect(contactLink("ana@example.com")?.kind).toBe("email");
  });
});

describe("contactPartLinks", () => {
  it("pairs every part with its own link", () => {
    expect(contactPartLinks("11 4123-4567 / ana@example.com")).toEqual([
      {
        part: "11 4123-4567",
        link: { href: "tel:1141234567", label: "Llamar al 11 4123-4567", kind: "phone" },
      },
      {
        part: "ana@example.com",
        link: {
          href: "mailto:ana@example.com",
          label: "Escribir a ana@example.com",
          kind: "email",
        },
      },
    ]);
  });

  it("keeps an unlinkable part with a null link rather than dropping it", () => {
    expect(contactPartLinks("preguntá por Ana / ana@example.com")).toEqual([
      { part: "preguntá por Ana", link: null },
      {
        part: "ana@example.com",
        link: {
          href: "mailto:ana@example.com",
          label: "Escribir a ana@example.com",
          kind: "email",
        },
      },
    ]);
  });

  it("returns nothing for a blank value", () => {
    expect(contactPartLinks("  ")).toEqual([]);
  });
});

// The bar the finder flows hold a report to (PO 2026-10-01): at least one part
// the owner can actually use. Not "non-empty" — "x" is not empty and is exactly
// as much of a dead end as nothing.
describe("hasReachableContact", () => {
  it.each([
    ["11 4123-4567", true],
    ["+54 9 11 4123-4567", true],
    ["ana@example.com", true],
    ["1111 / ana@example.com", true],
    ["11-4123-4567 / no sé", true],
    ["", false],
    ["   ", false],
    ["1111", false],
    ["por la plaza", false],
    [" / ", false],
  ])("%j -> %s", (value, expected) => {
    expect(hasReachableContact(value)).toBe(expected);
  });
});
