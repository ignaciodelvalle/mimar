// @vitest-environment jsdom
//
// PetDetailTabsPanel interaction test — the band "Girar" turn button
// (DocumentChrome) is the SINGLE face switcher (tarjeta-todo, re-affirming PO
// decision #645; the segmented tablist the July redesign restored is gone
// again). It writes ?tab= through goToFace (native History API). Same defect
// class as SheetHost.interaction.test.tsx's sheets: Next 15.5.x's App Router
// can silently drop a router.replace transition's own fetch in production
// (see lib/ui/sheet-nav.ts's module docblock). The Girar click path writes
// the URL via pushTabUrl (native History API) instead of router.replace —
// this file exercises the real click-driven path (RTL + jsdom) the way a
// production user would, and explicitly asserts that browser back restores
// the previous face (a popstate → useSearchParams() reactivity property that
// must not be assumed — see task contract). It also asserts the button's
// aria-pressed state and that focus lands on the newly-shown face after a
// flip, since the flip control now carries the FULL accessible-nav contract
// the removed tablist used to own.
//
// next/navigation is mocked the same way as SheetHost.interaction.test.tsx:
// jsdom's real history.pushState/replaceState is wrapped to notify
// subscribed components, mirroring Next's own patch. useRouter's
// push/replace are spies — a sanity net that fails loudly if either click
// path regresses back onto the router.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}

function usePseudoRouterSubscription() {
  const [, forceRender] = React.useState(0);
  React.useEffect(() => {
    const onChange = () => forceRender((n) => n + 1);
    listeners.add(onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);
}

const routerPush = vi.fn();
const routerReplace = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => {
    usePseudoRouterSubscription();
    return window.location.pathname;
  },
  useSearchParams: () => {
    usePseudoRouterSubscription();
    return new URLSearchParams(window.location.search);
  },
  // Sanity net: if either click path (Girar / tab buttons) — or the
  // legacy-hash-sync mount effect, ported to replaceTabUrl (native History
  // API) in the same router-drop cure — ever falls back to
  // router.push/replace, these spies make that regression visible.
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
}));

import { PetDetailTabsPanel } from "@/components/pet-profile/PetDetailTabsPanel";

let originalPushState: typeof window.history.pushState;
let originalReplaceState: typeof window.history.replaceState;

beforeEach(() => {
  routerPush.mockClear();
  routerReplace.mockClear();

  // matchMedia reports REDUCED motion so FlipCard's edge-on turn resolves as an
  // INSTANT face swap — the displayed face (and its band turn button) updates
  // synchronously within the click's act(), instead of after the ~485ms
  // animation timers. This test exercises the router/nav contract, not the
  // animation; the instant path keeps every assertion synchronous. (Overwrite
  // unconditionally — jsdom ships no matchMedia, but a prior test may have set
  // a matches:false stub that must not win here.)
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ??
    (class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver);

  // jsdom implements neither scrollIntoView nor the rAF timing the component
  // uses around it (PetDetailTabsPanel.tsx ~189). Without this stub the call
  // throws INSIDE a requestAnimationFrame callback AFTER the test completed —
  // an unhandled async exception that intermittently kills the vitest worker
  // fork ("Worker exited unexpectedly" with zero failed tests).
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn();

  window.history.replaceState(null, "", "/mis-mascotas/abc123");
  originalPushState = window.history.pushState.bind(window.history);
  originalReplaceState = window.history.replaceState.bind(window.history);
  // Mirrors Next's own patch: notify subscribers after a shallow URL change.
  window.history.pushState = (...args: Parameters<typeof window.history.pushState>) => {
    originalPushState(...args);
    notify();
  };
  window.history.replaceState = (...args: Parameters<typeof window.history.replaceState>) => {
    originalReplaceState(...args);
    notify();
  };
});

afterEach(() => {
  cleanup();
  window.history.pushState = originalPushState;
  window.history.replaceState = originalReplaceState;
  listeners.clear();
});

function renderPanel(initialFace: "credencial" | "libreta" = "credencial") {
  return render(
    <PetDetailTabsPanel
      petPublicToken="abc123"
      credencialContent={<div>CREDENCIAL-CONTENT</div>}
      // PF3 perf fix: both faces now arrive as pre-rendered nodes (the page
      // resolves Libreta server-side inside its own Suspense) — no more
      // client-side getLibretaFaceData fetch to mock here.
      libretaContent={<div>LIBRETA-CONTENT</div>}
      initialFace={initialFace}
      isOwner
    />,
  );
}

describe("PetDetailTabsPanel — Girar affordance (router-hot-path fix)", () => {
  it("starts on Credencial with aria-pressed=false (Libreta not active)", () => {
    renderPanel("credencial");

    expect(screen.getByRole("button", { name: "Girar a Libreta" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("clicking Girar flips the face and updates the URL to ?tab=libreta — no router involved", () => {
    renderPanel("credencial");

    expect(window.location.search).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Girar a Libreta" }));

    expect(window.location.search).toBe("?tab=libreta");
    const flipped = screen.getByRole("button", { name: "Girar a Credencial" });
    expect(flipped).toBeInTheDocument();
    expect(flipped).toHaveAttribute("aria-pressed", "true");
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("clicking Girar again flips back to Credencial and strips ?tab=/?lente=", () => {
    renderPanel("credencial");

    fireEvent.click(screen.getByRole("button", { name: "Girar a Libreta" }));
    expect(window.location.search).toBe("?tab=libreta");

    fireEvent.click(screen.getByRole("button", { name: "Girar a Credencial" }));
    expect(window.location.search).toBe("");
    const flipped = screen.getByRole("button", { name: "Girar a Libreta" });
    expect(flipped).toBeInTheDocument();
    expect(flipped).toHaveAttribute("aria-pressed", "false");
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("browser back after a Girar click restores the previous face via popstate", async () => {
    renderPanel("credencial");

    fireEvent.click(screen.getByRole("button", { name: "Girar a Libreta" }));
    expect(window.location.search).toBe("?tab=libreta");

    act(() => {
      window.history.back();
    });

    // jsdom (like real browsers) processes history navigation as a queued
    // task — assertions after it need waitFor (see SheetHost.interaction.test.tsx).
    // The face swap (displayedFace) lags the URL by an effect tick, so await the
    // restored front turn button too rather than asserting it synchronously.
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Girar a Libreta" })).toBeInTheDocument();
    });
  });

  it("renders NO tablist and NO tabs — the band button is the single flip control", () => {
    // History guard: the tablist was removed by PO decision #645, restored by
    // the July redesign, and removed again by tarjeta-todo. It must not
    // quietly return a third time (lint:tablist ratchets the same invariant
    // at the source level).
    renderPanel("credencial");

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    // The single switcher is reachable and carries the full contract:
    // descriptive target-naming label + pressed state.
    const turn = screen.getByRole("button", { name: "Girar a Libreta" });
    expect(turn).toHaveAttribute("aria-pressed", "false");
  });

  it("labels both faces as named regions so the back face is discoverable by name", () => {
    renderPanel("credencial");

    // The shown face exposes its accessible region name…
    expect(
      screen.getByRole("region", { name: "Credencial · frente del documento" }),
    ).toBeInTheDocument();
    // …and the hidden back face (aria-hidden + display:none until flipped)
    // carries the same named-region wiring, ready for when it is shown.
    const back = document.getElementById("pet-face-libreta");
    expect(back?.tagName).toBe("SECTION");
    expect(back).toHaveAttribute("aria-label", "Libreta · dorso del documento");

    // Flip: the back face becomes the exposed named region.
    fireEvent.click(screen.getByRole("button", { name: "Girar a Libreta" }));
    expect(
      screen.getByRole("region", { name: "Libreta · dorso del documento" }),
    ).toBeInTheDocument();
  });

  it("moves focus onto the newly-shown face after a Girar flip (single-control a11y)", async () => {
    renderPanel("credencial");

    fireEvent.click(screen.getByRole("button", { name: "Girar a Libreta" }));

    // Focus lands on the back-face container (tabIndex=-1, focused by id) so a
    // keyboard/screen-reader user is taken to the content that appeared.
    //
    // THIS ASSERTION CANNOT FAIL FOR THE REASON IT LOOKS LIKE IT CHECKS.
    // jsdom lets .focus() land on a `display:none` element; a real browser
    // ignores it silently. So this stayed green for months while Chromium left
    // focus on <body> after every flip — measured 2026-07-28, activeElement was
    // BODY four seconds after the keypress. The cause was focusing on the
    // `activeFace` change, ~205ms before FlipCard's turn actually swaps the
    // painted face; the fix routes focus through FlipCard.onFaceShown.
    //
    // Keep this test — it pins the wiring — but the guard that would catch a
    // regression is e2e/a11y-regression.spec.ts ("the band Girar button is
    // keyboard-operable…"), which runs in a real browser. Do not treat a green
    // here as evidence that focus moves.
    await waitFor(() => {
      expect(document.activeElement?.id).toBe("pet-face-libreta");
    });

    // And flipping back returns focus to the front face.
    fireEvent.click(screen.getByRole("button", { name: "Girar a Credencial" }));
    await waitFor(() => {
      expect(document.activeElement?.id).toBe("pet-face-credencial");
    });
  });
});

describe("PetDetailTabsPanel — deep-link parity (unaffected by the router-hot-path fix)", () => {
  it("a direct load with ?tab=vacunas already in the URL renders the Libreta face without any click", () => {
    window.history.replaceState(null, "", "/mis-mascotas/abc123?tab=vacunas");
    renderPanel("libreta");

    expect(screen.getByRole("button", { name: "Girar a Credencial" })).toBeInTheDocument();
  });
});

describe("PetDetailTabsPanel — legacy #hash mount migration (replaceTabUrl, router-hot-path fix)", () => {
  it("a legacy #libreta hash on load normalizes the URL via history.replaceState — no router.replace involved", async () => {
    window.history.replaceState(null, "", "/mis-mascotas/abc123#libreta");
    renderPanel("credencial");

    await waitFor(() => {
      expect(window.location.search).toBe("?tab=libreta");
    });
    expect(routerReplace).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });
});
