import { CREDENTIAL_SITUATION_KEYS } from "@dim/contract/credential";
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import {
  FICHA_FIXTURES,
  fichaSituationsShown,
} from "@/app/(public)/design/ficha-estados/ficha-fixtures";

describe("owner ficha preview fixtures", () => {
  it("shows every product situation", () => {
    expect(fichaSituationsShown().sort()).toEqual([...CREDENTIAL_SITUATION_KEYS].sort());
  });

  it("includes a new pet, a stack of notices, and a memorial without actions", () => {
    const nueva = FICHA_FIXTURES.find((f) => f.id === "nueva");
    const avisos = FICHA_FIXTURES.find((f) => f.id === "avisos");
    const memorial = FICHA_FIXTURES.find((f) => f.id === "fallecida");
    expect(nueva?.firstSteps?.length).toBeGreaterThan(0);
    expect(avisos?.notices.length).toBeGreaterThanOrEqual(4);
    expect(memorial).toMatchObject({ cell: "none", showActions: false, flip: false });
  });

  it("is a gated design preview", () => {
    const page = readFileSync("app/(public)/design/ficha-estados/page.tsx", "utf8");
    expect(page).toContain("gateDesignPreview()");
  });
});
