// `date-input` — the mask's reversibility and the conversion's honesty.

import { describe, expect, it } from "@jest/globals";

import { dateInputToIso, isoToDateInput, maskDateInput, maskTimeInput } from "./date-input";

describe("maskDateInput — DD/MM/AAAA off a number pad", () => {
  it("lays eight digits out as a date, and drops what does not fit", () => {
    expect(maskDateInput("20082026")).toBe("20/08/2026");
    expect(maskDateInput("200820269")).toBe("20/08/2026");
  });

  it("keeps digits a person typed with their own separators or a paste", () => {
    expect(maskDateInput("20/08/2026")).toBe("20/08/2026");
    expect(maskDateInput("20-08-2026")).toBe("20/08/2026");
    expect(maskDateInput("20 08 2026")).toBe("20/08/2026");
  });

  it("NEVER ends in a separator, so backspace is not a trap", () => {
    // `20/` after two digits looks helpful; deleting the `/` hands the mask
    // `20`, the mask re-inserts the `/`, and the field is stuck forever.
    expect(maskDateInput("2")).toBe("2");
    expect(maskDateInput("20")).toBe("20");
    expect(maskDateInput("200")).toBe("20/0");
    expect(maskDateInput("2008")).toBe("20/08");
    expect(maskDateInput("20082")).toBe("20/08/2");
    // The round trip a backspace makes: what the keyboard hands back after
    // deleting one character is a valid input that masks to itself.
    expect(maskDateInput("20/08")).toBe("20/08");
    expect(maskDateInput("20/0")).toBe("20/0");
    expect(maskDateInput("")).toBe("");
  });

  it("masks a time the same way with a colon", () => {
    expect(maskTimeInput("0800")).toBe("08:00");
    expect(maskTimeInput("08")).toBe("08");
    expect(maskTimeInput("08:0")).toBe("08:0");
    expect(maskTimeInput("080000")).toBe("08:00");
  });
});

describe("dateInputToIso — what the person typed → what the contract takes", () => {
  it("converts DD/MM/AAAA and D/M/AAAA to the wire format", () => {
    expect(dateInputToIso("20/08/2026")).toBe("2026-08-20");
    expect(dateInputToIso("2/8/2026")).toBe("2026-08-02");
    expect(dateInputToIso("  20/08/2026 ")).toBe("2026-08-20");
  });

  it("passes the wire format through untouched", () => {
    expect(dateInputToIso("2026-08-20")).toBe("2026-08-20");
  });

  it("does NOT judge — a half-typed or impossible value reaches the schema as typed", () => {
    // The schema is the one vocabulary: `20/0` earns `*_MALFORMED` there, and
    // `31/02/2026` converts cleanly and earns `*_INVALID` from `isRealArDay`.
    expect(dateInputToIso("20/0")).toBe("20/0");
    expect(dateInputToIso("31/02/2026")).toBe("2026-02-31");
    expect(dateInputToIso("")).toBe("");
  });
});

describe("isoToDateInput — pre-filling today", () => {
  it("shows the wire format the way the field expects it", () => {
    expect(isoToDateInput("2026-09-06")).toBe("06/09/2026");
  });

  it("leaves anything else alone rather than mangling it", () => {
    expect(isoToDateInput("06/09/2026")).toBe("06/09/2026");
    expect(isoToDateInput("")).toBe("");
  });
});
