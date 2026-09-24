// @vitest-environment jsdom
//
// CuentaSheetMounter — router-drop cure port (same pattern as
// app/(app)/mis-mascotas/[publicToken]/SheetMounter.tsx / SheetHost.interaction.test.tsx).
// Asserts closing calls closeSheetNav with a URL that strips only `sheet`
// while preserving unrelated params, and that router.push/replace/refresh
// are never invoked. Boilerplate lives in __tests__/helpers/sheet-nav-harness.tsx.

import "@testing-library/jest-dom/vitest";

import { describe, vi } from "vitest";

vi.mock("next/navigation", async () => {
  const h = await import("@/__tests__/helpers/sheet-nav-harness");
  return h.sheetNavigationMock("/cuenta", "sheet=verificar-dni&foo=bar");
});
vi.mock("@/lib/ui/sheet-nav", async () => {
  const h = await import("@/__tests__/helpers/sheet-nav-harness");
  return h.sheetNavModuleMock();
});

import { testSheetClosesViaCleanNav } from "@/__tests__/helpers/sheet-nav-harness";
import { CuentaSheetMounter } from "./CuentaSheetMounter";

const baseProps = {
  initialProfile: {
    displayName: "Ana",
    phone: "",
    avatarUrl: "",
    preferredVetName: "",
    preferredVetPhone: "",
    emergencyContactName: "",
    emergencyContactPhone: "",
  },
  role: "owner",
  dniVerified: false,
};

describe("<CuentaSheetMounter> — sheet=verificar-dni close (router-hot-path fix)", () => {
  testSheetClosesViaCleanNav({
    render: () => <CuentaSheetMounter {...baseProps} />,
    expectedCloseUrl: "/cuenta?foo=bar",
  });
});
