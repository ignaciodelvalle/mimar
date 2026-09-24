// `date-input` — the mask's reversibility and the conversion's honesty.

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";

import {
  dateInputToIso,
  dateInputToLocalDate,
  isoDayToLocalDate,
  isoToDateInput,
  localDateToDateInput,
  localDateToTimeInput,
  maskDateInput,
  maskTimeInput,
  timeInputToLocalDate,
} from "./date-input";

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

describe("the native picker's crossing — Date in, the same masked strings out", () => {
  // PINNED TO ARGENTINA, so the 23:59 case below is 02:59 of the NEXT day in
  // UTC. On a UTC runner an implementation reading `getUTCDate()` would pass
  // unpinned; here it cannot. Restored after, because jest reuses a worker
  // across files and the zone is process-wide.
  const savedTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Argentina/Buenos_Aires";
  });
  afterAll(() => {
    // Not `= undefined`: process.env stringifies it to the zone "undefined".
    if (savedTz === undefined) Reflect.deleteProperty(process.env, "TZ");
    else process.env.TZ = savedTz;
  });

  it("reads a typed or ISO day as a local noon Date, and refuses a day that does not exist", () => {
    const d = dateInputToLocalDate("05/08/2026");
    expect(d === null ? null : [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([
      2026, 7, 5, 12,
    ]);
    expect(isoDayToLocalDate("2026-08-05")?.getTime()).toBe(d?.getTime());
    expect(dateInputToLocalDate("31/02/2026")).toBeNull();
    expect(dateInputToLocalDate("20/0")).toBeNull();
    expect(dateInputToLocalDate("")).toBeNull();
  });

  it("writes a picked day exactly as the mask draws the same eight digits", () => {
    const picked = new Date(2026, 7, 5, 23, 59);
    // The pin is live: in UTC this instant is already the 6th.
    expect(picked.getUTCDate()).toBe(6);
    expect(localDateToDateInput(picked)).toBe(maskDateInput("05082026"));
    expect(localDateToDateInput(picked)).toBe("05/08/2026");
  });

  it("round-trips a time on a 24-hour clock, and refuses one that is not a time", () => {
    const base = new Date(2026, 7, 5, 12);
    const t = timeInputToLocalDate("08:05", base);
    expect(t === null ? null : localDateToTimeInput(t)).toBe("08:05");
    expect(localDateToTimeInput(new Date(2026, 7, 5, 21, 30))).toBe("21:30");
    expect(timeInputToLocalDate("24:00", base)).toBeNull();
    expect(timeInputToLocalDate("8", base)).toBeNull();
  });
});
