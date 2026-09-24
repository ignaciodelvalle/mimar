// @vitest-environment jsdom
//
// X1-F4: the mobile capture action must not ride the router's hot path.
//
// lib/ui/sheet-nav.ts exists because "the Anotar icon fail 3/3 in production…
// the router must never sit on their hot path". The pet profile's own "Anotar"
// honours that through SheetTriggerLink. The tab bar's central "Asentar" slot,
// WHILE ON A PROFILE, used a plain <Link> to the same route — a router
// same-route soft-nav, which is exactly the shape that failed 3/3 and caused the
// module to be written. The owner's number-one capture action was protected or
// exposed depending on which pixel their thumb covered.
//
// Static markup cannot tell the two apart (an onClick does not serialise), so
// this test clicks.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushSheetUrl = vi.fn();
vi.mock("@/lib/ui/sheet-nav", () => ({
  pushSheetUrl: (url: string) => pushSheetUrl(url),
  closeSheetUrl: vi.fn(),
  replaceTabUrl: vi.fn(),
  pushTabUrl: vi.fn(),
}));

const pathnameRef = { current: "/mis-mascotas/DIM-PAMP-0001" as string | null };
vi.mock("next/navigation", () => ({ usePathname: () => pathnameRef.current }));

import { CitizenTabBar } from "@/components/layout/CitizenTabBar";
import { OWNER_NAV } from "@/components/layout/nav-presets";

function clickAsentar(pathname: string | null, ownedPetsCount = 3) {
  pathnameRef.current = pathname;
  render(<CitizenTabBar nav={OWNER_NAV} ownedPetsCount={ownedPetsCount} />);
  const link = screen.getByText("Asentar").closest("a");
  if (!link) throw new Error("no Asentar anchor rendered");
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  fireEvent(link, event);
  return event;
}

describe("CitizenTabBar — Asentar opens the sheet off the router hot path", () => {
  beforeEach(() => {
    cleanup();
    pushSheetUrl.mockClear();
  });

  it("on a pet profile, the click is intercepted and pushed as a sheet URL", () => {
    const event = clickAsentar("/mis-mascotas/DIM-PAMP-0001");
    expect(pushSheetUrl).toHaveBeenCalledWith("/mis-mascotas/DIM-PAMP-0001?sheet=anotar");
    expect(event.defaultPrevented).toBe(true);
  });

  it("on a profile SUB-route too — the same pet, the same immune path", () => {
    clickAsentar("/mis-mascotas/DIM-PAMP-0001/libreta");
    expect(pushSheetUrl).toHaveBeenCalledWith("/mis-mascotas/DIM-PAMP-0001?sheet=anotar");
  });

  it("elsewhere it stays a real CROSS-route navigation — /inicio forwards the param", () => {
    // Not a same-route sheet open: /inicio server-redirects to the most urgent
    // pet AND carries ?sheet=anotar, which is one navigation and correct.
    const event = clickAsentar("/mis-mascotas");
    expect(pushSheetUrl).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  // D.8: with zero owned pets the slot is the alta, so there is no sheet to
  // open at all — it must stay a plain cross-route navigation.
  it("with zero pets the slot is the alta and never touches the sheet router", () => {
    pathnameRef.current = "/mis-mascotas";
    render(<CitizenTabBar nav={OWNER_NAV} ownedPetsCount={0} />);
    const link = screen.getByText("Registrar mascota").closest("a");
    if (!link) throw new Error("no alta anchor rendered");
    expect(link.getAttribute("href")).toBe("/mis-mascotas/nueva");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    fireEvent(link, event);
    expect(pushSheetUrl).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
