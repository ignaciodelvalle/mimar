// `useScrollToError` — the transition rule, the courtesy rule, and the door.
//
// The web hook this mirrors moves focus ONLY when the error appears, never
// when one message replaces another; the scroll inherits that contract, and
// these tests are what hold it. And every native call is best-effort: no
// provider, no anchor, no measurement — no crash, because the refusal is
// already announced by the live region and the scroll is a courtesy.
//
// THE DOOR (forms-F4): the hook is called from the component that RENDERS the
// Screen, which is above the context provider. The last describe proves the
// scroll fires from exactly that shape — the one every real screen has and the
// one the context-only hook silently never served.

import { describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import type { RefObject } from "react";
import { type ScrollView, View } from "react-native";

import { Screen, ScreenScrollContext } from "./kit";
import { SPACE } from "./theme";
import { type ScrollToError, useScrollToError } from "./use-scroll-to-error";

const HOST = { fake: "inner-view-node" };

function makeScroll() {
  const scrollTo = jest.fn();
  const scrollRef = {
    current: { getInnerViewNode: () => HOST, scrollTo },
  } as unknown as RefObject<ScrollView | null>;
  return { scrollRef, scrollTo };
}

/** An anchor whose measurement resolves at the given content-relative y. */
function anchorAt(y: number): View {
  return {
    measureLayout: (_host: unknown, onSuccess: (x: number, y: number) => void) => onSuccess(0, y),
  } as unknown as View;
}

let anchorRef: RefObject<View | null>;

function Harness({ error }: { error: string | null }) {
  anchorRef = useScrollToError(error).anchorRef;
  return null;
}

function renderHarness(scrollRef: RefObject<ScrollView | null>, anchorY: number) {
  const ui = (error: string | null) => (
    <ScreenScrollContext.Provider value={scrollRef}>
      <Harness error={error} />
    </ScreenScrollContext.Provider>
  );
  const screen = render(ui(null));
  anchorRef.current = anchorAt(anchorY);
  return { rerender: (error: string | null) => screen.rerender(ui(error)) };
}

describe("the transition rule — scroll when the error APPEARS", () => {
  it("scrolls the anchor into view, with breathing room above it", () => {
    const { scrollRef, scrollTo } = makeScroll();
    const { rerender } = renderHarness(scrollRef, 480);
    rerender("Revisá los datos.");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: 480 - SPACE.lg, animated: true });
  });

  it("clamps to the top rather than scrolling to a negative offset", () => {
    const { scrollRef, scrollTo } = makeScroll();
    const { rerender } = renderHarness(scrollRef, 4);
    rerender("Revisá los datos.");
    expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: true });
  });

  it("does NOT re-scroll when one message replaces another — the web hook's rule", () => {
    const { scrollRef, scrollTo } = makeScroll();
    const { rerender } = renderHarness(scrollRef, 480);
    rerender("Primer error.");
    rerender("Segundo error.");
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("scrolls again after the error CLEARED and a new one appeared — a fresh failure", () => {
    // The denuncia form clears its error on every keystroke (patch()), so a
    // fixed-and-resubmitted form that fails again is a new appearance.
    const { scrollRef, scrollTo } = makeScroll();
    const { rerender } = renderHarness(scrollRef, 480);
    rerender("Primer error.");
    rerender(null);
    rerender("Segundo error.");
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});

describe("the courtesy rule — degrade to no-scroll, never to a crash", () => {
  it("no provider and no scrollRef attached: nothing happens", () => {
    const screen = render(<Harness error={null} />);
    expect(() => screen.rerender(<Harness error="Sin Screen." />)).not.toThrow();
  });

  it("no anchor mounted when the error appears: nothing happens", () => {
    const { scrollRef, scrollTo } = makeScroll();
    const ui = (error: string | null) => (
      <ScreenScrollContext.Provider value={scrollRef}>
        <Harness error={error} />
      </ScreenScrollContext.Provider>
    );
    const screen = render(ui(null));
    // anchorRef.current left null on purpose.
    anchorRef.current = null;
    screen.rerender(ui("Sin ancla."));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe("the door — called ABOVE the Screen it renders, like every real form screen", () => {
  let refs: ScrollToError;

  function OwnScreen({ error }: { error: string | null }) {
    refs = useScrollToError(error);
    return (
      <Screen scrollRef={refs.scrollRef}>
        {/* Mounted from the start so React sets the ref ONCE, on mount, and the
            fake anchor installed below survives the rerender. */}
        <View ref={refs.anchorRef} />
      </Screen>
    );
  }

  it("scrolls through the ref the Screen attached — the shape the context never reached", () => {
    // BEFORE forms-F4 this exact shape scrolled nothing: the hook read a
    // context whose provider is inside Screen, so from here it saw null.
    const ui = (error: string | null) => <OwnScreen error={error} />;
    const screen = render(ui(null));

    // The Screen attached the hook's own ref to its ScrollView.
    const attached = refs.scrollRef.current;
    expect(attached).not.toBeNull();

    // jest has no layout: stub the two native calls ON THE ATTACHED INSTANCE,
    // so the scroll can only succeed if the hook reads the ref Screen filled.
    const scrollTo = jest.fn();
    Object.assign(attached as object, { scrollTo, getInnerViewNode: () => HOST });
    refs.anchorRef.current = anchorAt(640);

    screen.rerender(ui("Falta la fecha."));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: 640 - SPACE.lg, animated: true });
  });
});
