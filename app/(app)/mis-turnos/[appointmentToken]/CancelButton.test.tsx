// @vitest-environment jsdom
//
// CancelButton — router-drop cure port. This one used router.push() from a
// plain onClick handler (not even a <Link>) to OPEN the cancelar-turno
// sheet; ported to pushSheetUrl (native History API), same rationale as
// SheetTriggerLink.tsx.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { routerPush, routerReplace, routerRefresh, pushSheetUrl } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  routerRefresh: vi.fn(),
  pushSheetUrl: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/mis-turnos/tok-abc",
  useSearchParams: () => new URLSearchParams("foo=bar"),
  useRouter: () => ({ push: routerPush, replace: routerReplace, refresh: routerRefresh }),
}));

vi.mock("@/lib/ui/sheet-nav", () => ({
  pushSheetUrl,
}));

import { CancelButton } from "./CancelButton";

afterEach(() => {
  cleanup();
  pushSheetUrl.mockClear();
  routerPush.mockClear();
  routerReplace.mockClear();
  routerRefresh.mockClear();
});

describe("<CancelButton> — opens ?sheet=cancelar-turno", () => {
  it("clicking calls pushSheetUrl with the sheet param set, preserving other params, and never touches the router", () => {
    render(<CancelButton />);

    fireEvent.click(screen.getByRole("button", { name: "Cancelar turno" }));

    expect(pushSheetUrl).toHaveBeenCalledWith("/mis-turnos/tok-abc?foo=bar&sheet=cancelar-turno");
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
