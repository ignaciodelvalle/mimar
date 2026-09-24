// @vitest-environment jsdom
//
// ComoLlegarSheet — router-drop cure port (same pattern as
// app/(app)/mis-mascotas/[publicToken]/SheetMounter.tsx). Asserts closing
// calls closeSheetNav with a URL that strips only `sheet` while preserving
// unrelated params, and that router.push/replace/refresh are never invoked.
// Boilerplate lives in __tests__/helpers/sheet-nav-harness.tsx.

import "@testing-library/jest-dom/vitest";

import { describe, vi } from "vitest";

vi.mock("next/navigation", async () => {
  const h = await import("@/__tests__/helpers/sheet-nav-harness");
  return h.sheetNavigationMock("/refugios/refugio-abc", "sheet=como-llegar&foo=bar");
});
vi.mock("@/lib/ui/sheet-nav", async () => {
  const h = await import("@/__tests__/helpers/sheet-nav-harness");
  return h.sheetNavModuleMock();
});

import { testSheetClosesViaCleanNav } from "@/__tests__/helpers/sheet-nav-harness";
import { ComoLlegarSheet } from "./ComoLlegarSheet";

describe("<ComoLlegarSheet> — close (router-hot-path fix)", () => {
  testSheetClosesViaCleanNav({
    render: () => (
      <ComoLlegarSheet orgDisplayName="Refugio Abc" latitude={-34.6} longitude={-58.4} />
    ),
    expectedCloseUrl: "/refugios/refugio-abc?foo=bar",
  });
});
