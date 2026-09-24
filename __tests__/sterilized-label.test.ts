// Gender agreement for the sterilization label.
//
// Four surfaces show this fact: the public credential's Tier-2 medical block,
// the lost-pet listing, the adoption card, and the pet profile. Three inlined
// `sex === "female" ? "Castrada" : "Castrado"`; the fourth — the public
// credential, the one a stranger reads off a QR in the street — shipped the
// slashed "Castrado/a" and never looked at the sex it already had on the row.
// QA ronda 5 (2026-07-16) read it about Pampa, a female.

import { describe, expect, it } from "vitest";

import { lostLabel, sterilizedLabel } from "@/lib/utils/format";

describe("sterilizedLabel", () => {
  it("agrees with the pet's sex", () => {
    expect(sterilizedLabel("female")).toBe("Castrada");
    expect(sterilizedLabel("male")).toBe("Castrado");
  });

  // The inlined ternaries this helper replaces all read `=== "female"`, so an
  // unknown-sex pet was silently called male. The slash is honest HERE — it is
  // the one case where the system genuinely does not know.
  it("keeps the slashed form only when the sex is genuinely unknown", () => {
    expect(sterilizedLabel("unknown")).toBe("Castrado/a");
  });

  it("degrades to the slashed form for an unexpected value rather than guessing", () => {
    expect(sterilizedLabel("")).toBe("Castrado/a");
    expect(sterilizedLabel("Female")).toBe("Castrado/a");
  });
});

// Same defect, same file, two lines apart: the lost listing inlined
// `sex === "female" ? "Perdida" : "Perdido"`. 22k+ pets carry sex='unknown' —
// and a stray posted by a finder is exactly the population that does.
describe("lostLabel", () => {
  it("agrees with the pet's sex", () => {
    expect(lostLabel("female")).toBe("Perdida");
    expect(lostLabel("male")).toBe("Perdido");
  });

  it("does not call an unknown-sex pet male", () => {
    expect(lostLabel("unknown")).toBe("Perdido/a");
    expect(lostLabel("")).toBe("Perdido/a");
  });
});
