// @vitest-environment jsdom
//
// OrgPetSheetMounter — router-drop cure port (same pattern as
// app/(app)/mis-mascotas/[publicToken]/SheetMounter.tsx / SheetHost.interaction.test.tsx).
// Asserts closing calls closeSheetNav with a URL that strips only `sheet`
// while preserving unrelated params, and that router.push/replace/refresh
// are never invoked. Boilerplate lives in __tests__/helpers/sheet-nav-harness.tsx.

import "@testing-library/jest-dom/vitest";

import { describe, vi } from "vitest";

vi.mock("next/navigation", async () => {
  const h = await import("@/__tests__/helpers/sheet-nav-harness");
  return h.sheetNavigationMock("/org/refugio-abc/mascotas/pet-abc", "sheet=elegibilidad&foo=bar");
});
vi.mock("@/lib/ui/sheet-nav", async () => {
  const h = await import("@/__tests__/helpers/sheet-nav-harness");
  return h.sheetNavModuleMock();
});

import { testSheetClosesViaCleanNav } from "@/__tests__/helpers/sheet-nav-harness";
import { OrgPetSheetMounter } from "./OrgPetSheetMounter";

const baseProps = {
  orgToken: "refugio-abc",
  petPublicToken: "pet-abc",
  petName: "Firulais",
  petSpecies: "dog",
  canWriteEvents: false,
  canRecordClinical: false,
  eligibility: { eligible: null, reason: null, notes: null, until: null },
  currentChip: null,
  fosterName: null,
  canProposeReturn: false,
};

describe("<OrgPetSheetMounter> — sheet=elegibilidad close (router-hot-path fix)", () => {
  testSheetClosesViaCleanNav({
    render: () => <OrgPetSheetMounter {...baseProps} />,
    expectedCloseUrl: "/org/refugio-abc/mascotas/pet-abc?foo=bar",
  });
});
