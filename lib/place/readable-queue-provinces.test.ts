// Who may READ the unresolved-place queue (localidades-por-id D9): a holder
// of a provincial authority unit, and only for that province.

import { describe, expect, it } from "vitest";

import { readableQueueProvinces } from "./unresolved-queue";

describe("readableQueueProvinces", () => {
  it("only provincial unit grants open a province's queue", () => {
    expect(
      readableQueueProvinces([
        { source: "province", provinceCode: "AR-B" },
        { source: "locality", provinceCode: "AR-X" },
        { source: "legacy", provinceCode: "AR-S" },
        { source: "province", provinceCode: "AR-B" },
      ]),
    ).toEqual(["AR-B"]);
  });

  it("no provincial unit grant, no queue", () => {
    expect(readableQueueProvinces([{ source: "locality", provinceCode: "AR-B" }])).toEqual([]);
    expect(readableQueueProvinces([])).toEqual([]);
  });
});
